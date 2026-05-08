/**
 * 上下文管理器示例
 * 协调各子模块构建完整的 LLM 输入消息序列。
 *
 * 核心设计：上下文在内部使用 ContextItem（富数据结构）表示，
 * 只有在最终注入 LLM 时才通过 toMessage() 转换为精简的消息格式。
 */

import { Message } from './llm-service';

// ─── 优先级枚举 ───

enum MessagePriority {
  LOW = 1,
  NORMAL = 2,
  HIGH = 3,
  CRITICAL = 4,
}

// ─── Token 使用量（仅 assistant 消息有值） ───

interface ItemUsage {
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  totalTokens: number;
  cost: number;
}

// ─── ContextItem：内部数据结构，携带元数据 ───

class ContextItem {
  role: string;
  content: string | null;
  source: string;
  priority: MessagePriority;
  createdAt: number;
  metadata: Record<string, unknown>;
  toolCalls: Array<Record<string, unknown>>;
  toolCallId: string | null;
  name: string | null;
  thinking: string | null;
  usage: ItemUsage;

  constructor(opts: {
    role: string;
    content?: string | null;
    source?: string;
    priority?: MessagePriority;
    toolCalls?: Array<Record<string, unknown>>;
    toolCallId?: string | null;
    name?: string | null;
    thinking?: string | null;
    usage?: Partial<ItemUsage>;
    metadata?: Record<string, unknown>;
  }) {
    this.role = opts.role;
    this.content = opts.content ?? null;
    this.source = opts.source ?? '';
    this.priority = opts.priority ?? MessagePriority.NORMAL;
    this.createdAt = Date.now();
    this.metadata = opts.metadata ?? {};
    this.toolCalls = opts.toolCalls ?? [];
    this.toolCallId = opts.toolCallId ?? null;
    this.name = opts.name ?? null;
    this.thinking = opts.thinking ?? null;
    this.usage = {
      promptTokens: 0, completionTokens: 0,
      cachedTokens: 0, totalTokens: 0, cost: 0,
      ...opts.usage,
    };
  }

  /** 转为 LLM API 格式（精简，丢弃元数据） */
  toMessage(): Record<string, unknown> {
    const msg: Record<string, unknown> = { role: this.role };
    if (this.content !== null) msg.content = this.content;
    if (this.toolCalls.length > 0) msg.tool_calls = this.toolCalls;
    if (this.toolCallId !== null) msg.tool_call_id = this.toolCallId;
    if (this.name !== null) msg.name = this.name;
    if (this.thinking !== null) msg.reasoning_content = this.thinking;
    return msg;
  }

  /** 转为完整持久化格式（用于 JSONL 存储） */
  toDict(): Record<string, unknown> {
    return {
      role: this.role, content: this.content, source: this.source,
      priority: this.priority, createdAt: this.createdAt,
      metadata: this.metadata, toolCalls: this.toolCalls,
      toolCallId: this.toolCallId, name: this.name,
      thinking: this.thinking, usage: this.usage,
    };
  }

  static fromMessage(
    message: Record<string, unknown>,
    source = '',
    priority = MessagePriority.NORMAL
  ): ContextItem {
    return new ContextItem({
      role: (message.role as string) ?? 'user',
      content: message.content as string | null,
      source,
      priority,
      toolCalls: (message.tool_calls as Array<Record<string, unknown>>) ?? [],
      toolCallId: message.tool_call_id as string | null,
      name: message.name as string | null,
    });
  }
}

// ─── SystemPart：系统级内容片段（XML 标签包裹） ───

class SystemPart {
  constructor(
    public tag: string,
    public description: string,
    public content: string,
  ) {}

  render(): string {
    if (this.description) {
      return `<${this.tag} description="${this.description}">\n${this.content}\n</${this.tag}>`;
    }
    return `<${this.tag}>\n${this.content}\n</${this.tag}>`;
  }
}

// ─── ContextParts：模块 format() 的返回类型 ───

interface ContextParts {
  systemParts: SystemPart[];
  messageItems: ContextItem[];
}

// ─── ContextModule：子模块接口 ───

interface ContextModule {
  format(): ContextParts;
}

// ─── CompressionConfig ───

interface CompressionConfig {
  contextWindow: number;
  compressionThreshold: number;
  compressKeepRatio: number;
}

// ─── ContextManager：统一编排器 ───

export class ContextManager {
  private systemPromptModule: ContextModule;
  private shortTermItems: ContextItem[] = [];
  private longTermModule?: ContextModule;
  private config: CompressionConfig;

  constructor(options: {
    systemPrompt: ContextModule;
    longTermMemory?: ContextModule;
    config?: Partial<CompressionConfig>;
  }) {
    this.systemPromptModule = options.systemPrompt;
    this.longTermModule = options.longTermMemory;
    this.config = {
      contextWindow: 128000,
      compressionThreshold: 0.85,
      compressKeepRatio: 0.3,
      ...options.config,
    };
  }

  /** 追加 ContextItem，自动设置工具相关的 source 和 priority */
  appendItem(item: ContextItem): void {
    if (item.toolCalls.length > 0 || item.role === 'tool') {
      item.source = item.source || 'tool';
      item.priority = MessagePriority.HIGH;
    }
    this.shortTermItems.push(item);
  }

  /** 从原始消息 dict 追加（便捷方法） */
  appendMessage(message: Record<string, unknown>): void {
    this.appendItem(ContextItem.fromMessage(message, 'conversation'));
  }

  /**
   * 组装最终的 LLM message 数组。
   *
   * 1. 从各模块收集 systemParts 和 messageItems
   * 2. 将所有 systemParts 渲染为 XML 标签并合并为一条 system message
   * 3. 将 messageItems 逐个通过 toMessage() 转为 LLM API 格式
   */
  getContext(): Message[] {
    const { systemParts, messageItems } = this.collectParts();
    const messages: Message[] = [];

    if (systemParts.length > 0) {
      const rendered = systemParts
        .filter(p => p.content.trim())
        .map(p => p.render())
        .join('\n\n');
      messages.push({ role: 'system', content: rendered });
    }

    for (const item of messageItems) {
      messages.push(item.toMessage() as Message);
    }

    return this.sanitize(messages);
  }

  needsCompression(): boolean {
    const tokens = this.estimateTokens();
    return tokens >= this.config.contextWindow * this.config.compressionThreshold;
  }

  private collectParts(): { systemParts: SystemPart[]; messageItems: ContextItem[] } {
    const allSystem: SystemPart[] = [];
    const allMessages: ContextItem[] = [];

    const modules: ContextParts[] = [
      this.systemPromptModule.format(),
      this.longTermModule?.format() ?? { systemParts: [], messageItems: [] },
      { systemParts: [], messageItems: this.shortTermItems },
    ];

    for (const parts of modules) {
      allSystem.push(...parts.systemParts);
      allMessages.push(...parts.messageItems);
    }

    return { systemParts: allSystem, messageItems: allMessages };
  }

  private estimateTokens(): number {
    return this.shortTermItems.reduce(
      (sum, item) => sum + Math.ceil((item.content?.length ?? 0) / 3.5),
      0,
    );
  }

  private sanitize(messages: Message[]): Message[] {
    // 修复不完整的工具调用对（有 tool_call 但缺少 tool 响应）
    return messages;
  }
}

export { ContextItem, SystemPart, MessagePriority };
export type { ContextParts, ContextModule, CompressionConfig };
