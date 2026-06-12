# LLM 服务层设计

LLM 模块通过工厂模式 + 统一接口解决多模型接入问题。核心设计思想：对上层屏蔽供应商差异，提供一致的调用体验。

**先选型再动手**：不要默认套用重型架构。遵循"If I don't need it, it won't be built"——先用最简单的模式，遇到具体问题再升级。

## 按规模分层路径指引

| 场景 | 推荐模式 | 参考代码 |
|------|---------|---------|
| 1-3 个 OpenAI 兼容 provider（DeepSeek、Kimi、Qwen 等） | interface + OpenAI SDK 直接实现（**默认选这个**） | `examples/llm-openai-sdk-service.ts` |
| 3+ 个同 API 协议 provider | 函数式 API + 按协议注册的 registry | `examples/llm-functional-api.ts` |
| 跨 API 协议（OpenAI + Anthropic + Google） | registry + compat 配置 + 抽象基类（可选） | `examples/llm-service.ts` |

判断依据：大多数供应商都提供 OpenAI 兼容 API，它们之间只是 baseUrl 和 API key 不同——一个实现类即可全部覆盖，不需要每个供应商一个类，更不需要抽象基类。BaseLLMService 的设计假设是"不同 provider 的 API 差异很大"，当所有 provider 都兼容 OpenAI 时，它只会变成纯粹的间接层。

### Interface 模式 vs Abstract Class 模式

| 维度 | Interface 模式 | Abstract Class 模式 |
|------|---------------|-------------------|
| 适用场景 | provider 少、API 格式统一 | provider 多、API 格式差异大 |
| 消息转换 | 共享工具函数（convert 模块） | 基类方法 + 子类覆写 |
| 消费方耦合 | 仅依赖 interface | 依赖 abstract class |
| 推荐触发条件 | <= 3 个同类 provider | > 3 个或跨 API 格式 |

Interface 模式下，公共逻辑（消息转换、错误映射、chunk 处理）提取为独立工具函数模块，各 service 复用——测试更方便，消费方只依赖行为契约。

## 用 OpenAI SDK，不要手写 SSE

对 OpenAI 兼容 provider，直接使用官方 `openai` 包：SDK 已处理 SSE 解析、重试、AbortSignal、超时，`for await` 遍历流即可，代码量比手写减少 70%，错误自动分类为带 status 的 APIError。

服务类的职责是「用 SDK 遍历流式响应，把 chunk 映射为 AssistantMessageEvent」，**不是**自己实现 SSE 解析。

**为什么仍要自己封装服务层？** 要区分两类依赖：
- 不推荐：LangChain、LlamaIndex 等高层框架——引入架构约束，替换底层困难
- 推荐：provider 官方 SDK——只是 HTTP 客户端 + 类型定义

"自己封装"指自己设计接口和事件协议，不是从 fetch 手写一切。

## 四方法接口（铁律）

- `stream()`：流式调用，返回 AssistantMessageEventStream——唯一需要真正实现的方法
- `complete()`：**永远是 `stream().result()` 的语法糖**，不要单独实现非流式逻辑
- `streamSimple()`：对 `stream()` 的 options 映射——把 provider 无关的 SimpleStreamOptions 映射为 provider 特定参数
- `completeSimple()`：`streamSimple().result()` 的语法糖，执行引擎调用的主入口

## 架构三层结构（按需采用）

- **工厂函数**：根据 LLMConfig 的 provider 字段创建服务实例，统一解析 api_key / base_url（环境变量或配置文件）。provider 少时一个 switch 即可，不需要 registry
- **服务基类（可选）**：仅跨 API 协议时引入。stream-first 设计，子类实现 `_doStream`，基类提供四个公开方法和默认消息转换
- **具体服务类**：处理 SDK 客户端初始化、chunk 映射、工具格式微调、reasoning 等 provider 特定参数

**Registry 模式（V1+）**：供应商增多时，按 **API 协议**注册（如 openai-completions），而非按供应商注册——一个协议实现覆盖所有兼容供应商，供应商差异放进 Model 对象的 `compat` 配置字段，不用代码分支或新建子类。

## 响应格式

`complete()` 直接返回 AssistantMessage：`content`（结构化内容数组）、`usage`、`stopReason`（stop / toolUse / length / error / aborted）、`model` / `provider`。执行引擎通过 `stopReason === 'toolUse'` 判断是否需要执行工具。

`stream()` 返回 AssistantMessageEventStream，产出 text_delta / thinking_delta / tool_call_delta / done / error 事件，`.result()` 等待流完成返回最终消息。

### 「错误在流中」原则

provider 的 stream 实现不 throw，所有错误编码到流中：

- error 事件携带**完整的 AssistantMessage**（stopReason + errorMessage + 已收到的部分内容），而非裸 Error——出错时部分文本 / 部分 tool calls 不丢失
- `aborted`（主动取消）和 `error`（异常）是两种不同的停止原因
- `result()` 不 throw，返回带 error 信息的 AssistantMessage——消费方用 switch-case 处理 stopReason，不需要 try-catch
- AbortSignal 在每个 chunk 之间检查，不是只在最后

## 消息格式转换

内部 Message 带 source/priority 等元数据，API 只接受 role + content。转换分两层：

1. **通用规范化层**（所有 provider 共享）：跳过 error/aborted 的 assistant messages（不完整回复不回放）、**孤儿 tool calls 补齐**（有 tool_calls 但无对应 toolResult 时插入 synthetic result，否则 API 报错）、图片降级、tool call ID 规范化
2. **协议转换层**（每个 API 协议一份）：规范化消息 → 具体 API 格式

防御性处理不是锦上添花——缺了它们，对话一旦被 abort/error 中断，后续所有请求都会被 API 拒绝。

## Mock Provider

开发阶段验证执行循环的关键依赖，必须能产出完整 turn 的事件序列，不是返回固定字符串：

- **Response queue 模式**：`setResponses()` 预设响应序列，每次调用取下一个——第一次返回 toolUse、第二次返回 stop，即可驱动完整 agent loop
- 辅助工厂函数（mockText / mockToolCall / mockError）快速构造测试消息
- 模拟真实流式行为：文本拆成多个 delta 发出，可选模拟延迟和 usage
- 走和真实 provider 相同的工厂/注册路径，保证调用链路一致

## 推荐目录结构

```
llm/
  types.ts           # LLMConfig, StreamOptions, APIMessage 等
  convert.ts         # 共享消息转换 + 防御性处理 + 错误映射
  factory.ts         # createLLMService() 工厂函数
  registry.ts        # ProviderRegistry（V1+，按需）
  services/          # 具体 provider 实现
    openai.ts        # OpenAI 兼容实现（覆盖 DeepSeek/Kimi/Qwen 等）
    mock.ts          # MockLLMService（response queue）
```

`services/` 子目录让基础设施和具体实现分离，新增 provider 只在 `services/` 下加文件。

## 辅助能力

- **重试**：优先用 OpenAI SDK 自带的 maxRetries（指数退避）
- **Token 统计**：每次调用后累计，为上下文压缩触发提供数据，必须准确
- **错误分类**：区分可重试（限流、超时、5xx）和不可重试（参数、认证、余额），用 SDK 的 APIError.status 映射，逻辑放共享 convert 模块

参考代码: `examples/llm-openai-sdk-service.ts`（默认路径完整实现）、`examples/llm-service.ts`（类型系统 + 两种模式）、`examples/llm-functional-api.ts`（函数式 + registry）、`examples/llm-factory.ts`（工厂）

## 注意事项

- 不同模型对工具调用支持程度不同——parallel tool calls、tool 数量限制，服务类需处理差异
- OpenAI 的 parallel tool calls 在流中交错到达，tool_call 累积必须按 index 追踪
- api_key 不硬编码，通过环境变量或配置注入，工厂函数统一解析
