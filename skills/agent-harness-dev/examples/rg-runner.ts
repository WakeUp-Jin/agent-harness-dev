/**
 * ripgrep（rg）适配层
 *
 * 在通用 runProcess 之上封装 rg 特有的语义，Grep 和 Glob 工具共享，
 * 不要在每个搜索工具里重复解释退出码。
 *
 * 职责：
 * - 固定调用 rg
 * - 统一解释 rg 退出码：0 有结果、1 无结果（不是错误！）、2 执行错误
 * - 把 "rg 不存在" 转成明确错误
 * - 提供 Grep/Glob 可复用的默认 timeout 和输出上限
 *
 * 不属于它的职责：
 * - 不做 Grep/Glob 的业务参数组装（在各工具的 executor 中）
 */

import { runProcess } from './run-process';

// ─── 类型 ───

export interface RipgrepResult {
  /** rg 是否成功执行（exit 0 或 1 都算成功执行） */
  ok: boolean;
  /** 是否有匹配结果（exit 0） */
  hasMatches: boolean;
  /** 匹配输出（exit 1 时为空字符串） */
  stdout: string;
  /** 执行失败（exit 2 / 启动失败 / 超时）时的错误描述 */
  error?: string;
  /** 输出是否被截断 */
  truncated: boolean;
  durationMs: number;
}

export interface RipgrepOptions {
  cwd: string;
  /** 默认 10 秒——搜索命令不应该跑更久 */
  timeoutMs?: number;
  /** 默认 50_000 字符 */
  maxOutputChars?: number;
  signal?: AbortSignal;
}

const DEFAULT_RG_TIMEOUT_MS = 10_000;
const DEFAULT_RG_MAX_OUTPUT_CHARS = 50_000;

// ─── 实现 ───

export async function runRipgrep(args: string[], options: RipgrepOptions): Promise<RipgrepResult> {
  const result = await runProcess('rg', args, {
    cwd: options.cwd,
    timeoutMs: options.timeoutMs ?? DEFAULT_RG_TIMEOUT_MS,
    maxOutputChars: options.maxOutputChars ?? DEFAULT_RG_MAX_OUTPUT_CHARS,
    signal: options.signal,
  });

  // rg 不存在（ENOENT）→ 明确错误，提示安装
  if (result.startError) {
    const notFound = result.startError.includes('ENOENT');
    return {
      ok: false,
      hasMatches: false,
      stdout: '',
      error: notFound
        ? 'ripgrep (rg) is not installed or not in PATH. Install it: https://github.com/BurntSushi/ripgrep#installation'
        : `Failed to start rg: ${result.startError}`,
      truncated: false,
      durationMs: result.durationMs,
    };
  }

  if (result.timedOut) {
    return {
      ok: false,
      hasMatches: false,
      stdout: result.stdout,
      error: `rg timed out after ${options.timeoutMs ?? DEFAULT_RG_TIMEOUT_MS}ms`,
      truncated: result.truncated,
      durationMs: result.durationMs,
    };
  }

  // rg 退出码语义：0 = 有匹配，1 = 无匹配（成功执行，不是错误），2 = 执行错误
  switch (result.exitCode) {
    case 0:
      return {
        ok: true,
        hasMatches: true,
        stdout: result.stdout,
        truncated: result.truncated,
        durationMs: result.durationMs,
      };
    case 1:
      return {
        ok: true,
        hasMatches: false,
        stdout: '',
        truncated: false,
        durationMs: result.durationMs,
      };
    default:
      return {
        ok: false,
        hasMatches: false,
        stdout: result.stdout,
        error: `rg failed (exit ${result.exitCode}): ${result.stderr.trim() || 'unknown error'}`,
        truncated: result.truncated,
        durationMs: result.durationMs,
      };
  }
}
