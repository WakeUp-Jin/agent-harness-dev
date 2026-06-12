/**
 * Grep 工具示例
 * 使用 ripgrep 实现的文件内容检索工具，输出量可控。
 *
 * 与 Glob 工具（examples/glob-tool.ts）共享同一套执行流：
 * runProcess（通用子进程生命周期）→ runRipgrep（rg 退出码语义）→ 各工具组装参数。
 * 不要在每个搜索工具里各写一份子进程逻辑。
 */

import { InternalTool, ToolResult } from './tool-definition';
import { runRipgrep } from './rg-runner';

const DEFAULT_MAX_RESULTS = 50;
const IGNORE_DIRS = ['node_modules', '.git', 'dist', '__pycache__', '.venv'];

async function grepHandler(args: Record<string, unknown>): Promise<ToolResult> {
  const pattern = args.pattern as string;
  const path = (args.path as string) || '.';
  const glob = args.glob as string | undefined;
  const maxResults = (args.maxResults as number) || DEFAULT_MAX_RESULTS;
  const contextLines = (args.contextLines as number) || 0;

  // 固定参数组装：
  // rg --line-number --no-heading --color never --max-count <n> [--glob <include>] [--context <n>] -- <pattern> <path>
  // pattern 是正则内容搜索模式；path 是搜索范围；glob 是文件名过滤，不替代 path
  const rgArgs = [
    '--line-number',
    '--no-heading',
    '--color', 'never',
    `--max-count=${maxResults}`,
  ];

  for (const dir of IGNORE_DIRS) {
    rgArgs.push('--glob', `!${dir}`);
  }
  if (glob) {
    rgArgs.push('--glob', glob);
  }
  if (contextLines > 0) {
    rgArgs.push('--context', String(contextLines));
  }

  // `--` 之后的内容不再被解释为 flag，防止 pattern 以 `-` 开头时被误解析
  rgArgs.push('--', pattern, path);

  const result = await runRipgrep(rgArgs, { cwd: process.cwd() });

  // rg exit 1（无匹配）由 adapter 转为 ok + hasMatches=false——是成功执行，不是错误
  if (!result.ok) {
    return { success: false, error: result.error ?? 'rg failed' };
  }
  if (!result.hasMatches) {
    return { success: true, data: { matches: [], totalFound: 0, truncated: false } };
  }

  const lines = result.stdout.trim().split('\n').filter(Boolean);
  return {
    success: true,
    data: {
      matches: lines.slice(0, maxResults),
      totalFound: lines.length,
      truncated: result.truncated || lines.length >= maxResults,
    },
  };
}

function renderGrepResult(result: ToolResult): string {
  if (!result.success) return `Error: ${result.error}`;
  const { matches, totalFound, truncated } = result.data as any;
  if (matches.length === 0) return 'No matches found.';
  // 保留 file:line:content 格式——行号是后续 Read/Edit 精确操作的基础
  let output = matches.join('\n');
  if (truncated) {
    output += `\n\n[Results capped at ${matches.length}. At least ${totalFound} matches exist.]`;
  }
  return output;
}

export const GrepTool: InternalTool = {
  name: 'Grep',
  description: `在文件内容中搜索匹配正则表达式的行。
使用 ripgrep 实现，自动忽略 .gitignore 文件。
适合在代码库中搜索特定字符串、函数名、导入语句等。
按文件名模式查找文件请使用 Glob 工具。`,
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: '正则表达式搜索模式' },
      path: { type: 'string', description: '搜索路径（文件或目录），默认当前目录' },
      glob: { type: 'string', description: '文件名过滤，如 "*.ts"' },
      maxResults: { type: 'string', description: '最大结果数，默认50' },
      contextLines: { type: 'string', description: '匹配行前后的上下文行数' },
    },
    required: ['pattern'],
  },
  handler: grepHandler,
  renderResult: renderGrepResult,
  category: 'search',
  isReadOnly: true,
};
