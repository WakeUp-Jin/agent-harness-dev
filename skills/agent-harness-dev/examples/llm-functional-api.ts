/**
 * 函数式 API + push-based EventStream + 按协议注册的 Registry（可选路径，源自 pi-ai）
 *
 * 适用场景：3+ 个同 API 协议 provider，或跨 API 协议（OpenAI + Anthropic + Google）。
 * 如果只有 1-3 个 OpenAI 兼容 provider，用 examples/llm-openai-sdk-service.ts 的
 * interface + 具体实现即可，不需要本文件的模式。
 *
 * 核心设计（提取自 pi-ai，7 个生产项目验证）：
 * 1. 公共 API 是 4 个顶层函数（stream/complete/streamSimple/completeSimple），不是类方法
 * 2. provider 是符合 StreamFunction 签名的纯函数，无状态、不持有 this
 * 3. push-based EventStream：stream 函数同步返回流对象，异步逻辑在 IIFE 中执行
 * 4. 按 API 协议注册（"openai-completions"），不按供应商注册——一个协议实现
 *    覆盖 DeepSeek/Groq/Cerebras/OpenRouter 等所有兼容供应商
 * 5. 供应商差异通过 Model.compat 配置对象处理，不用代码分支或子类
 * 6. 错误在流中：stream 函数不 throw，错误编码为 stopReason "error"|"aborted"
 */

import type { AssistantMessage, Context } from "./llm-service";

// ═══════════════════════════════════════════════════
// push-based EventStream
// ═══════════════════════════════════════════════════

/**
 * 与 AsyncGenerator（pull-based）的对比：
 *
 * | 维度       | AsyncGenerator         | push-based EventStream      |
 * |-----------|------------------------|-----------------------------|
 * | 生产者模型  | pull——消费者 next() 驱动 | push——生产者主动推送          |
 * | result()  | 需要完整消费流           | 独立 Promise，不需遍历        |
 * | 同步返回    | 否                     | 是——拿到流时请求可能还没开始    |
 * | 代码复杂度  | 更简单                  | 更复杂但更灵活                |
 */
export class EventStream<T, R = T> implements AsyncIterable<T> {
  private queue: T[] = [];
  private waiting: ((value: IteratorResult<T>) => void)[] = [];
  private done = false;
  private finalResult: R | undefined;
  private resultResolvers: ((value: R) => void)[] = [];

  constructor(
    private isTerminal: (event: T) => boolean,
    private extractResult: (event: T) => R,
  ) {}

  /** 生产者推入事件 */
  push(event: T): void {
    if (this.done) return;
    if (this.isTerminal(event)) {
      this.finalResult = this.extractResult(event);
      for (const resolve of this.resultResolvers) resolve(this.finalResult);
      this.resultResolvers = [];
    }
    const waiter = this.waiting.shift();
    if (waiter) {
      waiter({ value: event, done: false });
    } else {
      this.queue.push(event);
    }
  }

  /** 生产者标记结束 */
  end(): void {
    this.done = true;
    for (const waiter of this.waiting) {
      waiter({ value: undefined as never, done: true });
    }
    this.waiting = [];
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    while (true) {
      if (this.queue.length > 0) {
        yield this.queue.shift()!;
        continue;
      }
      if (this.done) return;
      const next = await new Promise<IteratorResult<T>>((resolve) => this.waiting.push(resolve));
      if (next.done) return;
      yield next.value;
    }
  }

  /** 一步拿到最终结果，不需要遍历流 */
  result(): Promise<R> {
    if (this.finalResult !== undefined) return Promise.resolve(this.finalResult);
    return new Promise((resolve) => this.resultResolvers.push(resolve));
  }
}

/** done / error 事件都携带 AssistantMessage（「错误在流中」原则） */
export type FnAssistantMessageEvent =
  | { type: "text_delta"; delta: string }
  | { type: "thinking_delta"; delta: string }
  | { type: "tool_call_delta"; index: number; delta: string }
  | { type: "done"; message: AssistantMessage }
  | { type: "error"; message: AssistantMessage };

export class FnAssistantMessageEventStream extends EventStream<FnAssistantMessageEvent, AssistantMessage> {
  constructor() {
    super(
      (event) => event.type === "done" || event.type === "error",
      (event) => (event as { message: AssistantMessage }).message,
    );
  }
}

// ═══════════════════════════════════════════════════
// Model 对象：配置 + 能力声明 + 路由信息
// ═══════════════════════════════════════════════════

export type Api = "openai-completions" | "anthropic-messages";

/** 供应商差异用 compat 配置表达，不用代码分支 */
export interface OpenAICompletionsCompat {
  /** 部分兼容端点不支持 store 参数 */
  supportsStore?: boolean;
  /** max_tokens vs max_completion_tokens */
  maxTokensField?: "max_tokens" | "max_completion_tokens";
  /** 推理内容的扩展字段格式（DeepSeek 的 reasoning_content 等） */
  thinkingFormat?: "reasoning_content" | "none";
}

export interface Model<TApi extends Api = Api> {
  id: string; // 模型标识，如 "deepseek-chat"
  name: string; // 显示名称
  api: TApi; // API 协议——决定路由到哪个 stream 函数
  provider: string; // 供应商标识
  baseUrl: string; // API 端点
  reasoning: boolean; // 是否支持推理
  input: ("text" | "image")[]; // 输入能力声明，用于消息转换时自动降级
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number }; // $/M tokens
  contextWindow: number;
  maxTokens: number;
  compat?: OpenAICompletionsCompat;
}

// ═══════════════════════════════════════════════════
// StreamFunction：provider 是纯函数
// ═══════════════════════════════════════════════════

export interface FnStreamOptions {
  apiKey?: string;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface SimpleFnStreamOptions extends FnStreamOptions {
  reasoning?: "low" | "medium" | "high";
}

/**
 * Provider 契约：
 * - 无状态，不持有 this，每次调用独立创建 client
 * - 同步返回流对象，异步逻辑在 IIFE 中执行
 * - 一旦被调用，请求/模型/运行时错误编码到流中，不 throw
 */
export type StreamFunction<TApi extends Api> = (
  model: Model<TApi>,
  context: Context,
  options?: FnStreamOptions,
) => FnAssistantMessageEventStream;

// ═══════════════════════════════════════════════════
// 按协议注册的 Registry
// ═══════════════════════════════════════════════════

export interface ApiProvider<TApi extends Api> {
  api: TApi;
  stream: StreamFunction<TApi>;
  streamSimple: (model: Model<TApi>, context: Context, options?: SimpleFnStreamOptions) => FnAssistantMessageEventStream;
}

const apiProviders = new Map<Api, ApiProvider<Api>>();

export function registerApiProvider<TApi extends Api>(provider: ApiProvider<TApi>): void {
  apiProviders.set(provider.api, provider as ApiProvider<Api>);
}

function resolveApiProvider(api: Api): ApiProvider<Api> {
  const provider = apiProviders.get(api);
  if (!provider) throw new Error(`No provider registered for api: ${api}`);
  return provider;
}

// ═══════════════════════════════════════════════════
// 公共 API：4 个顶层函数
// ═══════════════════════════════════════════════════

export function stream<TApi extends Api>(
  model: Model<TApi>,
  context: Context,
  options?: FnStreamOptions,
): FnAssistantMessageEventStream {
  // 路由决策完全由 model.api 驱动
  return resolveApiProvider(model.api).stream(model, context, options);
}

/** 铁律：complete 永远是 stream().result() 的语法糖 */
export async function complete<TApi extends Api>(
  model: Model<TApi>,
  context: Context,
  options?: FnStreamOptions,
): Promise<AssistantMessage> {
  return stream(model, context, options).result();
}

export function streamSimple<TApi extends Api>(
  model: Model<TApi>,
  context: Context,
  options?: SimpleFnStreamOptions,
): FnAssistantMessageEventStream {
  return resolveApiProvider(model.api).streamSimple(model, context, options);
}

export async function completeSimple<TApi extends Api>(
  model: Model<TApi>,
  context: Context,
  options?: SimpleFnStreamOptions,
): Promise<AssistantMessage> {
  return streamSimple(model, context, options).result();
}

// ═══════════════════════════════════════════════════
// Provider 实现骨架：openai-completions 协议
// ═══════════════════════════════════════════════════

/**
 * 一个协议实现覆盖所有兼容供应商。实现要点见 examples/llm-openai-sdk-service.ts
 * （chunk 遍历、tool_call 按 index 累积、usage 收集与那里完全一致，
 * 区别只是从 yield 改为 stream.push）。
 */
export const streamOpenAICompletions: StreamFunction<"openai-completions"> = (model, context, options) => {
  const eventStream = new FnAssistantMessageEventStream();

  // 同步返回流对象，异步逻辑在 IIFE 中执行——消费方拿到流时请求可能还没开始
  (async () => {
    const partial: AssistantMessage = {
      role: "assistant",
      content: [],
      model: model.id,
      provider: model.provider,
      usage: {
        input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    };

    try {
      // 1. 创建 OpenAI client（baseURL 来自 model.baseUrl）
      // 2. 按 model.compat 调整请求参数（maxTokensField、supportsStore 等）
      // 3. for await 遍历 SDK stream，累积 blocks，eventStream.push(...) 每个 delta
      // 4. 用 model.cost 计算 usage.cost
      eventStream.push({ type: "done", message: partial });
    } catch (error) {
      // 错误在流中：携带部分内容的 AssistantMessage，不 throw
      partial.stopReason = options?.signal?.aborted ? "aborted" : "error";
      partial.errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
      eventStream.push({ type: "error", message: partial });
    } finally {
      eventStream.end();
    }
  })();

  return eventStream;
};

registerApiProvider({
  api: "openai-completions",
  stream: streamOpenAICompletions,
  // streamSimple 把 reasoning: "high" 等通用选项映射为协议特定参数后委托给 stream
  streamSimple: (model, context, options) => streamOpenAICompletions(model, context, options),
});

// ═══════════════════════════════════════════════════
// 消费方用法
// ═══════════════════════════════════════════════════

export const deepseekChat: Model<"openai-completions"> = {
  id: "deepseek-chat",
  name: "DeepSeek Chat",
  api: "openai-completions", // 路由到 streamOpenAICompletions
  provider: "deepseek",
  baseUrl: "https://api.deepseek.com",
  reasoning: false,
  input: ["text"],
  cost: { input: 0.27, output: 1.1, cacheRead: 0.07, cacheWrite: 0 },
  contextWindow: 65536,
  maxTokens: 8192,
  compat: { thinkingFormat: "none", maxTokensField: "max_tokens" },
};

export async function usageExample(context: Context): Promise<void> {
  // 流式消费
  const s = stream(deepseekChat, context, { apiKey: process.env.DEEPSEEK_API_KEY });
  for await (const event of s) {
    if (event.type === "text_delta") process.stdout.write(event.delta);
  }

  // 或一步拿结果
  const message = await complete(deepseekChat, context, { apiKey: process.env.DEEPSEEK_API_KEY });
  if (message.stopReason === "error") {
    console.error(message.errorMessage);
  }
}
