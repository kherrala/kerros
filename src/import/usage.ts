/** Disjoint provider-reported token counts. Input excludes cache reads and writes. */
export interface AiTokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}
export const emptyTokenUsage = (): AiTokenUsage => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
});
export function addTokenUsage(a: AiTokenUsage, b: AiTokenUsage): AiTokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
  };
}
export function readTokenUsage(value: unknown): AiTokenUsage {
  if (!value || typeof value !== 'object') throw new Error('Invalid import token usage.');
  const usage = value as AiTokenUsage;
  const result = emptyTokenUsage();
  for (const key of Object.keys(result) as (keyof AiTokenUsage)[]) {
    if (!Number.isSafeInteger(usage[key]) || usage[key] < 0) throw new Error('Invalid import token usage.');
    result[key] = usage[key];
  }
  return result;
}
