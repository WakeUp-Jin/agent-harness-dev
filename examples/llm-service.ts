/**
 * LLM 服务基类与统一响应格式示例
 * 所有具体服务类（OpenAI、Claude、DeepSeek 等）继承此基类。
 */

export interface LLMConfig {
  provider: string;
  apiKey: string;
  baseUrl?: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
  maxRetries?: number;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface LLMResponse {
  text: string;
  toolCalls: ToolCall[];
  usage: TokenUsage;
  thinking?: string;
}

export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCallId?: string;
  toolCalls?: ToolCall[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export abstract class BaseLLMService {
  protected config: LLMConfig;
  protected totalUsage: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

  constructor(config: LLMConfig) {
    this.config = config;
  }

  /** 核心方法：接收上下文消息和工具定义，返回 LLM 响应 */
  abstract complete(messages: Message[], tools?: ToolDefinition[]): Promise<LLMResponse>;

  /** 简单对话：不涉及工具调用，适用于内部辅助任务 */
  async chat(message: string, systemPrompt?: string): Promise<string> {
    const messages: Message[] = [];
    if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
    messages.push({ role: 'user', content: message });
    const response = await this.complete(messages);
    return response.text;
  }

  /** 累计 Token 使用量 */
  protected accumulateUsage(usage: TokenUsage) {
    this.totalUsage.promptTokens += usage.promptTokens;
    this.totalUsage.completionTokens += usage.completionTokens;
    this.totalUsage.totalTokens += usage.totalTokens;
  }

  getTotalUsage(): TokenUsage {
    return { ...this.totalUsage };
  }
}
