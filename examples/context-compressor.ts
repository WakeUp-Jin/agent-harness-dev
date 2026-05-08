/**
 * 上下文压缩器示例
 * 两层压缩机制：工具输出裁剪（前置）+ 历史记录压缩（兜底）。
 */

interface CompressorConfig {
  maxToolOutputChars: number;     // 工具输出最大字符数（建议 2000）
  absoluteMaxChars: number;       // 工具输出绝对上限（如 100000）
  summaryMaxTokens: number;       // 摘要输出最大 token
}

type SummarizeFn = (text: string, instruction?: string) => Promise<string>;

export class OutputTruncator {
  private config: CompressorConfig;
  private summarize: SummarizeFn;

  constructor(config: Partial<CompressorConfig>, summarize: SummarizeFn) {
    this.config = {
      maxToolOutputChars: 2000,
      absoluteMaxChars: 100000,
      summaryMaxTokens: 500,
      ...config,
    };
    this.summarize = summarize;
  }

  /** 第一层：绝对上限截断（防止单个工具输出撑爆摘要模型） */
  async truncate(output: string): Promise<string> {
    // 绝对上限截断
    if (output.length > this.config.absoluteMaxChars) {
      output = output.slice(0, this.config.absoluteMaxChars) + '\n[...truncated]';
    }

    // 未超过软限制，直接返回
    if (output.length <= this.config.maxToolOutputChars) {
      return output;
    }

    // 第二层：超过软限制，生成摘要
    const summary = await this.summarize(
      output,
      '保留关键信息：文件路径、错误信息、核心数据。输出不超过300字。'
    );

    return summary;
  }
}

/** 历史记录压缩策略 */
export class HistoryCompressor {
  private summarize: SummarizeFn;

  constructor(summarize: SummarizeFn) {
    this.summarize = summarize;
  }

  /**
   * 压缩历史记录：保留最近的 preserveRatio 部分完整记录，
   * 前面的部分优先裁剪工具消息，剩余生成摘要。
   */
  async compress(
    messages: Array<{ role: string; content: string }>,
    preserveRatio = 0.3
  ): Promise<Array<{ role: string; content: string }>> {
    const preserveCount = Math.max(1, Math.floor(messages.length * preserveRatio));
    const toCompress = messages.slice(0, -preserveCount);
    const preserved = messages.slice(-preserveCount);

    // 优先移除工具类消息（Token 占比最高）
    const withoutTools = toCompress.filter(m => m.role !== 'tool');
    const textToSummarize = withoutTools.map(m => `[${m.role}] ${m.content}`).join('\n---\n');

    const summary = await this.summarize(
      textToSummarize,
      '生成对话摘要。保留：关键决策、文件路径、未完成任务、重要错误。不超过500字。'
    );

    return [
      { role: 'assistant', content: `[历史摘要]\n${summary}` },
      ...preserved,
    ];
  }
}
