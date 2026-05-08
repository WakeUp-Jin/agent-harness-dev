/**
 * Agent 执行循环示例
 * 实现 LLM → tool_calls → ToolScheduler → 回填 → 重复 的主循环，
 * 包含子智能体执行能力（AgentTool 模式）。
 *
 * 使用 Message 判别联合管理上下文，LLM 直接返回 AssistantMessage。
 */

import {
  BaseLLMService, Message, Usage,
  AssistantMessage, ToolResultMessage,
  MessagePriority,
  getTextContent, getToolCalls, hasToolCalls,
} from './llm-service';
import { ToolScheduler } from './tool-scheduler';
import { ToolRegistry } from './tool-definition';
import { ContextManager } from './context-manager';

const MAX_ITERATIONS = 10;

// ─── 结果类型 ───

interface EngineResult {
  /** 最终的 assistant 回复（最后一轮无工具调用的回复） */
  message: AssistantMessage;
  /** 所有轮次累计的 Token 使用量 */
  totalUsage: Usage;
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
   * 每轮：LLM.completeSimple() → 检查 stopReason → 调度工具 → 回填结果 → 重复
   * 终止条件：stopReason 不是 "toolUse"，或达到最大迭代次数
   */
  async run(
    llm: BaseLLMService,
    contextManager: ContextManager,
    toolRegistry: ToolRegistry,
    options?: {
      onMessage?: (message: Message) => void;
      source?: string;
    }
  ): Promise<EngineResult> {
    const totalUsage = createEmptyUsage();
    let lastMessage!: AssistantMessage;

    for (let i = 0; i < this.maxIterations; i++) {
      const context = contextManager.getContext();
      context.tools = toolRegistry.getAll().map(t => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      }));

      const assistantMsg = await llm.completeSimple(context);
      assistantMsg.source = options?.source ?? 'llm';
      assistantMsg.priority = MessagePriority.HIGH;
      lastMessage = assistantMsg;

      accumulateUsage(totalUsage, assistantMsg.usage);
      contextManager.appendMessage(assistantMsg);
      options?.onMessage?.(assistantMsg);

      if (assistantMsg.stopReason !== 'toolUse') {
        break;
      }

      const toolCalls = getToolCalls(assistantMsg);
      for (const toolCall of toolCalls) {
        const result = await this.scheduler.execute(
          toolCall.id,
          toolCall.name,
          toolCall.arguments,
        );

        const toolMsg: ToolResultMessage = {
          role: 'toolResult',
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          content: [{ type: 'text', text: result.resultString || result.error || '' }],
          isError: !!result.error,
          timestamp: Date.now(),
          source: `tool:${toolCall.name}`,
        };
        contextManager.appendMessage(toolMsg);
        options?.onMessage?.(toolMsg);
      }
    }

    return { message: lastMessage, totalUsage };
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
    const userMsg: Message = {
      role: 'user',
      content: userText,
      timestamp: Date.now(),
      source: 'user',
      priority: MessagePriority.HIGH,
    };
    this.contextManager.appendMessage(userMsg);

    const result = await this.engine.run(
      this.llm,
      this.contextManager,
      this.toolRegistry,
      { source: 'main' },
    );

    return getTextContent(result.message);
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
    description: string,
  ): Promise<AgentToolResult> {
    const startTime = Date.now();
    const agentId = `a${Math.random().toString(36).slice(2, 10)}`;

    const def = this.subAgentDefs.get(agentType);

    const subContext = new ContextManager({
      systemPrompt: def?.systemPrompt ?? 'You are a helpful assistant.',
    });

    const subToolRegistry = this.buildSubAgentToolRegistry(def?.allowedTools);

    subContext.appendMessage({
      role: 'user',
      content: prompt,
      timestamp: Date.now(),
      source: 'parent-agent',
      priority: MessagePriority.HIGH,
    });

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
        onMessage: (msg) => {
          if (msg.role === 'assistant' && hasToolCalls(msg)) {
            toolUseCount += getToolCalls(msg).length;
          }
        },
      },
    );

    return {
      agentId,
      agentType,
      text: getTextContent(result.message),
      totalToolUseCount: toolUseCount,
      totalDurationMs: Date.now() - startTime,
      totalTokens: result.totalUsage.totalTokens,
    };
  }

  private buildSubAgentToolRegistry(allowedTools?: string[]): ToolRegistry {
    if (!allowedTools) {
      return this.toolRegistry;
    }
    const allowed = new Set(allowedTools);
    const filtered = this.toolRegistry.getAll().filter(d => allowed.has(d.name));
    return ToolRegistry.from(filtered);
  }
}

// ─── Usage 工具函数 ───

function createEmptyUsage(): Usage {
  return {
    input: 0, output: 0,
    cacheRead: 0, cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function accumulateUsage(total: Usage, delta: Usage): void {
  total.input += delta.input;
  total.output += delta.output;
  total.cacheRead += delta.cacheRead;
  total.cacheWrite += delta.cacheWrite;
  total.totalTokens += delta.totalTokens;
  total.cost.input += delta.cost.input;
  total.cost.output += delta.cost.output;
  total.cost.cacheRead += delta.cost.cacheRead;
  total.cost.cacheWrite += delta.cost.cacheWrite;
  total.cost.total += delta.cost.total;
}
