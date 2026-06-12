/**
 * OpenAI SDK 具体 Provider 实现（默认推荐路径）
 *
 * 展示对 OpenAI 兼容 provider（DeepSeek、Kimi、Qwen、Groq、Together 等）的完整实现：
 * - 直接使用官方 `openai` npm 包，不手写 fetch + SSE 解析
 * - LLMService interface 实现（不需要抽象基类）
 * - 流式 chunk 遍历、tool_call 按 index 累积、usage 统计
 * - 「错误在流中」：不 throw，错误编码为 stopReason "error" | "aborted" 的 AssistantMessage
 * - 防御性消息转换：跳过 error/aborted 消息、孤儿 tool calls 补齐
 *
 * 依赖：npm install openai
 * 类型来自 examples/llm-service.ts。
 */

import OpenAI from "openai";
import type {
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  LLMConfig,
  LLMService,
  Message,
  SimpleStreamOptions,
  StopReason,
  StreamOptions,
  TextContent,
  Tool,
  ToolCallContent,
  Usage,
} from "./llm-service";
import { AssistantMessageEventStream, getTextContent, getToolCalls, hasToolCalls } from "./llm-service";

// ═══════════════════════════════════════════════════
// 共享消息转换（实际项目中放在 llm/convert.ts，各 service 复用）
// ═══════════════════════════════════════════════════

type APIMessageParam = OpenAI.Chat.ChatCompletionMessageParam;

/**
 * 将内部 Message[] 转为 OpenAI 兼容的 API 消息格式。
 *
 * 包含两项防御性处理（缺了它们，对话一旦被中断，后续请求都会被 API 拒绝）：
 * 1. 跳过 stopReason === "error" | "aborted" 的 assistant messages——不完整回复不回放给 API
 * 2. 孤儿 tool calls 补齐——assistant 有 tool_calls 但无对应 toolResult 时插入 synthetic result
 */
export function convertMessages(context: Context): APIMessageParam[] {
  const result: APIMessageParam[] = [];

  if (context.systemPrompt) {
    result.push({ role: "system", content: context.systemPrompt });
  }

  // 收集所有 toolResult 的 id，用于孤儿 tool calls 检测
  const answeredToolCallIds = new Set(
    context.messages
      .filter((m): m is Extract<Message, { role: "toolResult" }> => m.role === "toolResult")
      .map((m) => m.toolCallId),
  );

  for (const msg of context.messages) {
    switch (msg.role) {
      case "user":
        result.push({
          role: "user",
          content:
            typeof msg.content === "string"
              ? msg.content
              : msg.content
                  .filter((c): c is TextContent => c.type === "text")
                  .map((c) => c.text)
                  .join(""),
        });
        break;

      case "assistant": {
        // 防御 1：跳过 error/aborted 的不完整回复
        if (msg.stopReason === "error" || msg.stopReason === "aborted") break;

        const toolCalls = getToolCalls(msg);
        result.push({
          role: "assistant",
          content: getTextContent(msg) || null,
          ...(hasToolCalls(msg) && {
            tool_calls: toolCalls.map((tc) => ({
              id: tc.id,
              type: "function" as const,
              function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
            })),
          }),
        });

        // 防御 2：为孤儿 tool calls 插入 synthetic toolResult
        for (const tc of toolCalls) {
          if (!answeredToolCallIds.has(tc.id)) {
            result.push({
              role: "tool",
              tool_call_id: tc.id,
              content: "(tool call was interrupted before a result was produced)",
            });
          }
        }
        break;
      }

      case "toolResult":
        result.push({
          role: "tool",
          tool_call_id: msg.toolCallId,
          content: msg.content
            .filter((c): c is TextContent => c.type === "text")
            .map((c) => c.text)
            .join(""),
        });
        break;
    }
  }

  return result;
}

/** 将内部 Tool 定义转为 OpenAI 工具格式 */
export function toRequestTools(tools?: Tool[]): OpenAI.Chat.ChatCompletionTool[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((t) => ({
    type: "function" as const,
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

/** OpenAI finish_reason → 内部 StopReason */
export function mapStopReason(reason: string | null | undefined): StopReason {
  switch (reason) {
    case "stop":
      return "stop";
    case "length":
      return "length";
    case "tool_calls":
      return "toolUse";
    default:
      return "stop";
  }
}

/** SDK 错误分类：区分可重试（限流/超时/5xx）与不可重试（参数/认证/余额） */
export type LLMErrorKind = "rate_limit" | "timeout" | "server" | "auth" | "invalid_request" | "unknown";

export function mapSdkError(error: unknown): LLMErrorKind {
  if (error instanceof OpenAI.APIError) {
    const status = error.status;
    if (status === 429) return "rate_limit";
    if (status === 401 || status === 403) return "auth";
    if (status === 400 || status === 404 || status === 422) return "invalid_request";
    if (status && status >= 500) return "server";
  }
  if (error instanceof Error && error.name === "APIConnectionTimeoutError") return "timeout";
  return "unknown";
}

// ═══════════════════════════════════════════════════
// 流式 chunk 处理（实际项目中同样放在共享模块，各 service 复用）
// ═══════════════════════════════════════════════════

/** tool_call 累积器：OpenAI 的 parallel tool calls 在流中交错，必须按 index 追踪 */
interface ToolCallAccumulator {
  id: string;
  name: string;
  argumentsJson: string;
}

interface StreamAccumulator {
  text: string;
  thinking: string;
  toolCallsByIndex: Map<number, ToolCallAccumulator>;
  usage: Usage;
}

function createAccumulator(): StreamAccumulator {
  return {
    text: "",
    thinking: "",
    toolCallsByIndex: new Map(),
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}

function buildContent(acc: StreamAccumulator): AssistantMessage["content"] {
  const content: AssistantMessage["content"] = [];
  if (acc.thinking) content.push({ type: "thinking", thinking: acc.thinking });
  if (acc.text) content.push({ type: "text", text: acc.text });
  for (const [, tc] of [...acc.toolCallsByIndex.entries()].sort(([a], [b]) => a - b)) {
    let args: Record<string, unknown> = {};
    try {
      args = tc.argumentsJson ? JSON.parse(tc.argumentsJson) : {};
    } catch {
      // 参数 JSON 不完整（流被中断），保留空参数，stopReason 会标记 error/aborted
    }
    content.push({ type: "toolCall", id: tc.id, name: tc.name, arguments: args } satisfies ToolCallContent);
  }
  return content;
}

// ═══════════════════════════════════════════════════
// 具体 Service：一个类覆盖所有 OpenAI 兼容 provider
// ═══════════════════════════════════════════════════

/**
 * OpenAI 兼容 provider 的统一实现。
 * DeepSeek / Kimi / Qwen / Groq 等只是 baseUrl 与 apiKey 不同，
 * 不需要为每个供应商建一个类——在工厂中传入不同 config 即可。
 */
export class OpenAICompatibleService implements LLMService {
  private client: OpenAI;

  constructor(private config: LLMConfig) {
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseUrl, // 如 https://api.deepseek.com、https://api.moonshot.cn/v1
      maxRetries: config.maxRetries ?? 2, // SDK 自带指数退避重试
    });
  }

  stream(context: Context, options?: StreamOptions): AssistantMessageEventStream {
    const self = this;

    async function* generate(): AsyncGenerator<AssistantMessageEvent> {
      const acc = createAccumulator();
      const startedAt = Date.now();

      const buildMessage = (stopReason: StopReason, errorMessage?: string): AssistantMessage => ({
        role: "assistant",
        content: buildContent(acc),
        model: self.config.model,
        provider: self.config.provider,
        usage: acc.usage,
        stopReason,
        ...(errorMessage && { errorMessage }),
        timestamp: startedAt,
      });

      try {
        // SDK 处理 SSE 解析、重试、超时——不要手写 fetch + SSE
        const sdkStream = await self.client.chat.completions.create(
          {
            model: self.config.model,
            messages: convertMessages(context),
            tools: toRequestTools(context.tools),
            temperature: options?.temperature ?? self.config.temperature,
            max_tokens: options?.maxTokens ?? self.config.maxTokens,
            stream: true,
            stream_options: { include_usage: true },
          },
          { signal: options?.signal },
        );

        let finishReason: string | null = null;

        for await (const chunk of sdkStream) {
          // AbortSignal 检查在每个 chunk 之间，不是只在最后
          if (options?.signal?.aborted) throw new Error("aborted");

          const choice = chunk.choices[0];

          // DeepSeek R1 等模型的推理链在 reasoning_content 扩展字段中
          const reasoningDelta = (choice?.delta as { reasoning_content?: string } | undefined)
            ?.reasoning_content;
          if (reasoningDelta) {
            acc.thinking += reasoningDelta;
            yield { type: "thinking_delta", delta: reasoningDelta };
          }

          if (choice?.delta?.content) {
            acc.text += choice.delta.content;
            yield { type: "text_delta", delta: choice.delta.content };
          }

          if (choice?.delta?.tool_calls) {
            for (const tc of choice.delta.tool_calls) {
              // parallel tool calls 交错到达，按 index 累积
              let entry = acc.toolCallsByIndex.get(tc.index);
              if (!entry) {
                entry = { id: tc.id ?? `call_${tc.index}`, name: "", argumentsJson: "" };
                acc.toolCallsByIndex.set(tc.index, entry);
              }
              if (tc.id) entry.id = tc.id;
              if (tc.function?.name) entry.name += tc.function.name;
              if (tc.function?.arguments) {
                entry.argumentsJson += tc.function.arguments;
                yield { type: "tool_call_delta", index: tc.index, delta: tc.function.arguments };
              }
            }
          }

          if (choice?.finish_reason) finishReason = choice.finish_reason;

          // usage 在最后一个 chunk 中（需 stream_options.include_usage）
          if (chunk.usage) {
            acc.usage.input = chunk.usage.prompt_tokens;
            acc.usage.output = chunk.usage.completion_tokens;
            acc.usage.totalTokens = chunk.usage.total_tokens;
            acc.usage.cacheRead =
              (chunk.usage as { prompt_tokens_details?: { cached_tokens?: number } })
                .prompt_tokens_details?.cached_tokens ?? 0;
          }
        }

        yield { type: "done", message: buildMessage(mapStopReason(finishReason)) };
      } catch (error) {
        // 「错误在流中」：不向上 throw，错误编码为携带部分内容的 AssistantMessage
        const aborted = options?.signal?.aborted;
        const errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
        yield {
          type: "error",
          message: buildMessage(aborted ? "aborted" : "error", errorMessage),
        };
      }
    }

    return new AssistantMessageEventStream(generate());
  }

  /** 铁律：complete 永远是 stream().result() 的语法糖 */
  async complete(context: Context, options?: StreamOptions): Promise<AssistantMessage> {
    return this.stream(context, options).result();
  }

  /** streamSimple 是对 stream 的 options 映射 */
  streamSimple(context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream {
    return this.stream(context, this.resolveSimpleOptions(options));
  }

  async completeSimple(context: Context, options?: SimpleStreamOptions): Promise<AssistantMessage> {
    return this.streamSimple(context, options).result();
  }

  /** 把 provider 无关的 SimpleStreamOptions 映射为具体参数（如 reasoning → temperature 策略） */
  private resolveSimpleOptions(options?: SimpleStreamOptions): StreamOptions {
    if (!options) return {};
    return { signal: options.signal };
  }
}

// ═══════════════════════════════════════════════════
// 工厂用法：一个实现类 + 不同配置覆盖多个供应商
// ═══════════════════════════════════════════════════

export function createLLMService(config: LLMConfig): LLMService {
  switch (config.provider) {
    case "deepseek":
      return new OpenAICompatibleService({ ...config, baseUrl: config.baseUrl ?? "https://api.deepseek.com" });
    case "kimi":
      return new OpenAICompatibleService({ ...config, baseUrl: config.baseUrl ?? "https://api.moonshot.cn/v1" });
    default:
      // 任何 OpenAI 兼容端点都可以直接用
      return new OpenAICompatibleService(config);
  }
}
