import { describe, expect, it } from 'vitest';
import { runAiPlanImport, AI_IMPORT_TOOLS, type AiContent, type AiProvider, type PlanSource } from './aiImport';
import { validateProject } from '../schema';
import { documentSvg } from '../import/documentSvg';
import { emptyTokenUsage, type AiTokenUsage } from '../import/usage';
import { hasContextImage } from './context';
import type { AiImportOperation } from './aiImport';

const source: PlanSource = {
  stats: async () => 'image',
  extract: async () => '',
  render: async () => ({ pngBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB', note: 'page' }),
};
const call = (name: string, input: Record<string, unknown>): AiContent => ({
  type: 'tool_use',
  id: crypto.randomUUID(),
  name,
  input,
});

it('replaces cumulative streamed usage, counts each turn once and reports mutation refusals', async () => {
  const snapshots: AiTokenUsage[] = [];
  const operations: AiImportOperation[] = [];
  const first = { inputTokens: 100, outputTokens: 30, cacheReadTokens: 200, cacheWriteTokens: 400 };
  const second = { inputTokens: 50, outputTokens: 20, cacheReadTokens: 400, cacheWriteTokens: 0 };
  let turns = 0;
  const result = await runAiPlanImport(
    {
      async turn({ onUsage }) {
        if (turns++ === 0) {
          onUsage?.({ ...first, outputTokens: 1 });
          onUsage?.(first);
          return {
            usage: first,
            content: [
              call('apply_mutations', {
                mutations: [{ kind: 'addBarrier', a: [0, 0], b: [0, 0], floorId: 'floor-ground', barrierKind: 'wall' }],
              }),
            ],
          };
        }
        onUsage?.(second);
        return { usage: second, content: [] };
      },
    },
    source,
    {
      rasterize: async () => '',
      onUsage: usage => snapshots.push(usage),
      onOperation: operation => operations.push(operation),
    },
  );
  expect(snapshots[0].outputTokens).toBe(1);
  expect(result.usage).toEqual({ inputTokens: 150, outputTokens: 50, cacheReadTokens: 600, cacheWriteTokens: 400 });
  expect(snapshots.at(-1)).toEqual(result.usage);
  expect(operations.filter(o => o.scope !== 'context').map(o => `${o.scope}_${o.phase}`)).toEqual([
    'turn_start',
    'turn_complete',
    'tool_start',
    'tool_refused',
    'turn_start',
    'turn_complete',
  ]);
  expect(operations.find(o => o.phase === 'refused')).toMatchObject({
    turn: 1,
    tool: 'apply_mutations',
    mutations: 1,
    durationMs: expect.any(Number),
  });
  expect(result.document.barriers).toHaveLength(0);
});

it('retains reported partial usage and records a turn error when the provider disconnects', async () => {
  const usage = { ...emptyTokenUsage(), inputTokens: 75, outputTokens: 3 };
  const snapshots: AiTokenUsage[] = [];
  const operations: AiImportOperation[] = [];
  await expect(
    runAiPlanImport(
      {
        async turn({ onUsage }) {
          onUsage?.(usage);
          throw new Error('Connection lost');
        },
      },
      source,
      { rasterize: async () => '', onUsage: u => snapshots.push(u), onOperation: op => operations.push(op) },
    ),
  ).rejects.toThrow('Connection lost');
  expect(snapshots).toEqual([usage]);
  expect(operations.at(-1)).toMatchObject({ scope: 'turn', phase: 'error', turn: 1 });
});

describe('AI tool loop', () => {
  it('streams valid shared-boundary rooms, exposes IDs, and retains them after a refused reset', async () => {
    const snapshots: unknown[] = [];
    let turn = 0;
    const provider: AiProvider = {
      async turn({ messages, tools }) {
        expect(tools.find(t => t.name === 'apply_mutations')?.inputSchema).toHaveProperty('$defs');
        if (turn++ === 0) {
          expect(messages[0].content).toEqual([{ type: 'text', text: expect.stringContaining('Exterior width 6 m') }]);
          return [
            call('apply_mutations', {
              mutations: [
                ...[
                  [
                    [0, 0],
                    [6, 0],
                  ],
                  [
                    [6, 0],
                    [6, 5],
                  ],
                  [
                    [6, 5],
                    [0, 5],
                  ],
                  [
                    [0, 5],
                    [0, 0],
                  ],
                ].map(([a, b]) => ({ kind: 'addBarrier', a, b, floorId: 'floor-ground', barrierKind: 'wall' })),
                { kind: 'encloseRoom', floorId: 'floor-ground', point: [3, 2], name: '<script>bad()</script> & Lobby' },
              ],
            }),
          ];
        }
        if (turn === 2)
          return [
            call('apply_mutations', {
              reset: true,
              mutations: [{ kind: 'addBarrier', a: [0, 0], b: [0, 0], floorId: 'floor-ground', barrierKind: 'wall' }],
            }),
          ];
        if (turn === 3) {
          expect(JSON.stringify(messages.at(-1))).toContain('REFUSED');
          return [call('inspect_document', { collection: 'objects' })];
        }
        expect(JSON.stringify(messages.at(-1))).toContain('Lobby');
        return [{ type: 'text', text: 'Imported one room.' }];
      },
    };
    const result = await runAiPlanImport(provider, source, {
      rasterize: async () => '',
      instructions: 'Exterior width 6 m',
      onDocument: doc => {
        validateProject(doc);
        snapshots.push(doc);
      },
    });
    expect(snapshots).toHaveLength(1);
    expect(result.document.objects[0].geometry?.mode).toBe('boundaries');
    expect(result.document.barriers).toHaveLength(4);
    const svg = documentSvg(result.document);
    expect(svg).toContain('&lt;script&gt;');
    expect(svg).not.toContain('<script>');
  });
  it('forwards page selection and refuses unsupported mutation names', async () => {
    let turn = 0;
    const pages: number[] = [];
    const provider: AiProvider = {
      async turn({ messages }) {
        if (turn++ === 0)
          return [call('render', { page: 2 }), call('apply_mutations', { mutations: [{ kind: 'inventedCommand' }] })];
        expect(JSON.stringify(messages.at(-1))).toContain('Unknown mutation');
        return [];
      },
    };
    await runAiPlanImport(
      provider,
      {
        ...source,
        render: async query => {
          pages.push(query.page!);
          return { pngBase64: 'image', note: '' };
        },
      },
      { rasterize: async () => '' },
    );
    expect(pages).toEqual([2]);
    expect(AI_IMPORT_TOOLS.find(t => t.name === 'render')?.inputSchema).toHaveProperty('properties.page');
  });
});

it('limits raster inspection, reuses views, and allows another view after a real edit', async () => {
  let renders = 0,
    turn = 0;
  const provider: AiProvider = {
    async turn({ messages }) {
      if (turn++ === 0)
        return [
          call('render', {}),
          call('render', {}),
          call('render', { bbox: '0,0,10,10' }),
          call('render', { bbox: '1,1,10,10' }),
          call('render', { bbox: '2,2,10,10' }),
        ];
      if (turn === 2) {
        expect(JSON.stringify(messages.at(-1))).toContain('already in the conversation');
        expect(JSON.stringify(messages.at(-1))).toContain('three source views');
        return [
          call('set_import_notes', {
            notes: 'Coarse wall',
            calibration: { drawingLength: 600, realLengthMetres: 6, basis: 'Printed exterior width' },
            sourcePlan: 'Wall from 0,0 to 6,0 metres',
            phase: 'build',
          }),
          call('apply_mutations', {
            mutations: [{ kind: 'addBarrier', a: [0, 0], b: [6, 0], floorId: 'floor-ground', barrierKind: 'wall' }],
          }),
        ];
      }
      if (turn === 3)
        return [
          call('set_import_notes', { notes: 'Check one unresolved opening', phase: 'review' }),
          call('render', { bbox: '2,2,10,10' }),
        ];
      return [];
    },
  };
  await runAiPlanImport(
    provider,
    {
      ...source,
      kind: 'image',
      render: async () => {
        renders++;
        return { pngBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB', note: '' };
      },
    },
    { rasterize: async () => '' },
  );
  expect(renders).toBe(4);
});
it('continues a truncated response within the explicit turn limit', async () => {
  let turns = 0;
  const provider: AiProvider = {
    async turn({ messages }) {
      if (turns++ === 0) return { content: [{ type: 'text', text: 'The shell...' }], needsContinuation: true };
      expect(JSON.stringify(messages.at(-1))).toContain('output limit');
      return [{ type: 'text', text: 'One draft, ready to review.' }];
    },
  };
  const result = await runAiPlanImport(provider, source, { rasterize: async () => '', maxTurns: 2 });
  expect(result.turns).toBe(2);
});

it('calibrates from the template, removes all images during building, and keeps valid geometry', async () => {
  let turn = 0;
  let renders = 0;
  const result = await runAiPlanImport(
    {
      async turn({ system, messages }) {
        expect(system).toContain('"widthMetres":20');
        if (turn++ === 0) return [call('render', {})];
        if (turn === 2) {
          expect(hasContextImage(messages, 'source-image')).toBe(true);
          return [
            call('set_import_notes', {
              notes: '20 m exterior width, then rooms',
              calibration: { drawingWidth: 1000, basis: 'User exterior width' },
              sourcePlan: 'Exterior bottom wall from [0,0] to [20,0] metres.',
              phase: 'build',
            }),
          ];
        }
        expect(hasContextImage(messages, 'source-image')).toBe(false);
        if (turn === 3)
          return [
            call('apply_mutations', {
              mutations: [{ kind: 'addBarrier', a: [0, 0], b: [20, 0], floorId: 'floor-ground', barrierKind: 'wall' }],
            }),
          ];
        if (turn === 4) return [call('render', {})];
        expect(JSON.stringify(messages.at(-1))).toContain('Build is text-only');
        return [];
      },
    },
    {
      ...source,
      kind: 'image',
      render: async () => {
        renders++;
        return { pngBase64: 'source-image', note: 'Original width 1000 pixels' };
      },
    },
    {
      brief: { buildingType: 'house', widthMetres: 20, floorCount: 1 },
      rasterize: async () => '',
    },
  );
  expect(renders).toBe(1);
  expect(result.document.barriers).toHaveLength(1);
  expect(validateProject(result.document)).toBeTruthy();
});

it('pauses repeated refusals and cumulative spending without starting another provider turn', async () => {
  let calls = 0;
  await expect(
    runAiPlanImport(
      {
        turn: async () => {
          calls++;
          return [
            call('apply_mutations', {
              mutations: [{ kind: 'addBarrier', a: [0, 0], b: [0, 0], floorId: 'floor-ground', barrierKind: 'wall' }],
            }),
          ];
        },
      },
      source,
      { rasterize: async () => '' },
    ),
  ).resolves.toMatchObject({ pause: { reason: 'refusals' }, turns: 3 });
  expect(calls).toBe(3);
  calls = 0;
  await expect(
    runAiPlanImport(
      {
        turn: async () => {
          calls++;
          return { usage: { ...emptyTokenUsage(), outputTokens: 24000 }, content: [call('list_layers', {})] };
        },
      },
      source,
      { rasterize: async () => '' },
    ),
  ).resolves.toMatchObject({ pause: { reason: 'output-budget' }, turns: 1 });
  expect(calls).toBe(1);
});
