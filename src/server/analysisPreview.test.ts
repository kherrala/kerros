import { expect, it } from 'vitest';
import { sourceAnalysisPreview } from './analysisPreview';
import {
  readAnalysisPreview,
  saveAnalysisPreview,
  loadAnalysisPreview,
  analysisPreviewSvg,
} from '../import/analysisPreview';
import { runAiPlanImport } from './aiImport';
import type { SourceAnalysis } from './analysis';

const png =
  'iVBORw0KGgoAAAANSUhEUgAAAMgAAABkCAYAAADDhn8LAAAABHNCSVQICAgIfAhkiAAAAAFzUkdCAK7OHOkAAAFWSURBVHic7dwxCsJAEEBRI97MRjyDYJkzWQZyTy1sIoTfbsD3uukGls90O91v1/cJ2HUevQAcmUAgXLbDurzGbfLnHs/5Z/YW42zfwgWBIBAIAoEgEAgCgSAQCAKBIBAIAoEgEAgCgSAQCAKBIBAIAoEgEAgCgSAQCAKBIBAIAoEgEAgCgSAQCAKBIBAIAoEgEAgCgSAQCAKBIBAIAoEgEAgCgSAQCAKBIBAIAoEgEAgCgSAQCAKBIBAIAoEgEAgCgSAQCAKBIBAIAoEgEAgCgSAQCAKBIBAIAoEgEAgCgSAQCAKBIBAIl9EL8LUur9ErsMMFgSAQCAKBIBAIAoEgEAgCgSAQCAKBIBAIAoEgEAgCgSAQCAKBIBAIAoEgEAgCgSAQCAKBIBAIAoEgEAgCgSAQCAKBIBAIAoEgEAg+jjuIx3P+mX0kdwwuCASBQBAIBIFAEAgEgUAQCASBQBAIBIFAEAiE6X67vkcvAUflgkAQCIQPez4PU1TWyXUAAAAASUVORK5CYII=';
const drawing: SourceAnalysis = {
  version: 1,
  id: 'drawing',
  sourceHash: 'a'.repeat(64),
  page: 1,
  sourceKind: 'image',
  units: 'px',
  axis: 'y-down',
  bounds: [0, 0, 1000, 1000],
  warnings: [],
  candidates: Array.from({ length: 600 }, (_, i) => ({
    id: `wall-${i}`,
    kind: 'wall',
    evidence: 'Test lines',
    bounds: [i, 0, i, 1000],
    path: [
      ['M', i, 0],
      ['L', i, 1000],
    ],
  })),
};
it('bounds and persists the human SVG separately, prioritizing the latest selection', async () => {
  const p = sourceAnalysisPreview(drawing, undefined, ['wall-599']);
  expect(p.shown).toBe(500);
  expect(p.total).toBe(600);
  expect(p.svg).toContain('wall-599');
  expect(p.svg.length).toBeLessThanOrEqual(200_000);
  const blobs = new Map<string, Blob>();
  const assets = {
    get: async (id: string) => blobs.get(id),
    put: async (id: string, b: Blob) => {
      blobs.set(id, b);
    },
    delete: async (id: string) => {
      blobs.delete(id);
    },
  };
  await saveAnalysisPreview(assets, 'source', p);
  expect(await loadAnalysisPreview(assets, 'source')).toEqual(p);
  for (const markup of [
    '<script>alert(1)</script>',
    '<image href="https://example.com"/>',
    '<g onload="alert(1)"/>',
    '<foreignObject/>',
  ])
    expect(() => readAnalysisPreview({ ...p, svg: p.svg.replace('</svg>', markup + '</svg>') })).toThrow();
});
it('sends SVG previews only to the UI, keeping full previews out of model context', async () => {
  const previews: unknown[] = [];
  let turns = 0;
  let renders = 0;
  await runAiPlanImport(
    {
      turn: async ({ messages }) => {
        if (!turns++) return [{ type: 'tool_use', id: 'analyse', name: 'analyse_source', input: {} }];
        expect(JSON.stringify(messages)).not.toContain('<svg');
        expect(JSON.stringify(messages)).not.toContain(png);
        if (turns === 2)
          return [
            { type: 'tool_use', id: 'query', name: 'query_candidates', input: { artifactId: drawing.id, limit: 1 } },
          ];
        return [];
      },
    },
    {
      kind: 'image',
      stats: async () => 'Source',
      extract: async () => '',
      render: async () => {
        renders++;
        return { pngBase64: png, note: 'Human preview' };
      },
      analyse: async () => drawing,
    },
    {
      rasterize: async () => '',
      onAnalysis: p => {
        previews.push(p);
      },
    },
  );
  expect(previews).toHaveLength(2);
  expect(renders).toBe(1);
  expect(previews[0]).toMatchObject({ shown: 500, total: 600, background: { pngBase64: png, bounds: drawing.bounds } });
});

it('aligns the source raster through calibration, rotation, y-up display and original page offsets', () => {
  const p = sourceAnalysisPreview(
    { ...drawing, bounds: [100, 200, 1100, 1200] },
    {
      id: 'rotated',
      artifactId: drawing.id,
      metresPerUnit: 0.02,
      referenceIds: [],
      basis: 'Rotated source',
      matrix: [0, 0.02, 0.02, 0, -4, -2],
    },
    [],
    png,
  );
  expect(p.background?.matrix).toEqual([0, -0.02, 0.02, -0, -4, 2]);
  expect(p.svg).toContain('viewBox="0 -20 20 20"');
  const svg = analysisPreviewSvg(p, ['wall'], true, 0.5);
  expect(svg).toContain('transform="matrix(0 -0.02 0.02 0 -4 2)"');
  expect(svg).toContain('x="100" y="200" width="1000" height="1000"');
  expect(svg).toContain('opacity="0.5"');
  expect(svg.indexOf('<image')).toBeLessThan(svg.indexOf('<g opacity'));
  expect(analysisPreviewSvg(p, [], false)).not.toContain('<image');
  expect(() =>
    readAnalysisPreview({ ...p, background: { ...p.background, pngBase64: 'https://unrelated.example/image.png' } }),
  ).toThrow();
});
