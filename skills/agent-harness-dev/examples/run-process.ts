/**
 * 通用受控子进程 Runner
 *
 * 所有需要执行外部命令的工具（Bash、Grep、Glob 等）共享这一个 runner，
 * 不要在每个工具里各写一份子进程逻辑。
 *
 * 职责（只覆盖子进程生命周期）：
 * - 使用 spawn，command 和 args 分离，禁止通过 shell 拼接字符串
 * - 统一 timeout、统一收集 stdout/stderr、统一输出上限
 * - 统一记录 exitCode、signal、duration、timedOut、truncated
 * - 返回结构化结果，而不是直接返回字符串
 *
 * 不属于它的职责：
 * - 不解释具体命令的退出码（rg 的 0/1/2 语义在 rg-runner.ts 适配层）
 * - 不负责权限审批（在工具的 checkPermissions 中）
 *
 * 两种输出模式：
 * 1. 内存模式（默认，适合 rg 这类输出可控的命令）：stdout/stderr 收进内存，
 *    超过 maxOutputChars 截断
 * 2. 流式落盘模式（sink，bash 必须用）：内存只保留有界头部缓冲（headBufferCap），
 *    超出部分懒创建临时文件流式写盘，磁盘安全阀 diskCap 防跑飞命令撑爆磁盘。
 *    内存占用恒定 ≈ headBufferCap，与输出总量无关。
 */

import { spawn } from 'node:child_process';
import { createWriteStream, type WriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

// ─── 类型 ───

export interface RunProcessOptions {
  /** 工作目录 */
  cwd: string;
  /** 超时毫秒数，超时后 kill 进程 */
  timeoutMs?: number;
  /** 环境变量（默认继承当前进程） */
  env?: NodeJS.ProcessEnv;
  /** 取消信号 */
  signal?: AbortSignal;

  // ── 内存模式（默认） ──
  /** 内存模式下 stdout+stderr 的总字符上限，超过即截断（默认 100_000） */
  maxOutputChars?: number;

  // ── 流式落盘模式（设置 sink 后启用，bash 工具使用） ──
  sink?: {
    /** 大输出落盘的目标文件路径（懒创建：输出不超过 headBufferCap 就不创建） */
    outputFile: string;
    /** 内存头部缓冲上限（字符），建议 4000 */
    headBufferCap: number;
    /** 磁盘安全阀（字节），超过即停写并标记 truncated，建议 5MB */
    diskCap: number;
  };
}

export interface RunProcessResult {
  command: string;
  args: string[];
  cwd: string;
  /** 进程退出码；启动失败或被信号杀死时为 null */
  exitCode: number | null;
  /** 内存模式：完整（或截断后的）stdout；流式模式：空字符串（内容在 headBuffer / outputFile） */
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  /** 内存模式：命中 maxOutputChars；流式模式：命中 diskCap */
  truncated: boolean;
  /** 进程无法启动时的错误（如命令不存在） */
  startError?: string;

  // ── 流式落盘模式专有字段 ──
  /** 前 headBufferCap 字符（stdout+stderr 合并，按到达顺序） */
  headBuffer: string;
  /** 实际输出总字节数（用于判断是否超阈值） */
  totalBytes: number;
  /** 仅当输出超过 headBufferCap、实际发生落盘时才有值 */
  outputFilePath?: string;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_OUTPUT_CHARS = 100_000;

// ─── 实现 ───

export async function runProcess(
  command: string,
  args: string[],
  options: RunProcessOptions,
): Promise<RunProcessResult> {
  const startedAt = Date.now();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputChars = options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;

  const result: RunProcessResult = {
    command,
    args,
    cwd: options.cwd,
    exitCode: null,
    stdout: '',
    stderr: '',
    durationMs: 0,
    timedOut: false,
    truncated: false,
    headBuffer: '',
    totalBytes: 0,
  };

  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      // command/args 分离 + 不走 shell——杜绝注入；bash 工具需要 shell 语义时
      // 由调用方显式传 command='bash', args=['-c', script]
      child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env ?? process.env,
        shell: false,
        signal: options.signal,
      });
    } catch (err) {
      result.startError = err instanceof Error ? err.message : String(err);
      result.durationMs = Date.now() - startedAt;
      resolve(result);
      return;
    }

    let settled = false;
    let fileStream: WriteStream | null = null;
    let diskBytesWritten = 0;
    let fileStreamReady: Promise<void> = Promise.resolve();

    const timer = setTimeout(() => {
      result.timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    /** 流式落盘：headBuffer 满后懒创建文件，命中 diskCap 后停写 */
    const writeToSink = (chunk: string, sink: NonNullable<RunProcessOptions['sink']>): void => {
      const headRemaining = sink.headBufferCap - result.headBuffer.length;
      if (headRemaining > 0) {
        result.headBuffer += chunk.slice(0, headRemaining);
        chunk = chunk.slice(headRemaining);
      }
      if (chunk.length === 0) return;

      if (result.truncated) return; // 已命中 diskCap，丢弃后续输出（timeout 仍生效）
      if (!fileStream) {
        // 懒创建：只有真正溢出 headBuffer 才创建文件，小输出零文件残留
        result.outputFilePath = sink.outputFile;
        fileStreamReady = mkdir(dirname(sink.outputFile), { recursive: true }).then(() => {
          fileStream = createWriteStream(sink.outputFile, { encoding: 'utf-8' });
          // 文件以 headBuffer 开头，保证落盘文件是完整原文
          fileStream.write(result.headBuffer);
          diskBytesWritten += Buffer.byteLength(result.headBuffer);
        });
      }
      const piece = chunk;
      fileStreamReady = fileStreamReady.then(() => {
        if (result.truncated || !fileStream) return;
        const bytes = Buffer.byteLength(piece);
        if (diskBytesWritten + bytes > sink.diskCap) {
          result.truncated = true; // 磁盘安全阀
          return;
        }
        diskBytesWritten += bytes;
        fileStream.write(piece);
      });
    };

    const handleChunk = (target: 'stdout' | 'stderr', data: Buffer): void => {
      // UTF-8 replacement 解码，避免非法字节抛错
      const text = data.toString('utf-8');
      result.totalBytes += data.byteLength;

      if (options.sink) {
        writeToSink(text, options.sink);
        return;
      }

      // 内存模式：超上限即截断
      const current = result[target];
      if (current.length >= maxOutputChars) {
        result.truncated = true;
        return;
      }
      const remaining = maxOutputChars - current.length;
      if (text.length > remaining) {
        result[target] = current + text.slice(0, remaining);
        result.truncated = true;
      } else {
        result[target] = current + text;
      }
    };

    child.stdout?.on('data', (d: Buffer) => handleChunk('stdout', d));
    child.stderr?.on('data', (d: Buffer) => handleChunk('stderr', d));

    const finish = (exitCode: number | null, startError?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      result.exitCode = exitCode;
      if (startError) result.startError = startError;
      result.durationMs = Date.now() - startedAt;
      // 等待落盘队列排空后再关闭文件
      fileStreamReady.then(() => {
        if (fileStream) {
          fileStream.end(() => resolve(result));
        } else {
          resolve(result);
        }
      });
    };

    child.on('error', (err) => {
      // 命令不存在（ENOENT）等启动失败
      finish(null, err.message);
    });

    child.on('close', (code) => finish(code));
  });
}
