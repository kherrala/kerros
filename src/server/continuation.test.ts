import { expect, it } from 'vitest';
import { AI_IMPORT_SYSTEM, AI_IMPORT_TOOLS, runAiPlanImport, type AiContent, type PlanSource } from './aiImport';
import { DEFAULT_MUTATION_KINDS, MUTATION_KINDS, mutationTool } from './mutationTools';
import { estimateContextTokens } from './context';
import { emptyTokenUsage } from '../import/usage';
import { emptyProject, geoOrigin, applyMutations } from '../schema';
import { readImportCheckpoint, type ImportCheckpoint } from '../import/checkpoint';
import { SourceAnalysisTools } from './analysisTools';
import type { SourceAnalysis } from './analysis';

const call = (name: string, input: Record<string, unknown>): AiContent => ({
  type: 'tool_use',
  id: crypto.randomUUID(),
  name,
  input,
});
const source: PlanSource = {
  kind: 'image',
  stats: async () => '1000 pixels wide',
  extract: async () => '',
  render: async () => {
    throw new Error('No image should be needed');
  },
};
const buildNotes = {
  notes: 'Next: add right wall, then rooms.',
  sourcePlan: 'Exterior 20 by 10 m; bottom wall complete.',
  calibration: { drawingWidth: 1000, basis: 'User exterior width' },
  phase: 'build',
};

it('keeps every mutation reachable with exact generated definitions and a smaller default request', () => {
  const full = AI_IMPORT_TOOLS.find(t => t.name === 'apply_mutations')!;
  const small = mutationTool(DEFAULT_MUTATION_KINDS);
  expect(JSON.stringify(small).length).toBeLessThan(JSON.stringify(full).length / 3);
  expect(MUTATION_KINDS).toContain('setNavigation');
  for (const kind of MUTATION_KINDS) {
    const tool = mutationTool([kind]);
    const schema = tool.inputSchema;
    const refs = JSON.stringify(schema).matchAll(/"\$ref":"#\/\$defs\/([^"]+)"/g);
    for (const [, id] of refs)
      expect((schema.$defs as Record<string, unknown>)[id]).toEqual(
        (full.inputSchema.$defs as Record<string, unknown>)[id],
      );
  }
  expect(
    estimateContextTokens(
      AI_IMPORT_SYSTEM,
      AI_IMPORT_TOOLS.map(t => (t.name === 'apply_mutations' ? small : t)),
      [],
    ),
  ).toBeLessThan(8000);
});

it('loads requested schemas on the next turn without removing any core operation', async () => {
  let turns = 0;
  await runAiPlanImport(
    {
      turn: async ({ tools }) => {
        const mutation = JSON.stringify(tools.find(t => t.name === 'apply_mutations')!.inputSchema);
        if (!turns++) {
          expect(mutation).not.toContain('servedFloorIds');
          return [call('select_mutation_tools', { kinds: ['addObject', 'setNavigation'] })];
        }
        expect(mutation).toContain('servedFloorIds');
        expect(mutation).toContain('setNavigation');
        return [];
      },
    },
    source,
    { rasterize: async () => '' },
  );
  expect(turns).toBe(2);
});

it('pauses normally at the budget and resumes calibrated text-only work, preserving manual corrections', async () => {
  const checkpoints: ImportCheckpoint[] = [];
  const base = emptyProject(geoOrigin([24, 60]));
  const first = await runAiPlanImport(
    {
      turn: async ({ maxOutputTokens }) => {
        expect(maxOutputTokens).toBe(1000);
        return {
          usage: { ...emptyTokenUsage(), outputTokens: 1000 },
          content: [
            call('set_import_notes', buildNotes),
            call('apply_mutations', {
              mutations: [{ kind: 'addBarrier', a: [0, 0], b: [20, 0], floorId: 'floor-ground', barrierKind: 'wall' }],
            }),
          ],
        };
      },
    },
    source,
    {
      base,
      brief: { widthMetres: 20 },
      maxOutputTokens: 1000,
      rasterize: async () => '',
      onCheckpoint: c => {
        checkpoints.push(c);
      },
    },
  );
  expect(first.pause?.reason).toBe('output-budget');
  expect(first.document.barriers).toHaveLength(1);
  const saved = readImportCheckpoint(JSON.parse(JSON.stringify(checkpoints.at(-1))))!;
  expect(saved).toMatchObject({ phase: 'build', calibration: { metresPerUnit: 0.02 }, notes: buildNotes.notes });
  const correction = applyMutations(first.document, [{ kind: 'patchProject', set: { name: 'Manually corrected' } }]);
  if (!correction.ok) throw new Error(correction.error);
  let turns = 0;
  const resumed = await runAiPlanImport(
    {
      turn: async ({ messages }) => {
        expect(JSON.stringify(messages)).not.toContain('image_png');
        expect(JSON.stringify(messages)).toContain('Manually corrected');
        expect(JSON.stringify(messages)).toContain('Next: add right wall');
        expect(JSON.stringify(messages)).toContain('0.02');
        if (!turns++)
          return [
            call('apply_mutations', {
              mutations: [
                { kind: 'addBarrier', a: [20, 0], b: [20, 10], floorId: 'floor-ground', barrierKind: 'wall' },
              ],
            }),
          ];
        return [];
      },
    },
    source,
    { base: correction.project, checkpoint: saved, brief: { widthMetres: 20 }, rasterize: async () => '' },
  );
  expect(resumed.pause).toBeUndefined();
  expect(resumed.document.name).toBe('Manually corrected');
  expect(resumed.document.barriers).toHaveLength(2);
  expect(resumed.checkpoint.calibration?.metresPerUnit).toBe(0.02);
});

it('invalidates a saved scale and geometric transcription after a changed template', async () => {
  const first = await runAiPlanImport({ turn: async () => [call('set_import_notes', buildNotes)] }, source, {
    brief: { widthMetres: 20 },
    maxTurns: 1,
    rasterize: async () => '',
  });
  let turns = 0;
  const next = await runAiPlanImport(
    {
      turn: async () =>
        turns++
          ? []
          : [
              call('apply_mutations', {
                mutations: [
                  { kind: 'addBarrier', a: [0, 0], b: [20, 0], floorId: 'floor-ground', barrierKind: 'wall' },
                ],
              }),
            ],
    },
    source,
    { brief: { widthMetres: 30 }, base: first.document, checkpoint: first.checkpoint, rasterize: async () => '' },
  );
  expect(next.checkpoint.phase).toBe('inspect');
  expect(next.checkpoint.calibration).toBeUndefined();
  expect(next.document.barriers).toHaveLength(0);
});

it('rehydrates source references and identical transform IDs from cached recipes and rejects another drawing', async () => {
  const a: SourceAnalysis = {
    version: 1,
    id: 'analysis-1',
    sourceHash: 'a'.repeat(64),
    page: 1,
    sourceKind: 'image',
    units: 'px',
    axis: 'y-down',
    bounds: [0, 0, 1000, 500],
    warnings: [],
    candidates: [
      {
        id: 'wall-1',
        kind: 'wall',
        path: [
          ['M', 0, 0],
          ['L', 1000, 0],
        ],
        bounds: [0, 0, 1000, 0],
        evidence: 'Test wall',
      },
    ],
  };
  const src = { ...source, analyse: async () => a };
  const tools = new SourceAnalysisTools(src, { widthMetres: 20 });
  await tools.execute('analyse_source', {});
  const transform = JSON.parse(
    (await tools.execute('calibrate_source', { artifactId: a.id, referenceIds: ['wall-1'] }))!,
  );
  const restored = new SourceAnalysisTools(src, { widthMetres: 20 });
  await restored.restore(JSON.parse(JSON.stringify(tools.save())));
  const result = await restored.execute('query_candidates', { artifactId: a.id, transformId: transform.id });
  expect(JSON.parse(result!)).toMatchObject({
    units: 'm',
    candidates: [
      {
        path: [
          ['M', 0, 10],
          ['L', 20, 10],
        ],
      },
    ],
  });
  const wrong = new SourceAnalysisTools({ ...src, analyse: async () => ({ ...a, sourceHash: 'b'.repeat(64) }) });
  await expect(wrong.restore(tools.save())).rejects.toThrow('drawing changed');
  const updatedSource = { ...src, analyse: async () => ({ ...a, id: 'analysis-2' }) };
  const updated = new SourceAnalysisTools(updatedSource, { widthMetres: 20 });
  expect(await updated.restore(tools.save())).toBe(true);
  expect(updated.save()[0]).toMatchObject({ artifactId: 'analysis-2', calibration: undefined });
  await expect(
    updated.execute('query_candidates', { artifactId: 'analysis-2', transformId: transform.id }),
  ).rejects.toThrow();
  const first = await runAiPlanImport({ turn: async () => [call('set_import_notes', buildNotes)] }, src, {
    brief: { widthMetres: 20 },
    maxTurns: 1,
    rasterize: async () => '',
  });
  const resumed = await runAiPlanImport(
    {
      turn: async ({ messages }) => {
        expect(JSON.stringify(messages)).toContain('Source analysis updated');
        return [];
      },
    },
    updatedSource,
    {
      base: first.document,
      checkpoint: { ...first.checkpoint, analysis: tools.save() },
      brief: { widthMetres: 20 },
      rasterize: async () => '',
    },
  );
  expect(resumed.document).toEqual(first.document);
  expect(resumed.checkpoint).toMatchObject({ phase: 'inspect', sourcePlan: '', calibration: undefined });
  expect(resumed.checkpoint.analysis[0].artifactId).toBe('analysis-2');
});

it('receives human instructions between turns, deduplicates and preserves them across budget pauses', async () => {
  const pending = [{ id: 'early', text: 'Use sliding doors.' }];
  let turns = 0;
  const result = await runAiPlanImport(
    {
      turn: async ({ messages }) => {
        const text = JSON.stringify(messages);
        if (!turns++) {
          expect(text).toContain('Use sliding doors.');
          pending.push({ id: 'during', text: 'Keep the kitchen open.' });
          return {
            content: [{ type: 'text', text: 'Finished.' }],
            usage: { ...emptyTokenUsage(), outputTokens: 1000 },
          };
        }
        throw new Error('Budget must pause before another paid turn');
      },
    },
    source,
    { rasterize: async () => '', maxOutputTokens: 1000, takeInstructions: () => pending.splice(0) },
  );
  expect(result.pause?.reason).toBe('output-budget');
  expect(result.checkpoint.steering?.map(m => m.id)).toEqual(['early', 'during']);
  const resumed = await runAiPlanImport(
    {
      turn: async ({ messages }) => {
        const text = JSON.stringify(messages);
        expect(text.match(/Keep the kitchen open\./g)).toHaveLength(1);
        expect(text).toContain('Use sliding doors.');
        return [];
      },
    },
    source,
    {
      base: result.document,
      checkpoint: result.checkpoint,
      rasterize: async () => '',
      takeInstructions: () => [{ id: 'during', text: 'Keep the kitchen open.' }],
    },
  );
  expect(resumed.turns).toBe(1);
});

it('starts another turn for a message arriving during the final model response', async () => {
  const pending: { id: string; text: string }[] = [];
  let turns = 0;
  await runAiPlanImport(
    {
      turn: async ({ messages }) => {
        if (!turns++) pending.push({ id: 'late', text: 'Add a second exit.' });
        else expect(JSON.stringify(messages)).toContain('Add a second exit.');
        return [{ type: 'text', text: 'Complete' }];
      },
    },
    source,
    { rasterize: async () => '', takeInstructions: () => pending.splice(0) },
  );
  expect(turns).toBe(2);
});
