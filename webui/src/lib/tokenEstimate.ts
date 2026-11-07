import type { CanvasRecord as Message } from './canvas/records';
import { estimateCacheFromHistoryPrompt, type TokenCacheState } from './chatTerminal';

export interface TokenUsage {
  prompt: number;
  completion: number;
  total: number;
  cached?: number;
  cached_estimated?: boolean;
  reasoning?: number;
}

export function estimateTextTokens(text: string | null | undefined): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 3.5));
}

/** Format token count to human friendly string (e.g. 1.2k, 128k, 1.0M). */
export function formatTokenMetric(num: number | undefined | null): string {
  if (num == null || num <= 0) return '0';
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(1)}M`;
  if (num >= 10_000) return `${(num / 1_000).toFixed(0)}k`;
  if (num >= 1_000) return `${(num / 1_000).toFixed(1)}k`;
  return String(num);
}

/** Estimate token breakdown for a single message. */
export function estimateMessageTokens(m: Message): { prompt: number; completion: number; reasoning: number } {
  let prompt = 0;
  let completion = 0;
  let reasoning = 0;

  if (m.role === 'user') {
    for (const p of m.parts) {
      if (p.kind === 'text') prompt += estimateTextTokens(p.text);
    }
  } else if (m.role === 'assistant') {
    for (const p of m.parts) {
      if (p.kind === 'text') completion += estimateTextTokens(p.text);
      else if (p.kind === 'reasoning') reasoning += estimateTextTokens(p.text);
      else if (p.kind === 'tool') {
        prompt += estimateTextTokens((p.tool.name || '') + ' ' + (p.tool.args || '') + ' ' + (p.tool.output || ''));
      } else if (p.kind === 'notice' || p.kind === 'rate_limited') {
        prompt += estimateTextTokens(p.text);
      }
    }
  }
  return { prompt, completion, reasoning };
}

/** Estimate total token usage across all messages in a session. */
export function estimateAllMessagesTokens(messages: Message[]): TokenUsage {
  let prompt = 0;
  let completion = 0;
  let reasoning = 0;

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    const isLast = i === messages.length - 1;
    const est = estimateMessageTokens(m);

    if (m.role === 'assistant' && !isLast) {
      // In multi-turn chat, historical assistant text is fed back as prompt context,
      // while historical reasoning is omitted by default from next-turn prompt context.
      prompt += est.prompt + est.completion;
    } else {
      prompt += est.prompt;
      completion += est.completion;
      reasoning += est.reasoning;
    }
  }
  const total = prompt + completion + reasoning;
  return {
    prompt,
    completion: completion + reasoning,
    total,
    reasoning,
  };
}

/** Prompt tokens accumulated before the last user message (prefix-cache baseline). */
export function promptTokensBeforeLastUser(messages: Message[]): number {
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'user') {
      lastUserIdx = i;
      break;
    }
  }
  if (lastUserIdx <= 0) return 0;
  let history = 0;
  for (let i = 0; i < lastUserIdx; i++) {
    const m = messages[i]!;
    const est = estimateMessageTokens(m);
    if (m.role === 'assistant') history += est.prompt + est.completion;
    else history += est.prompt;
  }
  return history;
}

export function estimateSessionTokens(
  messages: Message[],
): { tokens: TokenUsage; cacheState: TokenCacheState } {
  const base = estimateAllMessagesTokens(messages);
  const prior = promptTokensBeforeLastUser(messages);
  const cache = estimateCacheFromHistoryPrompt(base.prompt, prior);
  return {
    tokens: {
      ...base,
      cached: cache.cached,
      cached_estimated: cache.cached_estimated,
    },
    cacheState: cache.cacheState,
  };
}
