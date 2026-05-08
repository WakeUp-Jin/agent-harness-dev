# LLM 服务层设计

LLM 模块通过工厂模式 + 统一接口解决多模型接入问题。核心设计思想：对上层屏蔽供应商差异，提供一致的调用体验。

## 架构三层结构

### 第一层：工厂函数（Factory）

根据配置参数创建对应的 LLM 服务实例。

工厂函数接收 LLMConfig（包含 provider、api_key、base_url、model、temperature 等），根据 provider 字段映射到具体的服务类。在创建前自动解析 api_key 和 base_url（可从环境变量或配置文件中提取）。

### 第二层：服务基类（BaseLLMService）

定义统一的接口契约，所有具体服务类都实现这些方法：

- `complete(messages, tools)`：核心方法——接收上下文消息和工具定义，返回 LLM 响应。这是执行引擎调用的主入口
- `chat(message)`：简单对话方法，不涉及工具调用。适用于内部辅助任务（摘要、分类等）
- `generate(prompt)`：直接生成，绕过对话上下文。适用于独立的文本生成任务

### 第三层：具体服务类

每个 LLM 提供商一个实现类（OpenAIService、ClaudeService、DeepSeekService 等）。每个服务类处理该提供商特有的：
- SDK 客户端初始化
- 消息格式转换（内部格式 → 提供商 API 格式）
- 工具定义格式转换（统一 schema → 提供商专属格式）
- 响应解析（提供商返回格式 → 内部统一的 LLMResponse）
- 错误处理和重试策略

## Registry 模式

当供应商数量增多时，使用 Registry 解耦工厂函数和具体服务类：

- 每个服务类在模块加载时注册自己到全局 Registry
- 工厂函数通过 Registry 查找对应的服务类
- 新增供应商只需实现服务类并注册，无需修改工厂函数

## 统一响应格式（LLMResponse）

所有服务类返回统一的 LLMResponse 结构：
- `text`：纯文本响应内容
- `tool_calls`：工具调用列表（name + arguments）
- `usage`：Token 使用统计（prompt_tokens + completion_tokens）
- `thinking`：推理过程文本（如有）

执行引擎通过检查 `tool_calls` 是否为空来判断 LLM 是"最终回复"还是"请求工具调用"。

## 关键设计决策

**为什么自己封装而非用 LangChain/LlamaIndex？**

自定义封装的优势：
- 轻量级，只包含必要功能
- 与系统其他组件（上下文管理、工具调度）无缝集成
- 可添加定制功能（重试、压缩、直接生成模式）
- 避免供应商锁定，替换底层更容易

**消息格式转换的必要性**

不同供应商的 API 格式差异很大——OpenAI 的 tool_calls 是数组嵌套，Anthropic 的是 content blocks。系统内部使用统一的消息格式，在服务类中做 input/output 双向转换。

## 辅助能力

- **重试机制**：网络波动时自动重试，支持指数退避
- **Token 统计**：每次调用后累计 Token 使用量，为上下文管理提供数据
- **错误分类**：区分可重试错误（网络超时、限流）和不可重试错误（参数错误、余额不足）

参考代码: `examples/llm-factory.ts`、`examples/llm-service.ts`

## 注意事项

- 不同模型对工具调用的支持程度不同——有些不支持 parallel tool calls，有些对 tool 数量有限制。服务类需要处理这些差异
- api_key 不要硬编码，通过环境变量或配置文件注入。工厂函数中做统一的 key 解析
- Token 使用统计是上下文压缩触发的数据来源，必须准确记录
