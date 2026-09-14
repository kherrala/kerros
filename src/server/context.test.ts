import { expect, it } from 'vitest';
import { compactImportContext, estimateContextTokens, hasContextImage, withoutContextImages } from './context';
import type { AiMessage } from './aiImport';

it('keeps every result in the latest parallel tool batch above the soft target', () => {
  const checkpoint: AiMessage = { role: 'user', content: [{ type: 'text', text: 'Saved working plan' }] };
  const latest: AiMessage[] = [
    {
      role: 'assistant',
      content: ['document', 'walls', 'labels'].map(id => ({ type: 'tool_use', id, name: id, input: {} })),
    },
    {
      role: 'user',
      content: ['document', 'walls', 'labels'].map(id => ({
        type: 'tool_result',
        toolUseId: id,
        content: [{ type: 'text', text: `${id}: ${'measured evidence '.repeat(500)}` }],
      })),
    },
  ];
  const bounded = compactImportContext('', [], [checkpoint, ...latest], checkpoint, 12000, 2000);
  expect(bounded.compacted).toBe(true);
  expect(bounded.messages).toEqual([checkpoint, ...latest]);
  expect(bounded.estimatedTokens).toBeGreaterThan(2000);
  expect(bounded.estimatedTokens).toBeLessThanOrEqual(12000);
  // A hard ceiling is still enforced; it must never silently replace results with stale notes.
  expect(() => compactImportContext('', [], [checkpoint, ...latest], checkpoint, 2000)).toThrow('latest tool exchange');
  expect(estimateContextTokens('', [], bounded.messages)).toBe(bounded.estimatedTokens);
});

it('bounds history while retaining whole tool exchanges and original signed blocks', () => {
  const original: AiMessage = { role: 'user', content: [{ type: 'text', text: 'Exterior width 20 m' }] };
  const messages: AiMessage[] = [original];
  const signed = { type: 'thinking', signature: 'opaque-signature', thinking: 'private reasoning' };
  for (let i = 0; i < 20; i++)
    messages.push(
      {
        role: 'assistant',
        content: [
          { type: 'opaque', raw: signed },
          { type: 'tool_use', id: String(i), name: 'inspect_document', input: {} },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            toolUseId: String(i),
            content: [{ type: 'text', text: 'Large obsolete collection. '.repeat(200) }],
          },
        ],
      },
    );
  const checkpoint: AiMessage = {
    role: 'user',
    content: [
      ...original.content,
      { type: 'text', text: 'Scale 0.02 m/pixel; live document retained; next add doors.' },
    ],
  };
  const bounded = compactImportContext('', [], messages, checkpoint, 5000);
  expect(bounded.compacted).toBe(true);
  expect(bounded.estimatedTokens).toBeLessThanOrEqual(5000);
  expect(bounded.messages[0]).toBe(checkpoint);
  expect(bounded.messages.length).toBeGreaterThan(1);
  for (let i = 1; i < bounded.messages.length; i += 2) {
    expect(bounded.messages[i].content[0]).toEqual({ type: 'opaque', raw: signed });
    const call = bounded.messages[i].content[1];
    expect(call.type).toBe('tool_use');
    expect(bounded.messages[i + 1].content[0]).toMatchObject({
      type: 'tool_result',
      toolUseId: call.type === 'tool_use' ? call.id : '',
    });
  }
  expect(messages).toHaveLength(41);
});
it('omits images throughout the text-only phase without altering signed thinking or tool envelopes', () => {
  const messages: AiMessage[] = [
    { role: 'user', content: [{ type: 'image_png', base64: 'overview' }] },
    {
      role: 'assistant',
      content: [
        { type: 'opaque', raw: { signature: 'untouched' } },
        { type: 'tool_use', id: 'render-1', name: 'render', input: {} },
      ],
    },
    {
      role: 'user',
      content: [{ type: 'tool_result', toolUseId: 'render-1', content: [{ type: 'image_png', base64: 'crop' }] }],
    },
  ];
  const textOnly = withoutContextImages(messages);
  expect(hasContextImage(textOnly, 'overview')).toBe(false);
  expect(hasContextImage(textOnly, 'crop')).toBe(false);
  expect(textOnly[1].content[0]).toBe(messages[1].content[0]);
  expect(textOnly[2].content[0]).toMatchObject({ type: 'tool_result', toolUseId: 'render-1' });
  expect(hasContextImage(messages, 'overview')).toBe(true);
});
