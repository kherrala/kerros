import { afterEach, expect, it, vi } from 'vitest';
import { emptyProject, geoOrigin } from '@kerros/schema';
import { createAiImportAdapter, createPdfDrawingAdapter } from './aiImport';

afterEach(() => vi.unstubAllGlobals());
it('sends reference PDF conversion directly to the backend without checking the Claude key', async () => {
  const fetcher = vi.fn(async (url: string, options: RequestInit) => {
    expect(url).toBe('/api/ai-import/preview');
    expect(options.method).toBe('POST');
    const body = options.body as FormData;
    expect(body.get('page')).toBe('2');
    expect((body.get('file') as File).name).toBe('plan.pdf');
    return new Response('png', { headers: { 'Content-Type': 'image/png' } });
  });
  vi.stubGlobal('fetch', fetcher);
  expect((await createPdfDrawingAdapter('/api/ai-import').render(new File(['pdf'], 'plan.pdf'), 2)).type).toBe(
    'image/png',
  );
  expect(fetcher).toHaveBeenCalledOnce();
});
it('displays each accepted snapshot and streamed Unicode text before done', async () => {
  const first = emptyProject(geoOrigin([24, 60]), 'First');
  const second = { ...first, name: 'Second' };
  const progress: string[] = [];
  const usage: unknown[] = [];
  const tokens = { inputTokens: 100, outputTokens: 20, cacheReadTokens: 200, cacheWriteTokens: 0 };
  const documents: string[] = [];
  let finish!: () => void;
  const gate = new Promise<void>(resolve => {
    finish = resolve;
  });
  const events = new TextEncoder().encode(
    JSON.stringify({ type: 'text', detail: 'Käytävä' }) +
      '\n' +
      JSON.stringify({ type: 'usage', usage: tokens }) +
      '\n' +
      JSON.stringify({ type: 'document', document: first }) +
      '\n',
  );
  const stream = new ReadableStream({
    async start(controller) {
      for (let i = 0; i < events.length; i += 7) controller.enqueue(events.slice(i, i + 7));
      await gate;
      controller.enqueue(
        new TextEncoder().encode(
          JSON.stringify({ type: 'document', document: second }) +
            '\n' +
            JSON.stringify({ type: 'done', document: second }),
        ),
      );
      controller.close();
    },
  });
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ configured: true }))
    .mockResolvedValueOnce(new Response(stream));
  vi.stubGlobal('fetch', fetcher);
  const run = createAiImportAdapter('/api/ai-import').run(new File(['file'], 'käytävä.pdf'), {
    origin: first.origin,
    instructions: 'mitat',
    signal: new AbortController().signal,
    onProgress: e => {
      progress.push(e.detail);
    },
    onDocument: p => {
      documents.push(p.name);
    },
    onUsage: u => {
      usage.push(u);
    },
  });
  await expect.poll(() => documents).toEqual(['First']);
  expect(progress).toEqual(['Käytävä']);
  expect(usage).toEqual([tokens]);
  finish();
  expect((await run).name).toBe('Second');
  expect(documents).toEqual(['First', 'Second']);
  expect(fetcher.mock.calls[1][1].body.get('file').name).toBe('käytävä.pdf');
});
it('does not treat a disconnected stream as successful', async () => {
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValueOnce(Response.json({ configured: true }))
      .mockResolvedValueOnce(new Response('{"type":"text","detail":"Starting"}\n')),
  );
  await expect(
    createAiImportAdapter('/api/ai-import').run(new File(['x'], 'plan.png'), {
      origin: [24, 60],
      instructions: '',
      signal: new AbortController().signal,
      onProgress() {},
      onDocument() {},
    }),
  ).rejects.toThrow('ended before completion');
});
it('rejects malformed document snapshots before preview', async () => {
  const onDocument = vi.fn();
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValueOnce(Response.json({ configured: true }))
      .mockResolvedValueOnce(new Response('{"type":"document","document":{}}\n')),
  );
  await expect(
    createAiImportAdapter('/api/ai-import').run(new File(['x'], 'plan.png'), {
      origin: [24, 60],
      instructions: '',
      signal: new AbortController().signal,
      onProgress() {},
      onDocument,
    }),
  ).rejects.toThrow();
  expect(onDocument).not.toHaveBeenCalled();
});

it('waits for durable acceptance and stops consuming edits when saving fails', async () => {
  const project = emptyProject(geoOrigin([24, 60]), 'Accepted');
  let rejectSave!: (e: Error) => void;
  const saving = new Promise<void>((_, reject) => {
    rejectSave = reject;
  });
  const cancel = vi.fn();
  const onDocument = vi.fn(() => saving);
  const onProgress = vi.fn();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(
        new TextEncoder().encode(
          [
            { type: 'document', document: project },
            { type: 'text', detail: 'Must not advance past an unsaved change' },
            { type: 'done', document: project },
          ]
            .map(e => JSON.stringify(e))
            .join('\n') + '\n',
        ),
      );
    },
    cancel,
  });
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValueOnce(Response.json({ configured: true }))
      .mockResolvedValueOnce(new Response(stream)),
  );
  const run = createAiImportAdapter('/api/ai-import').run(new File(['x'], 'plan.png'), {
    origin: project.origin,
    instructions: '',
    signal: new AbortController().signal,
    onDocument,
    onProgress,
  });
  await expect.poll(() => onDocument.mock.calls.length).toBe(1);
  expect(onProgress).not.toHaveBeenCalled();
  const failed = expect(run).rejects.toThrow('Storage full');
  rejectSave(new Error('Storage full'));
  await failed;
  expect(cancel).toHaveBeenCalledOnce();
  expect(onProgress).not.toHaveBeenCalled();
});

it('sends live instructions to the job endpoint and reports ended runs for a saved retry', async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ queued: true }, { status: 202 }))
    .mockResolvedValueOnce(Response.json({ error: 'Run has ended' }, { status: 409 }));
  vi.stubGlobal('fetch', fetcher);
  const adapter = createAiImportAdapter('/api/ai-import');
  await adapter.sendInstruction!('job-1', { id: 'm-1', text: 'Add doors' });
  expect(fetcher.mock.calls[0][0]).toBe('/api/ai-import/job-1/instructions');
  expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ id: 'm-1', text: 'Add doors' });
  await expect(adapter.sendInstruction!('job-1', { id: 'm-2', text: 'Add doors' })).rejects.toThrow('Run has ended');
});
