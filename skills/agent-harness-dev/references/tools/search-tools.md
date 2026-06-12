# Grep 与 Glob 检索工具

Grep 和 Glob 是 Agent 理解代码库的基础能力。它们替代了 Bash 中的 find/grep 命令，提供更安全、输出更可控的文件检索。

## 为什么需要专用检索工具

如果让 Agent 通过 Bash 执行 `grep -r "pattern" .`，会产生两个问题：
1. 输出可能巨大（成千上万行匹配结果），直接撑爆上下文
2. Bash 工具的安全检查不适用于检索场景，增加不必要的权限审批

专用检索工具可以在 executor 层面控制输出量、格式化结果、并标记为只读（跳过审批）。

## 共享执行流：分层架构

Grep 和 Glob 底层都调用 ripgrep（rg）子进程，**不要在每个工具里各写一份子进程逻辑**。推荐三层分工：

```
runProcess（通用受控子进程 runner）
    ↓
runRipgrep（rg 命令适配层）
    ↓
Grep / Glob（各自组装业务参数）
```

### 第一层：通用受控子进程 runner（runProcess）

职责只覆盖子进程生命周期，未来也可服务 Bash 工具：

- 使用 `execFile` 或 `spawn`，**禁止通过 shell 拼接字符串**——command 和 args 分离，runner 不接收完整命令字符串
- 统一设置 timeout
- 统一收集 stdout/stderr（UTF-8 replacement 解码，避免非法字节抛错）
- 统一执行 max output chars 限制
- 统一记录 exitCode、signal、duration、timedOut、truncated
- 返回结构化结果，而不是直接返回字符串
- 不解释具体命令的退出码，不负责权限审批

返回结构示例见 `examples/run-process.ts` 的 `RunProcessResult`。

### 第二层：rg adapter（runRipgrep）

在通用 runner 之上封装 rg 特有语义：

- 固定调用 `rg`
- **统一解释 rg 退出码：`0` 有结果、`1` 无结果（成功执行，不是错误！）、`2` 执行错误**——这是最容易写错的地方，exit 1 必须返回成功但无匹配
- 把「rg 不存在」（ENOENT）转成明确错误，提示安装
- 提供 Grep/Glob 可复用的默认 timeout（建议 10 秒）和输出上限
- 不做 Grep/Glob 的业务参数组装

参考代码：`examples/rg-runner.ts`

## Grep 工具设计

功能：在文件内容中搜索匹配正则表达式的行。

固定参数组装：

```txt
rg --line-number --no-heading --color never --max-count <n> [--glob <include>] [--context <n>] -- <pattern> <path>
```

三个参数的语义边界（容易混淆）：
- `pattern`：正则内容搜索模式
- `path`：文件或目录搜索范围
- `glob`/`include`：文件名过滤，**不替代 `path`**

关键参数设计：
- `pattern`：正则表达式模式
- `path`：搜索的目录或文件路径
- `glob`：文件名过滤（如 `*.ts`）
- `include_context`：匹配行前后的上下文行数
- `max_results`：最大返回结果数（输出量控制的关键）

输出格式设计：
- 给模型的输出保留 `file:line:content` 格式——行号是后续 Read/Edit 工具精确操作的基础
- 超过 max_results 时截断并告知总匹配数
- pattern 用 `--` 与 flag 分隔，防止以 `-` 开头的模式被误解析为 flag

## Glob 工具设计

功能：按文件名模式查找文件路径。

固定参数组装：

```txt
rg --files --glob <pattern> --color never <path>
```

设计要点：
- `path` 是搜索根目录，`pattern` 由 ripgrep 相对搜索根解释
- **不要手写 glob-to-regex 作为主实现**——直接用 `rg --files --glob`，语义与 .gitignore 兼容、性能可靠
- 输出路径规范化为 workspace 相对路径
- 结果按 mtime 降序排序（最近修改的在前，更可能是相关文件）
- 超过限制时截断并告知总数

## description 编写

检索工具的 description 需要明确使用场景的边界：
- Grep 适合"在文件内容中搜索特定字符串或模式"
- Glob 适合"按文件名模式查找文件"
- 两者的边界要清晰，互相在 description 中指向对方，避免 LLM 混用

## 共同的设计原则

- 标记为 `is_read_only = true`，跳过权限审批流程
- 输出结果有上限保护（maxOutputChars + max_results 双层），防止大仓库检索结果撑爆上下文
- 子进程有超时保护（建议 10 秒）——大型 monorepo 中的全局搜索可能很慢
- 自动忽略 .gitignore 中的文件、node_modules、.git 目录等
- 结果格式化对 LLM 友好：包含足够的路径和行号信息，让 LLM 能精确定位

参考代码: `examples/grep-tool.ts`、`examples/glob-tool.ts`、`examples/rg-runner.ts`、`examples/run-process.ts`

## 注意事项

- **rg exit code 1 是「无匹配」不是「错误」**——返回成功 + 空结果，否则模型会把正常的"没搜到"当成工具故障反复重试
- max_results 的默认值很重要——设太大会产生巨量输出，设太小会漏掉关键信息。建议 Grep 默认 50-100 个匹配，Glob 默认 100-200 个文件
- 结果中的行号信息是后续 Read/Edit 工具精确操作的基础，不能省略
- stderr 不要丢弃——exit 2 时 stderr 是定位 rg 参数错误的唯一线索，应包含在错误信息中
