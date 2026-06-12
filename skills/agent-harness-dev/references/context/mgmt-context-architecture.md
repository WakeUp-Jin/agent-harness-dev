# 上下文系统架构

上下文管理器（ContextManager）是编排者，它协调各子模块构建完整的 Context（LLM 调用的完整输入）。核心设计原则：类型即文档——每种消息角色只包含自己需要的字段，判别联合让 TypeScript 自动收窄类型。

## 类型层次

类型体系分三层，从外到内：

### Context（顶层容器）

LLM 调用的完整输入，包含三个部分：
- `systemPrompt`：系统提示词，独立于消息序列，不混入 messages 数组
- `messages`：对话消息序列（Message 判别联合）
- `tools`：可用工具列表

`getContext()` 返回 Context，而非原始消息数组。系统提示词作为独立字段，消费方不需要从 messages[0] 中猜测哪条是 system message。

### Message（判别联合）

通过 `role` 字段判别的三种消息类型，每种只有自己需要的字段：

**UserMessage**（role: "user"）：用户输入。content 支持简单字符串或结构化内容（文本 + 图片）。

**AssistantMessage**（role: "assistant"）：LLM 回复，是最丰富的消息类型：
- `content`：结构化数组（TextContent / ThinkingContent / ToolCallContent），thinking 不再是独立字段，而是 content 的一部分
- `model` / `provider`：记录生成来源，调试和计费时知道是哪个模型
- `usage`：Token 使用量，带嵌套的 cost 对象按维度计费（input/output/cacheRead/cacheWrite）
- `stopReason`：明确停止原因（stop / toolUse / length / error / aborted）
- `errorMessage`：仅在出错时存在

**ToolResultMessage**（role: "toolResult"）：工具执行结果。通过 toolCallId 关联对应的 ToolCallContent，content 支持文本和图片，isError 标识是否执行失败。

每种消息类型还有两个可选的管理字段：
- `source`：来源标识（"user" / "tool:bash" / "subagent:explorer" 等）
- `priority`：压缩优先级（CRITICAL=4 / HIGH=3 / NORMAL=2 / LOW=1）

这些字段在 LLM 调用时被忽略，但在上下文管理（压缩决策）、持久化（JSONL 存储）、调试时有用。

### Content（内容片段判别联合）

通过 `type` 字段判别的内容类型：
- `TextContent`（type: "text"）：纯文本
- `ThinkingContent`（type: "thinking"）：模型推理链，带 signature 用于多轮对话回传
- `ImageContent`（type: "image"）：Base64 图片
- `ToolCallContent`（type: "toolCall"）：工具调用，带 id/name/arguments

## 与旧设计的区别

旧设计用单一 `ContextItem` class 承载所有角色，每个 item 都有 toolCalls、usage、thinking 等字段——大部分对大部分角色无意义。新设计每种角色只定义自己需要的字段：user 消息没有 usage，tool 结果没有 thinking，AssistantMessage 才有完整的 model/provider/usage/stopReason。

旧设计中 `content` 是 `string | null`，无法表示混合内容。新设计 content 是结构化数组，文本、推理链、工具调用、图片各归其位。

旧设计 `getContext()` 返回 `Message[]`，system prompt 混在第一条消息里。新设计返回 `Context`，systemPrompt 是独立字段。

## 模块接口约定

每个上下文模块实现 `format()` 方法返回 ContextParts：

- **SystemPromptContext**：返回 systemParts（核心指令 + 动态注册的 segment）
- **LongTermMemoryContext**：返回 systemParts（用户记忆/偏好，注入到 systemPrompt）
- **ShortTermMemoryContext**：返回 systemParts（压缩摘要）+ messages（对话历史）

模块之间不直接依赖，通过 ContextManager 协调。新增模块（如 RAG 模块、相关文档模块）只需实现 `format()` 接口即可接入。

## 推荐目录结构

编排器（manager）和被编排的模块用 `modules/` 子目录分离，新增模块只需在 `modules/` 下加文件并实现 `ContextModule` 接口：

```
context/
  types.ts                    # SystemPart, ContextParts, ContextModule, CompressionConfig
  manager.ts                  # ContextManager 编排器
  token-estimator.ts          # Token 估算工具函数（V1）
  modules/                    # 各类上下文模块
    system-prompt.ts          # SystemPromptContext（分段式系统提示词）
    conversation.ts           # ConversationContext（V0 极简会话历史）
    short-term-memory.ts      # ShortTermMemoryContext（V1 带持久化的会话历史，替换 conversation）
    long-term-memory.ts       # LongTermMemoryContext（V1 用户画像/偏好）
  index.ts                    # 统一导出
```

与 `references/architecture.md` 的 V0/V1 目录结构保持一致。

## 上下文组装流程

ContextManager 直接持有 `context: Context` 对象。`appendMessage()` 直接操作 `context.messages`，`getContext()` 刷新 systemPrompt 后返回持有的 context 引用：

1. 调用各模块的 format() 收集 systemParts
2. 所有 systemParts 通过 `render()` 渲染为 XML 标签文本，拼接为 context.systemPrompt
3. 返回 context（messages 已在 appendMessage 时直接写入）

调用方在 Context 上附加 tools 后传入 LLM 服务。LLM 服务内部通过 `convertMessages()` 将 Message[] 转为 OpenAI 兼容的 API 格式（丢弃 source/priority/timestamp 等内部元数据），再执行流式补全。`complete()` / `completeSimple()` 等非流式方法是流式方法的 wrapper，直接返回 AssistantMessage。

参考代码: `examples/context-manager.ts`、`examples/llm-service.ts`

## 注意事项

- 模块之间不应直接依赖，通过 ContextManager 协调
- 系统提示词的 segment 优先级设计很关键——当窗口紧张时，哪些身份信息可以丢弃、哪些必须保留
- LLM 服务的 complete/completeSimple 直接返回 AssistantMessage（含 usage/stopReason），调用方直接 appendMessage 即可
- `convertMessages()` 默认实现 OpenAI 兼容格式转换；非 OpenAI 兼容 provider（如 Anthropic）需要各自的协议转换层，见 `references/llm/llm-service.md` 的「消息格式转换」
- ThinkingContent 的 signature 字段在多轮对话中必须回传，否则部分 API 会返回 400 错误
