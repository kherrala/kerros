import type Anthropic from '@anthropic-ai/sdk';
import type { AiTokenUsage } from '../../src/import/usage';

/** SDK snapshots already merge cumulative message_delta fields into message_start usage. */
export function claudeTokenUsage(usage: Anthropic.Usage): AiTokenUsage {
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
  };
}
