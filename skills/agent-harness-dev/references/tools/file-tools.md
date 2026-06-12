# Read/Write/Edit 文件操作工具

文件操作是 Agent 修改代码的核心能力。三个工具各有职责：Read 读取文件内容，Write 创建或覆写文件，Edit 精确替换文件中的片段。

## Read 工具

功能：读取指定文件的内容，支持行号范围限制。

关键参数：
- `path`：文件绝对路径
- `offset`：起始行号（可选）
- `limit`：读取行数（可选）

设计要点：
- 输出带行号前缀（`LINE_NUMBER|CONTENT`），为后续 Edit 操作提供精确定位
- 大文件保护：超过阈值行数时强制截断，返回提示让 Agent 使用 offset/limit 分段读取
- 标记为只读工具，跳过审批
- 读取成功后调用 `FileReadTracker.recordRead()`，为后续 Edit/Write 的 TOCTOU 防护提供基线
- **路径边界不要被 workspace 硬框死**——bash 等工具的大输出落盘在应用数据目录，模型需要能读回这些路径（见 `references/tools/bash-tool.md`）

## Write 工具

功能：将内容写入指定路径的文件。如果文件已存在则覆写，不存在则创建（含父目录）。

关键参数：
- `path`：文件绝对路径
- `content`：要写入的完整文件内容

设计要点：
- 原子写入：先写临时文件，成功后 rename 到目标路径。防止写入中断导致文件损坏
- 自动创建父目录
- 创建/覆写判断：读取旧内容（读不到即新建），新建文件的 diff 与空字符串对比、覆写与旧内容对比
- 非只读工具，需要权限审批（见下文「权限设计」）

## Edit 工具

功能：在文件中进行精确的字符串替换。找到 old_string，替换为 new_string。

关键参数：
- `path`：文件路径
- `old_string`：要被替换的精确文本
- `new_string`：替换后的文本

设计要点：
- old_string 必须在文件中唯一匹配，否则报错要求提供更多上下文
- 保持文件其余部分完全不变
- 支持 `replace_all` 选项用于全局替换（如变量重命名）
- 非只读工具，需要权限审批

### 弯引号规范化

LLM 经常生成弯引号（smart quotes：' ' " "）和不间断空格（\u00a0），而文件里实际是直引号和普通空格，导致精确匹配失败。Edit 工具应在匹配前做规范化：

1. 先尝试精确匹配
2. 失败后将 old_string 和文件内容都做弯引号→直引号规范化，在规范化空间中定位，再映射回原文片段进行替换

这一步可显著降低 Edit 匹配失败率。实现见 `examples/edit-tool.ts` 的 `normalizeQuotes()` / `findMatch()`。

## diff 生成与 renderResult

edit/write 工具必须生成 diff 供模型和前端使用，**不要手动拼接 diff 字符串**：

- 使用 `diff` npm 库（包名就叫 `diff`）的 `createTwoFilesPatch()` 生成标准 unified diff，包含上下文行、行号、hunk header
- Edit：对比替换前后内容，生成红+绿 diff
- Write：对比旧文件内容（新建时为空字符串）和新内容
- diff 文本通过 `renderResult` 传递，**同时服务两个消费方**：
  - 模型：读 diff 理解变更是否符合预期
  - 前端：解析 diff 渲染卡片（红删绿增）。edit 和 write 可复用同一个 diff 展示组件，通过 `kind: "edit_diff"` vs `kind: "write_diff"` 区分标题文案

## 权限设计（checkPermissions）

「非只读工具，需要权限审批」的具体实现模式：

- **workspace boundary 检查 + 路径清洗**：统一解析为绝对路径（防 `../` 逃逸），检查是否在 workspace 内
- **默认策略 allow**：当前主流 Agent 对 workspace 内的文件写入默认放行，由 git 兜底回滚
- **AgentMode 扩展点**：在 `checkPermissions` 中预留 mode 参数。未来引入 "careful" mode 时只需在此返回 `ask`，即可接入 ToolScheduler 已有的 `awaiting_approval` 流程（见 `references/tools/tool-scheduling.md`），不需要改调度器

## 共享基础设施

### 文件读取追踪器（FileReadTracker）—— TOCTOU 防护

记录 Agent 读取过的文件及其**内容哈希**，防止 Agent 基于过时内容覆盖外部修改（用户手动编辑、其他进程改写）：

1. Read 工具读取成功后 `recordRead(path, content)` 记录哈希
2. Edit/Write 写入前 `isUnchanged(path, currentContent)` 校验——哈希不一致说明文件在读取后被外部修改，拒绝写入并提示重新 Read
3. 写入成功后 `recordWrite(path, newContent)` 更新追踪状态

实现见 `examples/edit-tool.ts` 的 `FileReadTracker`。

### 原子写入（file_write_atomic）

Write 和 Edit 工具共用的底层写入逻辑：
1. 写入 `{target}.tmp` 临时文件（**必须与目标同目录**——rename 跨文件系统不是原子操作）
2. 调用 fsync 确保数据落盘（而不是停留在 OS 写缓存）
3. rename 临时文件为目标文件（原子操作）

容易遗漏的细节：
- 覆写已有文件时保留原权限位：`stat().mode` → `chmod(tmp)`
- 原子写入失败时回退到直接写入（某些文件系统不支持 rename 语义）
- 无论成功失败都清理残留临时文件

这确保在任何时刻断电或崩溃，文件要么是旧内容、要么是新内容，不会出现半写状态。实现见 `examples/file-write-atomic.ts`。

## description 编写

- Read 的 description 需要说明支持行号范围读取，鼓励 Agent 先读取关键片段而非整个大文件
- Edit 的 description 需要强调 old_string 必须唯一，引导 Agent 提供足够的上下文行，且编辑前先 Read
- Write 的 description 需要说明"会覆写整个文件"，引导 Agent 优先使用 Edit 进行局部修改

参考代码: `examples/edit-tool.ts`（Edit 完整实现 + FileReadTracker + 弯引号规范化）、`examples/write-tool.ts`（Write 完整实现）、`examples/file-write-atomic.ts`（原子写入）、`examples/tool-definition.ts`（通用工具定义模式）

## 注意事项

- Edit 工具的 old_string 匹配失败是最常见的错误。原因通常是 Agent 记忆中的代码和文件实际内容有出入（上下文过时）。解决方案：Edit 前先 Read 确认当前内容；弯引号规范化处理 LLM 生成的 smart quotes
- Write 工具会覆写整个文件——如果 Agent 只想改几行但用了 Write，会导致文件其余部分被它"记忆中的版本"覆盖。description 中必须强调这一点
- 大文件（>1000 行）不要一次性读取完毕注入上下文，使用 offset/limit 分段读取
