import type Anthropic from '@anthropic-ai/sdk';
import type { AiContent, AiProvider } from './aiImport';

export const toSdkContent = (c: AiContent): Anthropic.ContentBlockParam => {
  switch (c.type) {
    case 'text':
      return { type: 'text', text: c.text };
    case 'image_png':
      return { type: 'image', source: { type: 'base64', media_type: 'image/png', data: c.base64 } };
    case 'tool_use':
      return { type: 'tool_use', id: c.id, name: c.name, input: c.input };
    case 'tool_result':
      return {
        type: 'tool_result',
        tool_use_id: c.toolUseId,
        content: c.content.map(toSdkContent) as Anthropic.ToolResultBlockParam['content'],
        ...(c.isError ? { is_error: true } : {}),
      };
    case 'opaque':
      return c.raw as Anthropic.ContentBlockParam;
  }
};
export const fromSdkContent = (block: Anthropic.ContentBlock): AiContent => {
  if (block.type === 'text') return { type: 'text', text: block.text };
  if (block.type === 'tool_use')
    return { type: 'tool_use', id: block.id, name: block.name, input: block.input as Record<string, unknown> };
  return { type: 'opaque', raw: block };
};

/** Pure request builder: tests exercise the complete provider payload without a key or SDK call. */
export function claudeImportRequest(
  request: Parameters<AiProvider['turn']>[0],
  model: string,
): Anthropic.MessageCreateParamsNonStreaming {
  return {
    model,
    max_tokens: request.maxOutputTokens ?? 4096,
    thinking: { type: 'adaptive' },
    output_config: { effort: 'medium' },
    // The explicit stable prefix survives local history compaction. Automatic caching also
    // covers the growing conversation, including images/tool results and complete thinking.
    cache_control: { type: 'ephemeral' },
    system: [{ type: 'text', text: request.system, cache_control: { type: 'ephemeral' } }],
    tools: request.tools.map(t => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
    })),
    messages: request.messages.map(m => ({ role: m.role, content: m.content.map(toSdkContent) })),
  };
}
