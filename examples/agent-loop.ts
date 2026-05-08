/**
 * Agent 执行循环示例
 * 实现 LLM → tool_calls → ToolScheduler → 回填 → 重复 的主循环，
 * 包含子智能体执行能力（AgentTool 模式）。
 *
 * 使用 ContextItem 内部数据结构管理上下文，仅在调用 LLM 时转换为消息格式。
 */

import { BaseLLMService, LLMResponse, Message, TokenUsage, ToolCall } from './llm-service';
import { ToolScheduler } from './tool-scheduler';
import { ToolRegistry, ToolDefinition } from './tool-definition';
import { ContextManager, ContextItem, MessagePriority } from './context-manager';

const MAX_ITERATIONS = 10;

// ─── 结果类型 ───

interface EngineResult {
  text: string;
  usage: TokenUsage;
  thinking?: string;
}

interface AgentToolResult {
  agentId: string;
  agentType: string;
  text: string;
  totalToolUseCount: number;
  totalDurationMs: number;
  totalTokens: number;
}

// ─── 子智能体定义 ───

interface SubAgentDefinition {
  agentType: string;
  systemPrompt: string;
  allowedTools?: string[];
  maxIterations?: number;
}

// ─── 执行引擎 ───

export class ExecutionEngine {
  private scheduler: ToolScheduler;
  private maxIterations: number;

  constructor(options: { scheduler: ToolScheduler; maxIterations?: number }) {
    this.scheduler = options.scheduler;
    this.maxIterations = options.maxIterations ?? MAX_ITERATIONS;
  }

  /**
   * 执行 LLM-Tool 循环。
   * 每轮：LLM.complete() → 解析 tool_calls → 调度执行 → 回填结果 → 重复
   * 终止条件：LLM 返回纯文本（无 tool_calls）或达到最大迭代次数
   */
  async run(
    llm: BaseLLMService,
    contextManager: ContextManager,
    toolRegistry: ToolRegistry,
    options?: {
      onMessage?: (item: ContextItem) => void;
      source?: string;
    }
  ): Promise<EngineResult> {
    const totalUsage: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    let lastText = '';
    let lastThinking: string | undefined;

    for (let i = 0; i < this.maxIterations; i++) {
      const messages = contextManager.getContext();
      const tools = toolRegistry.getDefinitions();

      const response = await llm.complete(messages, tools);
      this.accumulateUsage(totalUsage, response.usage);
      lastThinking = response.thinking;

      if (response.toolCalls.length === 0) {
        lastText = response.text;
        const item = new ContextItem({
          role: 'assistant',
          content: response.text,
          source: options?.source ?? 'llm',
          priority: MessagePriority.HIGH,
          thinking: response.thinking,
        });
        contextManager.appendItem(item);
        options?.onMessage?.(item);
        break;
      }

      const assistantItem = new ContextItem({
        role: 'assistant',
        content: response.text || '',
        source: options?.source ?? 'llm',
        priority: MessagePriority.HIGH,
        toolCalls: response.toolCalls.map(tc => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
        })),
        thinking: response.thinking,
      });
      contextManager.appendItem(assistantItem);
      options?.onMessage?.(assistantItem);

      for (const toolCall of response.toolCalls) {
        const result = await this.scheduler.execute(
          toolCall.id,
          toolCall.name,
          toolCall.arguments
        );

        const toolItem = new ContextItem({
          role: 'tool',
          content: result.resultString || result.error || '',
          source: `tool:${toolCall.name}`,
          priority: MessagePriority.NORMAL,
          toolCallId: toolCall.id,
          name: toolCall.name,
        });
        contextManager.appendItem(toolItem);
        options?.onMessage?.(toolItem);
      }
    }

    return { text: lastText, usage: totalUsage, thinking: lastThinking };
  }

  private accumulateUsage(total: TokenUsage, usage: TokenUsage) {
    total.promptTokens += usage.promptTokens;
    total.completionTokens += usage.completionTokens;
    total.totalTokens += usage.totalTokens;
  }
}

// ─── Agent：顶层协调器 ───

export class Agent {
  private llm: BaseLLMService;
  private contextManager: ContextManager;
  private toolRegistry: ToolRegistry;
  private scheduler: ToolScheduler;
  private engine: ExecutionEngine;
  private subAgentDefs: Map<string, SubAgentDefinition>;

  constructor(options: {
    llm: BaseLLMService;
    contextManager: ContextManager;
    toolRegistry: ToolRegistry;
    scheduler: ToolScheduler;
    subAgentDefs?: SubAgentDefinition[];
    maxIterations?: number;
  }) {
    this.llm = options.llm;
    this.contextManager = options.contextManager;
    this.toolRegistry = options.toolRegistry;
    this.scheduler = options.scheduler;
    this.engine = new ExecutionEngine({
      scheduler: options.scheduler,
      maxIterations: options.maxIterations,
    });
    this.subAgentDefs = new Map();
    for (const def of options.subAgentDefs ?? []) {
      this.subAgentDefs.set(def.agentType, def);
    }

    this.registerAgentTool();
  }

  async run(userText: string): Promise<string> {
    const userItem = new ContextItem({
      role: 'user',
      content: userText,
      source: 'user',
      priority: MessagePriority.HIGH,
    });
    this.contextManager.appendItem(userItem);

    const result = await this.engine.run(
      this.llm,
      this.contextManager,
      this.toolRegistry,
      { source: 'main' }
    );

    return result.text;
  }

  // ─── AgentTool：子智能体工具注册 ───

  private registerAgentTool() {
    this.scheduler.registerHandler('Agent', async (_id, _name, args) => {
      const { prompt, description, subagent_type } = args as {
        prompt: string;
        description: string;
        subagent_type?: string;
      };

      const agentType = subagent_type ?? 'general-purpose';
      const result = await this.spawnSubAgent(agentType, prompt, description);

      return {
        resultString: JSON.stringify({
          agentId: result.agentId,
          agentType: result.agentType,
          content: [{ type: 'text', text: result.text }],
          totalToolUseCount: result.totalToolUseCount,
          totalDurationMs: result.totalDurationMs,
          totalTokens: result.totalTokens,
        }),
      };
    });
  }

  /**
   * 启动子智能体。
   * 为子智能体创建独立的 ContextManager、工具集和系统提示词，
   * 在隔离的上下文中执行 LLM-Tool 循环，返回结构化结果。
   */
  private async spawnSubAgent(
    agentType: string,
    prompt: string,
    description: string
  ): Promise<AgentToolResult> {
    const startTime = Date.now();
    const agentId = `a${Math.random().toString(36).slice(2, 10)}`;

    const def = this.subAgentDefs.get(agentType);

    // 1. 独立的 ContextManager，使用子智能体专属系统提示词
    const subContext = new ContextManager({
      systemPrompt: def?.systemPrompt ?? 'You are a helpful assistant.',
    });

    // 2. 独立的工具集（主智能体工具的子集）
    const subToolRegistry = this.buildSubAgentToolRegistry(def?.allowedTools);

    // 3. 注入 prompt 作为子智能体的首条 user 消息
    subContext.appendItem(new ContextItem({
      role: 'user',
      content: prompt,
      source: 'parent-agent',
      priority: MessagePriority.HIGH,
    }));

    // 4. 独立的执行引擎
    const subEngine = new ExecutionEngine({
      scheduler: this.scheduler,
      maxIterations: def?.maxIterations ?? MAX_ITERATIONS,
    });

    let toolUseCount = 0;
    const result = await subEngine.run(
      this.llm,
      subContext,
      subToolRegistry,
      {
        source: `subagent:${agentType}`,
        onMessage: (item) => {
          if (item.role === 'assistant' && item.toolCalls.length > 0) {
            toolUseCount += item.toolCalls.length;
          }
        },
      }
    );

    return {
      agentId,
      agentType,
      text: result.text,
      totalToolUseCount: toolUseCount,
      totalDurationMs: Date.now() - startTime,
      totalTokens: result.usage.totalTokens,
    };
  }

  private buildSubAgentToolRegistry(allowedTools?: string[]): ToolRegistry {
    const allDefs = this.toolRegistry.getDefinitions();
    if (!allowedTools) {
      return this.toolRegistry;
    }
    const allowed = new Set(allowedTools);
    const filtered = allDefs.filter(d => allowed.has(d.name));
    return ToolRegistry.from(filtered);
  }
}
