import type { AiContent, AiMessage, AiToolSpec } from './aiImport';

/** Local estimate, not a tokenizer or billing counter. Keep the full tool schema in the budget.
 * PNG pixels, rather than base64 bytes, determine vision cost. */
export function estimateContextTokens(system: string, tools: AiToolSpec[], messages: AiMessage[]): number {
  const size = (block: AiContent): number => {
    if (block.type === 'image_png') {
      try {
        const header = atob(block.base64.slice(0, 32));
        const uint = (i: number) => Array.from(header.slice(i, i + 4)).reduce((n, c) => n * 256 + c.charCodeAt(0), 0);
        if (header.startsWith('\x89PNG') && header.length >= 24) return Math.ceil((uint(16) * uint(20)) / 600) + 64;
      } catch {
        /* Unknown image: reserve a typical source view. */
      }
      return 2048;
    }
    if (block.type === 'tool_result') return 20 + block.content.reduce((n, c) => n + size(c), 0);
    return Math.ceil(JSON.stringify(block).length / 3) + 12;
  };
  return (
    Math.ceil((system.length + JSON.stringify(tools).length) / 3) +
    messages.reduce((n, m) => n + 12 + m.content.reduce((sum, c) => sum + size(c), 0), 0)
  );
}

export function hasContextImage(messages: AiMessage[], base64: string): boolean {
  const has = (c: AiContent): boolean =>
    c.type === 'image_png' ? c.base64 === base64 : c.type === 'tool_result' && c.content.some(has);
  return messages.some(m => m.content.some(has));
}

/** Drop whole completed exchanges, never half of a tool-use/result pair or part of a signed
 * thinking block. The checkpoint is generated locally from the live plan and saved notes. */
export function compactImportContext(
  system: string,
  tools: AiToolSpec[],
  messages: AiMessage[],
  checkpoint: AiMessage,
  limit: number,
  target = limit,
): { messages: AiMessage[]; estimatedTokens: number; compacted: boolean } {
  let estimatedTokens = estimateContextTokens(system, tools, messages);
  if (estimatedTokens <= Math.min(target, limit) && messages.length <= 13)
    return { messages, estimatedTokens, compacted: false };
  const groups: AiMessage[][] = [];
  for (const message of messages.slice(1)) {
    if (message.role === 'assistant') groups.push([message]);
    else groups.at(-1)?.push(message);
  }
  // Keep up to three recent exchanges; their tool results include exact generated IDs/refusals.
  let recent = groups.slice(-3);
  let next = [checkpoint, ...recent.flat()];
  estimatedTokens = estimateContextTokens(system, tools, next);
  // The routine history target is soft. Never erase the latest tool results to hit it:
  // doing so sends the same checkpoint back and makes the model repeat its last queries.
  while (recent.length > 1 && estimatedTokens > Math.min(target, limit)) {
    recent = recent.slice(1);
    next = [checkpoint, ...recent.flat()];
    estimatedTokens = estimateContextTokens(system, tools, next);
  }
  if (estimatedTokens > limit)
    throw new Error(
      'Import paused: the latest tool exchange and working checkpoint exceed the context budget. Narrow the candidate/document queries or raise the import context limit.',
    );
  return { messages: next, estimatedTokens, compacted: true };
}

/** Text-only build phase: remove image payloads even from retained exchanges. Preserve the
 * tool envelope and every opaque signed block unchanged. */
export function withoutContextImages(messages: AiMessage[]): AiMessage[] {
  const strip = (c: AiContent): AiContent =>
    c.type === 'image_png'
      ? { type: 'text', text: '[Image omitted during text-only building; use the recorded source plan.]' }
      : c.type === 'tool_result'
        ? { ...c, content: c.content.map(strip) }
        : c;
  return messages.map(m => ({ ...m, content: m.content.map(strip) }));
}
