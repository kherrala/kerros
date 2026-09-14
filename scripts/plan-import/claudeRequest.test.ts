import { expect, it } from 'vitest';
import { claudeImportRequest } from '../../src/server/claudeRequest';

it('caches conversation and stable tools/system with bounded output and intact thinking', () => {
  const raw = { type: 'thinking', thinking: 'working', signature: 'unaltered' };
  const request = claudeImportRequest({ system: 'Task briefing', tools: [{ name: 'edit', description: 'Edit', inputSchema: { type: 'object' } }], messages: [
    { role: 'user', content: [{ type: 'text', text: 'Import' }] },
    { role: 'assistant', content: [{ type: 'opaque', raw }, { type: 'tool_use', id: '1', name: 'edit', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', toolUseId: '1', content: [{ type: 'text', text: 'ok' }] }] },
  ] }, 'test-model');
  expect(request).toMatchObject({ max_tokens: 4096, output_config: { effort: 'medium' }, cache_control: { type: 'ephemeral' }, system: [{ cache_control: { type: 'ephemeral' } }] });
  expect((request.messages[1].content as unknown[])[0]).toBe(raw);
  expect(request.tools).toHaveLength(1);
});
