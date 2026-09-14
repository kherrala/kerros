import { expect, it } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { importLogRecord, logImport } from './logging';
import { claudeTokenUsage } from './usage';

it('maps inclusive output usage and nullable cache counters without counting thinking twice', () => {
  expect(claudeTokenUsage({ input_tokens: 100, output_tokens: 40, cache_read_input_tokens: null, cache_creation_input_tokens: 200, output_tokens_details: { thinking_tokens: 30 } } as unknown as Anthropic.Usage))
    .toEqual({ inputTokens: 100, outputTokens: 40, cacheReadTokens: 0, cacheWriteTokens: 200 });
});
it('writes correlated structured operations without prompts, credentials or arbitrary error text', () => {
  const lines: string[] = [];
  logImport({ event: 'tool_refused', jobId: '0bdd8f31-8013-44b0-951e-f0f438f9dce3', tool: 'apply_mutations', turn: 2, durationMs: 3, mutations: 4, instructions: 'private drawing', input: { secret: 'api-key' }, error: 'private SDK error' }, line => lines.push(line));
  expect(JSON.parse(lines[0])).toEqual({ time: expect.any(String), component: 'ai-import', event: 'tool_refused', jobId: '0bdd8f31-8013-44b0-951e-f0f438f9dce3', tool: 'apply_mutations', turn: 2, durationMs: 3, mutations: 4 });
  expect(importLogRecord({ event: 'raw SDK error' })).toBeUndefined();
  expect(importLogRecord({ event: 'usage', outputTokens: -1, inputTokens: 'secret', jobId: 'secret' })).toEqual({ component: 'ai-import', event: 'usage' });
});
