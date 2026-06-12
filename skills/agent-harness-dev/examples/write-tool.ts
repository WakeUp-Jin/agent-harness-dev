/**
 * Write 工具示例（definition + executor + permissions + renderResult 完整实现）
 *
 * 展示的关键模式：
 * - 创建/覆写判断：新建文件 diff 基于空字符串，覆写基于旧内容
 * - diff 生成：与 Edit 工具共用 `diff` 库的 createTwoFilesPatch()，
 *   前端可复用同一个 FileDiffBlock 组件（通过 kind: "write_diff" 区分标题文案）
 * - 原子写入：复用 examples/file-write-atomic.ts（tmpfile → fsync → rename）
 * - 权限：workspace boundary 检查，默认 allow，预留 AgentMode 扩展点
 * - TOCTOU 防护：覆写前校验文件在读取后未被外部修改
 *
 * 依赖：npm install diff
 */

import { InternalTool, ToolResult, PermissionResult } from './tool-definition';
import { writeFileAtomic } from './file-write-atomic';
import { fileReadTracker, type AgentMode } from './edit-tool';
import { readFile } from 'node:fs/promises';
import { resolve, isAbsolute } from 'node:path';
import { createTwoFilesPatch } from 'diff';

// ── permissions ──

async function writeCheckPermissions(
  args: Record<string, unknown>,
  workspaceRoot: string = process.cwd(),
  mode: AgentMode = 'default',
): Promise<PermissionResult> {
  const rawPath = (args.path as string || '').trim();
  if (!rawPath) {
    return { passed: false, error: 'path 不能为空' };
  }
  if (typeof args.content !== 'string') {
    return { passed: false, error: 'content 必须是字符串' };
  }

  const absPath = isAbsolute(rawPath) ? resolve(rawPath) : resolve(workspaceRoot, rawPath);
  if (!absPath.startsWith(resolve(workspaceRoot))) {
    return { passed: false, error: `路径超出 workspace 边界: ${absPath}` };
  }

  // 默认 allow；future "careful" mode 在此返回 ask，接入 awaiting_approval 流程
  void mode;

  return { passed: true, sanitizedArgs: { ...args, path: absPath } };
}

// ── executor ──

interface WriteResultData {
  path: string;
  /** "created" 新建 | "overwritten" 覆写 */
  action: 'created' | 'overwritten';
  diff: string;
  bytesWritten: number;
}

async function writeHandler(args: Record<string, unknown>): Promise<ToolResult> {
  const path = args.path as string;
  const content = args.content as string;

  // 创建/覆写判断：读取旧内容，读不到即新建
  let oldContent: string | null = null;
  try {
    oldContent = await readFile(path, 'utf-8');
  } catch {
    oldContent = null;
  }

  // TOCTOU 防护：覆写场景下，文件在 Agent 读取后被外部修改时拒绝写入
  if (oldContent !== null && fileReadTracker.hasRead(path) && !fileReadTracker.isUnchanged(path, oldContent)) {
    return {
      success: false,
      error: '文件在读取后已被外部修改，请重新 Read 后再 Write',
    };
  }

  await writeFileAtomic(path, content);
  fileReadTracker.recordWrite(path, content);

  // 新建文件：与空字符串对比生成全绿 diff；覆写：与旧内容对比生成红+绿 diff
  const diff = createTwoFilesPatch(path, path, oldContent ?? '', content, undefined, undefined, {
    context: 3,
  });

  const data: WriteResultData = {
    path,
    action: oldContent === null ? 'created' : 'overwritten',
    diff,
    bytesWritten: Buffer.byteLength(content, 'utf-8'),
  };
  return { success: true, data };
}

/** diff 文本同时服务模型（理解变更）和前端（渲染 diff 卡片） */
function renderWriteResult(result: ToolResult): string {
  if (!result.success) return `Error: ${result.error}`;
  const { path, action, diff, bytesWritten } = result.data as WriteResultData;
  const verb = action === 'created' ? 'Created' : 'Overwrote';
  return `${verb} ${path} (${bytesWritten} bytes):\n\n${diff}`;
}

// ── definition ──

export const WriteTool: InternalTool = {
  name: 'Write',
  description: `将内容写入指定路径的文件。文件已存在则覆写整个文件，不存在则创建（含父目录）。
注意：会覆写整个文件——只想修改文件中的部分内容时，优先使用 Edit 工具做局部替换。
覆写已有文件前必须先用 Read 工具读取，避免基于过时记忆覆盖文件。`,
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件绝对路径' },
      content: { type: 'string', description: '要写入的完整文件内容' },
    },
    required: ['path', 'content'],
  },
  handler: writeHandler,
  checkPermissions: writeCheckPermissions,
  renderResult: renderWriteResult,
  category: 'file',
  isReadOnly: false,
};
