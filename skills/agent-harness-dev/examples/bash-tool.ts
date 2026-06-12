/**
 * Bash 工具示例
 * 展示 definition + executor + 多层安全检查 + 大输出流式落盘的完整实现模式。
 *
 * 输出处理核心原则（详见 references/tools/bash-tool.md「输出处理与内存安全」）：
 * - bash 输出大小不可控，绝不能在内存里累加全量字符串（maxBuffer 模式是反面教材）
 * - 边执行边流式写盘，内存只保留有界头部缓冲（headBufferCap）
 * - 小输出（≤ headBufferCap）根本不落盘，零文件残留
 * - 大输出回填给模型：逐字头部 + 截断标记 + 文件路径，模型可用 read_file 翻页读全文
 * - bash 不走 LLM 摘要——全量已落盘、逐字头部比摘要更可信、省延迟成本
 */

import { InternalTool, ToolResult, PermissionResult } from './tool-definition';
import { runProcess } from './run-process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ── 安全检查常量 ──

const CONTROL_CHAR_RE = /[\x00-\x08\x0b-\x1f\x7f]/;
const UNICODE_WHITESPACE_RE = /[\u00a0\u1680\u2000-\u200b\u2028\u2029\u202f\u205f\u3000\ufeff]/;

const EVAL_LIKE_BUILTINS = new Set([
  'eval', 'source', '.', 'exec', 'command', 'builtin', 'fc', 'trap',
]);

const READONLY_COMMANDS = new Set([
  'ls', 'cat', 'head', 'tail', 'wc', 'grep', 'rg', 'find',
  'file', 'stat', 'du', 'df', 'which', 'echo', 'pwd', 'tree',
  'diff', 'sort', 'uniq', 'jq', 'curl',
]);

// ── 权限验证 ──

async function bashCheckPermissions(args: Record<string, unknown>): Promise<PermissionResult> {
  const command = (args.command as string || '').trim();

  if (!command) {
    return { passed: false, error: 'command 不能为空' };
  }
  if (CONTROL_CHAR_RE.test(command)) {
    return { passed: false, error: '命令包含控制字符，拒绝执行' };
  }
  if (UNICODE_WHITESPACE_RE.test(command)) {
    return { passed: false, error: '命令包含 Unicode 空白字符，拒绝执行' };
  }

  // 检查 eval-like 命令
  const firstCmd = command.split(/\s+/)[0];
  if (EVAL_LIKE_BUILTINS.has(firstCmd)) {
    return { passed: false, error: `${firstCmd} 会将参数作为代码执行，拒绝` };
  }

  // 清洗 timeout 参数
  let timeout = args.timeout as number | undefined;
  if (timeout !== undefined) {
    timeout = Math.max(1000, Math.min(timeout, 600000));
  }

  return { passed: true, sanitizedArgs: { ...args, timeout: timeout ?? 120000 } };
}

// ── 执行器 ──

/** 内存头部缓冲上限：执行期内存占用恒定 ≈ 这个值，与输出总量无关 */
const HEAD_BUFFER_CAP = 4000;
/** 磁盘安全阀：防跑飞命令撑爆磁盘，远大于内存阈值 */
const DISK_CAP = 5 * 1024 * 1024;

/**
 * 落盘位置在应用数据目录的临时区，不污染 workspace。
 * 实际项目中用 <userData>/tmp/tool-output/<sessionId>/<turnId>-<toolCallId>-bash.txt，
 * 并由定时清理任务回收。注意：read_file 等读取工具的路径边界不能被 workspace
 * 硬框死，否则模型无法读回该路径。
 */
function buildOutputFilePath(toolCallId: string): string {
  return join(tmpdir(), 'tool-output', `${toolCallId}-bash.txt`);
}

interface BashResultData {
  /** 前 HEAD_BUFFER_CAP 字符（小输出时即全部内容） */
  headBuffer: string;
  /** 实际输出总字节数 */
  totalBytes: number;
  /** 仅当输出溢出头部缓冲、实际落盘时才有值 */
  outputFilePath?: string;
  /** 命中 diskCap，落盘文件本身也不完整 */
  diskTruncated: boolean;
  exitCode: number | null;
}

async function bashHandler(args: Record<string, unknown>): Promise<ToolResult> {
  const command = args.command as string;
  const timeout = (args.timeout as number) ?? 120000;
  const toolCallId = (args.toolCallId as string) ?? `${Date.now()}`;

  // 不用 execFileAsync + maxBuffer：全量输出累加进内存，输出一大就报错或吃光内存。
  // runProcess 的 sink 模式：内存只保留 headBuffer，超出部分懒创建临时文件流式写盘。
  const result = await runProcess('bash', ['-c', command], {
    cwd: process.cwd(),
    timeoutMs: timeout,
    sink: {
      outputFile: buildOutputFilePath(toolCallId),
      headBufferCap: HEAD_BUFFER_CAP,
      diskCap: DISK_CAP,
    },
  });

  if (result.startError) {
    return { success: false, error: `无法启动 bash: ${result.startError}` };
  }
  if (result.timedOut) {
    return { success: false, error: `命令超时（${timeout}ms）` };
  }

  const data: BashResultData = {
    headBuffer: result.headBuffer,
    totalBytes: result.totalBytes,
    outputFilePath: result.outputFilePath,
    diskTruncated: result.truncated,
    exitCode: result.exitCode,
  };
  // 非零退出码也算"执行成功"——退出码本身是模型需要的信息
  return { success: true, data };
}

/**
 * 回填给模型的内容按是否落盘分两种形态：
 * - 未落盘（输出 ≤ headBufferCap）：inline 全部内容，无截断标记
 * - 已落盘：逐字头部 + 截断标记 + 文件路径。截断标记是硬要求——
 *   必须让模型知道内容不完整以及如何取完整原文，避免误把截断结果当全量
 */
function renderBashResult(result: ToolResult): string {
  if (!result.success) return `Error: ${result.error}`;
  const data = result.data as BashResultData;

  let output = data.headBuffer;

  if (data.outputFilePath) {
    const note = data.diskTruncated
      ? `完整原文超过磁盘上限，文件仅保留前 ${DISK_CAP} 字节`
      : `完整原文见 ${data.outputFilePath}，可用 read_file 读取`;
    output += `\n[输出截断：显示前 ${data.headBuffer.length}/共 ${data.totalBytes} 字符，${note}]`;
  }

  output += `\n[exit code: ${data.exitCode}]`;
  return output.trim();
}

// ── 工具定义 ──

export const BashTool: InternalTool = {
  name: 'Bash',
  description: `执行 bash 命令并返回输出。工作目录跨调用持久化。
避免使用此工具运行 find、grep、cat 命令，应使用专用工具。
始终对含空格路径使用双引号。可指定超时（毫秒，最大10分钟）。`,
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: '要执行的命令' },
      timeout: { type: 'string', description: '超时毫秒数，默认120000，最大600000' },
    },
    required: ['command'],
  },
  handler: bashHandler,
  checkPermissions: bashCheckPermissions,
  renderResult: renderBashResult,
  category: 'system',
  isReadOnly: false,
};
