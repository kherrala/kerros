import { expect, it } from 'vitest';
import {
  analysisSvg,
  calibrateSource,
  queryCandidates,
  validateSourceAnalysis,
  vectorBounds,
  type SourceAnalysis,
  type VectorCommand,
} from './analysis';
import { SourceAnalysisTools } from './analysisTools';
import { extractCadVectors } from './cadAnalysis';
import { runAiPlanImport, type AiContent } from './aiImport';

const path: VectorCommand[] = [['M', 0, 0], ['L', 1000, 0], ['L', 1000, 500], ['L', 0, 500], ['Z']];
const source = (count = 1): SourceAnalysis => ({
  version: 1,
  id: 'source-1',
  sourceHash: 'a'.repeat(64),
  page: 1,
  sourceKind: 'pdf',
  units: 'pt',
  axis: 'y-down',
  bounds: [0, 0, 1000, 500],
  warnings: [],
  candidates: Array.from({ length: count }, (_, i) => ({
    id: `outline-${i}`,
    kind: 'path',
    path,
    bounds: vectorBounds(path),
    evidence: 'Test outline',
  })),
});
const call = (name: string, input: Record<string, unknown>): AiContent => ({ type: 'tool_use', id: name, name, input });

it('calibrates actual source geometry to metres, preserving one scale and y direction', () => {
  const a = validateSourceAnalysis(source());
  const transform = calibrateSource(a, { widthMetres: 20, footprintAreaM2: 200 }, { referenceIds: ['outline-0'] });
  expect(transform.metresPerUnit).toBe(0.02);
  const result = queryCandidates(a, {}, transform);
  expect(result).toMatchObject({
    units: 'm',
    axis: 'y-up',
    candidates: [{ path: [['M', 0, 10], ['L', 20, 10], ['L', 20, 0], ['L', 0, 0], ['Z']] }],
  });
  expect(queryCandidates(a)).toMatchObject({ units: 'pt', axis: 'y-down' });
  expect(() => calibrateSource(a, { widthMetres: 20, depthMetres: 30 }, { referenceIds: ['outline-0'] })).toThrow(
    'disagree',
  );
  expect(() => calibrateSource(a, undefined, { referenceIds: ['outline-0'], realLengthMetres: 20 })).toThrow(
    'single straight',
  );
  a.candidates[0].path = [
    ['M', 0, 0],
    ['L', 1000, 0],
    ['L', 1000, 250],
    ['L', 500, 250],
    ['L', 500, 500],
    ['L', 0, 500],
    ['Z'],
  ];
  const lShape = calibrateSource(a, { footprintAreaM2: 150 }, { referenceIds: ['outline-0'] });
  expect(lShape.metresPerUnit).toBe(0.02);
});

it('paginates bounded vector text, binds cursors to filters/calibration, and escapes SVG labels', () => {
  const a = source(60);
  const first = queryCandidates(a);
  expect('candidates' in first && first.candidates).toHaveLength(25);
  expect(JSON.stringify(first).length).toBeLessThanOrEqual(12000);
  const second = queryCandidates(a, { cursor: first.nextCursor! });
  expect('candidates' in second && second.candidates[0].id).toBe('outline-25');
  expect(() => queryCandidates(a, { kind: 'path', cursor: first.nextCursor! })).toThrow('does not match');
  expect(() => queryCandidates(a, { limit: 26 })).toThrow('25');
  a.candidates.push({
    id: 'label',
    kind: 'label',
    path: [['M', 5, 5]],
    bounds: [5, 5, 5, 5],
    evidence: 'label',
    text: '<script>alert("x")</script>',
  });
  const svg = analysisSvg(a);
  expect(svg).toContain('&lt;script&gt;');
  expect(svg).not.toContain('<script>');
  expect(svg).not.toContain('<image');
  const overlay = queryCandidates(a, { ids: ['outline-0'], format: 'svg' });
  expect('svg' in overlay && overlay.svg).toContain('data-id="outline-0"');
  expect(() => validateSourceAnalysis({ ...a, candidates: [a.candidates[0], a.candidates[0]] })).toThrow('candidate');
});

it('rejects old transform IDs and preserves native CAD entities without classifying symbols as walls', async () => {
  const tools = new SourceAnalysisTools(
    {
      analyse: async () => source(),
      stats: async () => '',
      extract: async () => '',
      render: async () => {
        throw new Error('No images');
      },
    },
    { widthMetres: 20 },
  );
  await tools.execute('analyse_source', {});
  const first = JSON.parse(
    (await tools.execute('calibrate_source', { artifactId: 'source-1', referenceIds: ['outline-0'] }))!,
  );
  await tools.execute('calibrate_source', { artifactId: 'source-1', referenceIds: ['outline-0'], origin: [0, 0] });
  await expect(tools.execute('query_candidates', { artifactId: 'source-1', transformId: first.id })).rejects.toThrow(
    'stale',
  );
  const data = extractCadVectors([
    { type: 'LINE', layer: 'wall-faces', a: [0, 0], b: [20, 0] },
    { type: 'TEXT', layer: 'labels', text: 'WC', at: [2, 3] },
    { type: 'CIRCLE', layer: 'furniture', center: [5, 5], r: 1 },
  ]);
  expect(data.candidates.map(c => c.kind)).toEqual(['path', 'label', 'path']);
  expect(data.candidates[0].path).toEqual([
    ['M', 0, 0],
    ['L', 20, 0],
  ]);
  expect(data.candidates[2].uncertainty).toContain('Bézier');
});

it('lets the model inspect and build from vector text without ever rendering or receiving an image', async () => {
  let turn = 0;
  const result = await runAiPlanImport(
    {
      turn: async ({ messages }) => {
        expect(JSON.stringify(messages)).not.toContain('image_png');
        const next = [
          [call('analyse_source', {})],
          [call('calibrate_source', { artifactId: 'source-1', referenceIds: ['outline-0'] })],
          [call('query_candidates', { artifactId: 'source-1', transformId: 'source-1:t1' })],
          [
            call('set_import_notes', {
              notes: 'Calibrated outline',
              sourcePlan: '20 by 10 metre shell. Bottom wall [0,0] to [20,0].',
              phase: 'build',
            }),
          ],
          [
            call('apply_mutations', {
              mutations: [{ kind: 'addBarrier', a: [0, 0], b: [20, 0], floorId: 'floor-ground', barrierKind: 'wall' }],
            }),
          ],
          [],
        ];
        return next[turn++];
      },
    },
    {
      kind: 'pdf',
      analyse: async () => source(),
      stats: async () => '',
      extract: async () => '',
      render: async () => {
        throw new Error('Unexpected source rendering');
      },
    },
    {
      brief: { widthMetres: 20 },
      rasterize: async () => {
        throw new Error('Unexpected document rendering');
      },
    },
  );
  expect(result.document.barriers).toHaveLength(1);
});
