import { expect, it } from 'vitest';
import type { AssetRepository } from '../model/types';
import { loadAiImportSession, saveAiImportSession, type AiImportSession } from './session';

it('restores project-specific source and transcript with running imports paused', async () => {
  const blobs = new Map<string, Blob>();
  const assets: AssetRepository = {
    async get(id) {
      return blobs.get(id);
    },
    async put(id, blob) {
      blobs.set(id, blob);
    },
    async delete(id) {
      blobs.delete(id);
    },
  };
  const session: AiImportSession = {
    version: 1,
    projectId: 'project-a',
    sourceId: 'source-a',
    sourceName: 'käytävä.pdf',
    sourceType: 'application/pdf',
    instructions: 'Use a scale of 1:100',
    followUp: 'Add the doors',
    messages: [{ type: 'text', detail: 'The walls are ready.' }],
    phase: 'running',
    activity: 'Adding doors',
    edits: 3,
    usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 20, cacheWriteTokens: 10 },
    hasUsage: true,
    error: '',
  };
  await assets.put(session.sourceId, new Blob(['source drawing'], { type: session.sourceType }));
  await saveAiImportSession(assets, session);
  session.messages.push({ type: 'text', detail: 'Not saved yet' });
  const restored = await loadAiImportSession(assets, 'project-a');
  expect(restored).toMatchObject({ phase: 'paused', edits: 3, followUp: 'Add the doors', usage: session.usage });
  expect(restored!.messages).toHaveLength(1);
  expect(await (await assets.get(restored!.sourceId))!.text()).toBe('source drawing');
  expect(await loadAiImportSession(assets, 'project-b')).toBeNull();
  await saveAiImportSession(assets, { ...restored!, phase: 'done' });
  expect((await loadAiImportSession(assets, 'project-a'))!.phase).toBe('done');
});
