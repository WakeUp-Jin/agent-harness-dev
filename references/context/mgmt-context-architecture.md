# 上下文系统架构

上下文管理器（ContextManager）是编排者，它协调各子模块构建完整的 LLM 输入。核心设计原则：上下文在内部使用富数据结构表示，只有在最终注入 LLM 时才转换为消息格式。

## 内部数据结构

### ContextItem

上下文的内部表示单元。所有消息类型（用户输入、助手回复、工具调用与结果）在系统内部都以 ContextItem 存储和流转，而非直接使用 LLM 的消息格式。

核心字段：
- `role`：消息角色（user / assistant / tool / system）
- `content`：文本内容
- `source`：来源标识（conversation / tool / summary）
- `priority`：优先级（CRITICAL=4 / HIGH=3 / NORMAL=2 / LOW=1），用于压缩时决定保留顺序
- `createdAt`：创建时间戳
- `metadata`：扩展元数据（自定义键值对）
- `toolCalls` / `toolCallId` / `name`：工具调用相关字段
- `thinking`：模型推理链内容（启用 thinking 时必须回传，否则 API 返回 400）
- `usage`：Token 使用量和成本（仅 assistant 消息有值）

### 两种序列化格式

**`toMessage()`** —— LLM API 格式（精简）：只保留 `role`、`content`、`toolCalls`、`toolCallId`、`thinking`，丢弃所有元数据。这是 LLM 能理解的最小格式。

**`toDict()`** —— 持久化格式（完整）：保留所有字段，用于 JSONL 文件存储和会话恢复。

这种分离确保内部可以携带丰富的控制信息（优先级、来源、成本），而 LLM 只看到它需要的内容。

### ContextParts

模块的 `format()` 方法返回 ContextParts，声明内容的投递目标：

- `systemParts`：SystemPart 列表，最终合并为一条 system message
- `messageItems`：ContextItem 列表，作为独立消息放入对话序列

### SystemPart

系统级内容片段，带 XML 标签包裹：

- `tag`：XML 标签名（如 `system_prompt`、`user_instructions`、`memory_summary`）
- `description`：标签的描述属性
- `content`：实际内容文本

`render()` 方法将其渲染为 `<tag description="...">\n内容\n</tag>` 格式。多个 SystemPart 拼接后构成完整的 system message。

## 为什么不能直接用消息数组

消息数组（`[{role: "user", content: "..."}, ...]`）是 LLM API 的序列化格式，不是应用的状态管理结构。直接用消息数组作为后端状态会导致三类问题：

**缺少控制信息**：消息格式没有优先级、来源、时间戳等字段。压缩时无法判断哪些消息更重要，监控时无法追踪 Token 成本，调试时无法定位消息来源。

**工具调用语义丢失**：读取操作（search_products）、写入操作（send_email）、混合操作（reserve_inventory）在消息格式中看起来完全一样。但读取结果可以缓存，写入操作需要幂等性保证，混合操作需要补偿事务。消息格式无法表达这些区别。

**状态漂移**：应用状态（如购物车内容）可能在工具调用后发生变化，但这个变化未反映到消息历史中。Agent 基于过时的消息上下文做出错误决策，而开发者只能通过逐条阅读消息来猜测问题出在哪里。

## 模块接口约定

每个上下文模块继承 BaseContext，实现 `format()` 方法返回 ContextParts：

- **SystemPromptContext**：返回 systemParts（核心指令 + 动态注册的 segment）
- **LongTermMemoryContext**：返回 systemParts（用户记忆/偏好，注入到 system message）
- **ShortTermMemoryContext**：返回 systemParts（压缩摘要）+ messageItems（对话历史）

模块之间不直接依赖，通过 ContextManager 协调。这样方便后续添加新模块（如 RAG 模块、相关文档模块），只需实现 `format()` 接口即可接入。


## 上下文组装流程

ContextManager 的 `getContext()` 方法按顺序执行以下步骤：

1. 调用 SystemPromptContext.format() → systemParts（核心指令，最前面）
2. 调用 LongTermMemoryContext.format() → systemParts（用户画像/偏好）
3. 调用 ShortTermMemoryContext.format() → systemParts（压缩摘要）+ messageItems（对话历史）
4. 所有 systemParts 通过 `render()` 渲染为 XML 标签文本，按段落拼接为一条 system message
5. 所有 messageItems 通过 `toMessage()` 逐个转为 LLM API 消息格式
6. 消息清洗（sanitize）：修复不完整的工具调用对（如有 tool_call 但缺少对应的 tool 响应）
7. 检查总 Token 是否超过阈值，必要时触发压缩

最终输出的结构是 LLM API 可直接消费的 messages 数组。

参考代码: `examples/context-manager.ts`

## 注意事项

- 模块之间不应直接依赖，通过 ContextManager 协调
- 系统提示词的 segment 优先级设计很关键——当窗口紧张时，哪些身份信息可以丢弃、哪些必须保留
- 消息格式化必须处理不同 LLM 提供商的差异（OpenAI / Anthropic / 其他），建议通过提供商专属的格式化方法实现
- ContextItem 的 thinking 字段在 assistant 消息中必须回传，否则启用 thinking 的模型 API 会返回 400 错误
