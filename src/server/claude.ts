import Anthropic from '@anthropic-ai/sdk';
import type { AiProvider } from './aiImport';
import { claudeImportRequest, fromSdkContent } from './claudeRequest';
import { readTokenUsage } from '../import/usage';

/** No environment loading or network activity until turn() is called by an explicitly started run. */
export function createClaudeProvider(options: {
  apiKey?: string;
  model?: string;
  onText?: (text: string) => void;
  client?: Anthropic;
}): AiProvider {
  let client = options.client;
  const usage = (u: Anthropic.Usage) =>
    readTokenUsage({
      inputTokens: u.input_tokens,
      outputTokens: u.output_tokens,
      cacheReadTokens: u.cache_read_input_tokens ?? 0,
      cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
    });
  return {
    async turn(request) {
      client ??= new Anthropic({ apiKey: options.apiKey });
      const stream = client.messages.stream(claudeImportRequest(request, options.model ?? 'claude-opus-4-8'));
      stream.on('text', delta => options.onText?.(delta));
      stream.on('streamEvent', (event, snapshot) => {
        if (event.type === 'message_start' || event.type === 'message_delta') request.onUsage?.(usage(snapshot.usage));
      });
      const message = await stream.finalMessage();
      return {
        content:
          message.stop_reason === 'refusal'
            ? [{ type: 'text' as const, text: 'The provider declined this request.' }]
            : message.content.map(fromSdkContent),
        needsContinuation: message.stop_reason === 'max_tokens',
        usage: usage(message.usage),
      };
    },
  };
}
