/**
 * Glob 工具示例
 * 使用 `rg --files --glob` 实现的文件名模式检索工具。
 *
 * 设计要点：
 * - 不要手写 glob-to-regex 作为主实现——直接用 rg 的 --files --glob，
 *   语义与 .gitignore 兼容、性能可靠
 * - 与 Grep 工具共享 runProcess → runRipgrep 执行流
 * - 输出路径规范化为 workspace 相对路径
 * - 结果按 mtime 降序排序——最近修改的文件更可能是相关文件
 */

import { InternalTool, ToolResult } from './tool-definition';
import { runRipgrep } from './rg-runner';
import { stat } from 'node:fs/promises';
import { relative, resolve, isAbsolute } from 'node:path';

const DEFAULT_MAX_RESULTS = 100;

async function globHandler(args: Record<string, unknown>): Promise<ToolResult> {
  const pattern = args.pattern as string;
  const path = (args.path as string) || '.';
  const maxResults = (args.maxResults as number) || DEFAULT_MAX_RESULTS;
  const cwd = process.cwd();

  // 固定参数组装：rg --files --glob <pattern> --color never <path>
  // path 是搜索根目录；pattern 由 ripgrep 相对搜索根解释
  const result = await runRipgrep(
    ['--files', '--glob', pattern, '--color', 'never', path],
    { cwd },
  );

  if (!result.ok) {
    return { success: false, error: result.error ?? 'rg failed' };
  }
  if (!result.hasMatches) {
    return { success: true, data: { files: [], totalFound: 0, truncated: false } };
  }

  const rawPaths = result.stdout.trim().split('\n').filter(Boolean);

  // 按 mtime 降序：最近修改的文件优先展示
  const withMtime = await Promise.all(
    rawPaths.map(async (p) => {
      const abs = isAbsolute(p) ? p : resolve(cwd, p);
      try {
        const s = await stat(abs);
        return { path: abs, mtimeMs: s.mtimeMs };
      } catch {
        return { path: abs, mtimeMs: 0 }; // 文件在 stat 前被删除，沉底
      }
    }),
  );
  withMtime.sort((a, b) => b.mtimeMs - a.mtimeMs);

  // 规范化为 workspace 相对路径
  const files = withMtime.map((f) => relative(cwd, f.path));

  return {
    success: true,
    data: {
      files: files.slice(0, maxResults),
      totalFound: files.length,
      truncated: result.truncated || files.length > maxResults,
    },
  };
}

function renderGlobResult(result: ToolResult): string {
  if (!result.success) return `Error: ${result.error}`;
  const { files, totalFound, truncated } = result.data as any;
  if (files.length === 0) return 'No files found.';
  let output = files.join('\n');
  if (truncated) {
    output += `\n\n[Results capped at ${files.length}. At least ${totalFound} files exist.]`;
  }
  return output;
}

export const GlobTool: InternalTool = {
  name: 'Glob',
  description: `按文件名模式查找文件，返回匹配的文件路径列表（按修改时间排序，最近的在前）。
模式示例："**/*.ts"、"src/components/**"、"*.config.js"。
在文件内容中搜索请使用 Grep 工具。`,
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'glob 模式，如 "**/*.ts"' },
      path: { type: 'string', description: '搜索起始目录，默认当前目录' },
      maxResults: { type: 'string', description: '最大文件数，默认100' },
    },
    required: ['pattern'],
  },
  handler: globHandler,
  renderResult: renderGlobResult,
  category: 'search',
  isReadOnly: true,
};
