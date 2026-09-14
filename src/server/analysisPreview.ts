import { analysisSummary, analysisSvg, type SourceAnalysis, type SourceTransform } from './analysis';
import { readAnalysisPreview, type ImportAnalysisPreview } from '../import/analysisPreview';

/** A bounded visual side channel for the person importing, never LLM context. Prioritize
 * architectural proposals before raw strokes on large CAD/PDF sheets. */
export function sourceAnalysisPreview(
  a: SourceAnalysis,
  transform?: SourceTransform,
  selectedIds: string[] = [],
  pngBase64?: string,
): ImportAnalysisPreview {
  const rank = ['outline', 'wall', 'symbol', 'label', 'path', 'image-region'];
  const selected = new Set(selectedIds);
  let candidates = a.candidates
    .filter(c => c.kind !== 'clip')
    .sort(
      (a, b) => Number(selected.has(b.id)) - Number(selected.has(a.id)) || rank.indexOf(a.kind) - rank.indexOf(b.kind),
    )
    .slice(0, 500)
    .map(c => ({
      ...c,
      ...(c.kind !== 'label'
        ? {
            strokeWidth: Math.max(c.strokeWidth ?? 0, (a.bounds[2] - a.bounds[0]) / 650) * (selected.has(c.id) ? 2 : 1),
            stroke: selected.has(c.id)
              ? '#dc2626'
              : c.kind === 'wall'
                ? '#2563eb'
                : c.kind === 'outline'
                  ? '#b45309'
                  : c.kind === 'symbol'
                    ? '#7e22ce'
                    : '#64748b',
            ...(c.kind === 'wall' || c.kind === 'outline' || c.kind === 'symbol' ? { fill: undefined } : {}),
          }
        : {}),
    }));
  // Keep the full source frame even when the human preview caps candidates.
  const render = () =>
    analysisSvg(
      { ...a, candidates: [...candidates, ...a.candidates.filter(c => c.kind === 'clip')] },
      undefined,
      transform,
    );
  let svg = render();
  while (svg.length > 200_000 && candidates.length) {
    candidates = candidates.slice(0, Math.floor(candidates.length * 0.75));
    svg = render();
  }
  const summary = analysisSummary(a);
  const matrix = [...(transform?.matrix ?? [1, 0, 0, 1, 0, 0])] as [number, number, number, number, number, number];
  if (transform || a.axis === 'y-up') {
    matrix[1] *= -1;
    matrix[3] *= -1;
    matrix[5] *= -1;
  }
  return readAnalysisPreview({
    artifactId: a.id,
    page: a.page,
    units: transform ? 'm' : a.units,
    ...(transform
      ? {
          transformId: transform.id,
          metresPerUnit: transform.metresPerUnit,
          calibration: transform.basis.slice(0, 500),
        }
      : {}),
    svg,
    ...(pngBase64 ? { background: { pngBase64, bounds: a.bounds, matrix } } : {}),
    shown: candidates.length,
    total: a.candidates.filter(c => c.kind !== 'clip').length,
    counts: summary.counts,
    warnings: a.warnings.slice(0, 20),
  });
}
