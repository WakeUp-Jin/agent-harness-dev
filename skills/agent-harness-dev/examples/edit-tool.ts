/**
 * Edit 工具示例（definition + executor + permissions + renderResult 完整实现）
 *
 * 展示的关键模式：
 * - 精确字符串替换：old_string 必须唯一匹配，否则报错要求更多上下文
 * - 弯引号规范化：LLM 经常生成弯引号（smart quotes），匹配前规范化为直引号
 * - diff 生成：使用 `diff` npm 库的 createTwoFilesPatch() 生成标准 unified diff，
 *   通过 renderResult 同时服务模型（理解变更）和前端（展示 diff 卡片）
 * - 原子写入：复用 examples/file-write-atomic.ts
 * - 权限：workspace boundary 检查 + 路径清洗，默认 allow，预留 AgentMode 扩展点
 * - TOCTOU 防护：写入前用 FileReadTracker 校验文件在读取后未被外部修改
 *
 * 依赖：npm install diff
 */

import { InternalTool, ToolResult, PermissionResult } from './tool-definition';
import { writeFileAtomic } from './file-write-atomic';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, isAbsolute } from 'node:path';
import { createTwoFilesPatch } from 'diff';

// ═══════════════════════════════════════════════════
// FileReadTracker：TOCTOU 防护（Edit/Write 共享，实际项目放 shared/）
// ═══════════════════════════════════════════════════

/**
 * 记录 Agent 读取过的文件及其内容哈希。
 * 写入前检查文件是否在读取后被外部修改（用户手动编辑、其他进程改写），
 * 防止 Agent 基于过时内容覆盖掉外部修改。
 */
export class FileReadTracker {
  private hashes = new Map<string, string>();

  private hash(content: string): string {
    return createHash('sha256').update(content).digest('hex');
  }

  /** Read 工具读取成功后调用 */
  recordRead(path: string, content: string): void {
    this.hashes.set(path, this.hash(content));
  }

  /** Edit/Write 工具写入前调用：返回 false 表示文件在读取后被外部修改 */
  isUnchanged(path: string, currentContent: string): boolean {
    const recorded = this.hashes.get(path);
    if (!recorded) return true; // 从未读过（如新建文件），不拦截
    return recorded === this.hash(currentContent);
  }

  /** 是否读取过该文件 */
  hasRead(path: string): boolean {
    return this.hashes.has(path);
  }

  /** 写入成功后更新追踪状态 */
  recordWrite(path: string, newContent: string): void {
    this.hashes.set(path, this.hash(newContent));
  }
}

export const fileReadTracker = new FileReadTracker();

// ═══════════════════════════════════════════════════
// 弯引号规范化
// ═══════════════════════════════════════════════════

/**
 * LLM 经常生成弯引号（smart quotes）和特殊空白。文件里实际是直引号时，
 * 直接匹配会失败。规范化后再匹配可显著降低 Edit 失败率。
 */
export function normalizeQuotes(text: string): string {
  return text
    .replace(/[\u2018\u2019\u201a\u201b]/g, "'") // 弯单引号 → '
    .replace(/[\u201c\u201d\u201e\u201f]/g, '"') // 弯双引号 → "
    .replace(/\u00a0/g, ' '); // 不间断空格 → 普通空格
}

/** 在原文中查找 search 的匹配（先精确，再弯引号规范化后匹配） */
function findMatch(content: string, search: string): { index: number; matched: string } | null {
  // 1. 精确匹配
  const exactIndex = content.indexOf(search);
  if (exactIndex !== -1) return { index: exactIndex, matched: search };

  // 2. 弯引号规范化后匹配：在规范化空间中定位，再映射回原文片段
  const normContent = normalizeQuotes(content);
  const normSearch = normalizeQuotes(search);
  const normIndex = normContent.indexOf(normSearch);
  if (normIndex !== -1) {
    // 规范化是逐字符替换，长度不变，索引可直接复用
    return { index: normIndex, matched: content.slice(normIndex, normIndex + normSearch.length) };
  }
  return null;
}

function countOccurrences(content: string, search: string): number {
  const normContent = normalizeQuotes(content);
  const normSearch = normalizeQuotes(search);
  let count = 0;
  let idx = normContent.indexOf(normSearch);
  while (idx !== -1) {
    count++;
    idx = normContent.indexOf(normSearch, idx + normSearch.length);
  }
  return count;
}

// ═══════════════════════════════════════════════════
// permissions：workspace boundary + 路径清洗 + AgentMode 扩展点
// ═══════════════════════════════════════════════════

/** 未来的 "careful" mode 在这里返回 'ask' 即可接入 ToolScheduler 的 awaiting_approval 流程 */
export type AgentMode = 'default' | 'careful';

async function editCheckPermissions(
  args: Record<string, unknown>,
  workspaceRoot: string = process.cwd(),
  mode: AgentMode = 'default',
): Promise<PermissionResult> {
  const rawPath = (args.path as string || '').trim();
  if (!rawPath) {
    return { passed: false, error: 'path 不能为空' };
  }

  // 路径清洗：统一为绝对路径再做边界检查，防止 ../ 逃逸
  const absPath = isAbsolute(rawPath) ? resolve(rawPath) : resolve(workspaceRoot, rawPath);
  if (!absPath.startsWith(resolve(workspaceRoot))) {
    return { passed: false, error: `路径超出 workspace 边界: ${absPath}` };
  }

  if (!args.old_string) {
    return { passed: false, error: 'old_string 不能为空' };
  }
  if (args.old_string === args.new_string) {
    return { passed: false, error: 'old_string 和 new_string 相同，无需编辑' };
  }

  // 默认策略 allow（当前主流 Agent 的默认行为）；careful mode 切换为 ask，
  // 由 ToolScheduler 的 awaiting_approval 流程接管
  void mode;

  return { passed: true, sanitizedArgs: { ...args, path: absPath } };
}

// ═══════════════════════════════════════════════════
// executor
// ═══════════════════════════════════════════════════

interface EditResultData {
  path: string;
  /** unified diff，renderResult 直接输出，前端也用它渲染 diff 卡片 */
  diff: string;
  replacements: number;
}

async function editHandler(args: Record<string, unknown>): Promise<ToolResult> {
  const path = args.path as string;
  const oldString = args.old_string as string;
  const newString = args.new_string as string;
  const replaceAll = (args.replace_all as boolean) ?? false;

  let content: string;
  try {
    content = await readFile(path, 'utf-8');
  } catch {
    return { success: false, error: `文件不存在或无法读取: ${path}` };
  }

  // TOCTOU 防护：文件在 Agent 读取后被外部修改时拒绝写入
  if (fileReadTracker.hasRead(path) && !fileReadTracker.isUnchanged(path, content)) {
    return {
      success: false,
      error: '文件在读取后已被外部修改，请重新 Read 后再 Edit',
    };
  }

  const occurrences = countOccurrences(content, oldString);
  if (occurrences === 0) {
    return {
      success: false,
      error: 'old_string 在文件中未找到匹配。请先 Read 确认文件当前内容（可能上下文已过时）',
    };
  }
  if (occurrences > 1 && !replaceAll) {
    return {
      success: false,
      error: `old_string 匹配了 ${occurrences} 处。请提供更多上下文使其唯一，或使用 replace_all`,
    };
  }

  let newContent: string;
  if (replaceAll) {
    let working = content;
    let match = findMatch(working, oldString);
    const pieces: string[] = [];
    while (match) {
      pieces.push(working.slice(0, match.index), newString);
      working = working.slice(match.index + match.matched.length);
      match = findMatch(working, oldString);
    }
    pieces.push(working);
    newContent = pieces.join('');
  } else {
    const match = findMatch(content, oldString)!;
    newContent =
      content.slice(0, match.index) + newString + content.slice(match.index + match.matched.length);
  }

  await writeFileAtomic(path, newContent);
  fileReadTracker.recordWrite(path, newContent);

  // 用 diff 库生成标准 unified diff（含上下文行、行号、hunk header），不要手动拼接
  const diff = createTwoFilesPatch(path, path, content, newContent, undefined, undefined, {
    context: 3,
  });

  const data: EditResultData = { path, diff, replacements: replaceAll ? occurrences : 1 };
  return { success: true, data };
}

/**
 * renderResult 输出 diff 文本：
 * - 模型读它理解变更是否符合预期
 * - 前端解析它渲染 diff 卡片（红删绿增）
 */
function renderEditResult(result: ToolResult): string {
  if (!result.success) return `Error: ${result.error}`;
  const { path, diff, replacements } = result.data as EditResultData;
  return `Edited ${path} (${replacements} replacement${replacements > 1 ? 's' : ''}):\n\n${diff}`;
}

// ═══════════════════════════════════════════════════
// definition
// ═══════════════════════════════════════════════════

export const EditTool: InternalTool = {
  name: 'Edit',
  description: `在文件中进行精确的字符串替换：找到 old_string，替换为 new_string。
old_string 必须在文件中唯一匹配——若不唯一请包含更多上下文行，或设置 replace_all 全局替换。
编辑前必须先用 Read 工具读取文件，确保 old_string 与文件当前内容一致。`,
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件绝对路径' },
      old_string: { type: 'string', description: '要被替换的精确文本（含足够上下文使其唯一）' },
      new_string: { type: 'string', description: '替换后的文本' },
      replace_all: { type: 'string', description: '是否替换所有匹配，默认 false' },
    },
    required: ['path', 'old_string', 'new_string'],
  },
  handler: editHandler,
  checkPermissions: editCheckPermissions,
  renderResult: renderEditResult,
  category: 'file',
  isReadOnly: false,
};
