import type { AssetRepository } from '../model/types';

/** Human-only vector evidence. Never part of the model checkpoint or its conversation. */
export interface ImportAnalysisPreview {
  artifactId: string;
  page: number;
  units: 'm' | 'px' | 'pt';
  transformId?: string;
  metresPerUnit?: number;
  calibration?: string;
  svg: string;
  /** Human-only source raster, located in the SVG display coordinate frame. */
  background?: {
    pngBase64: string;
    bounds: [number, number, number, number];
    matrix: [number, number, number, number, number, number];
  };
  shown: number;
  total: number;
  counts: Record<string, number>;
  warnings: string[];
}
export function readAnalysisPreview(value: unknown): ImportAnalysisPreview {
  const p = value as ImportAnalysisPreview;
  if (
    !p ||
    typeof p.artifactId !== 'string' ||
    p.artifactId.length > 200 ||
    !Number.isSafeInteger(p.page) ||
    p.page < 1 ||
    p.page > 20 ||
    !['m', 'px', 'pt'].includes(p.units) ||
    typeof p.svg !== 'string' ||
    p.svg.length > 200_000 ||
    !p.svg.startsWith('<svg ') ||
    !Number.isSafeInteger(p.shown) ||
    p.shown < 0 ||
    !Number.isSafeInteger(p.total) ||
    p.total < p.shown ||
    !p.counts ||
    typeof p.counts !== 'object' ||
    Object.keys(p.counts).length > 20 ||
    Object.values(p.counts).some(n => !Number.isSafeInteger(n) || n < 0) ||
    !Array.isArray(p.warnings) ||
    p.warnings.length > 20 ||
    p.warnings.some(s => typeof s !== 'string' || s.length > 1000) ||
    (p.calibration !== undefined && (typeof p.calibration !== 'string' || p.calibration.length > 500)) ||
    (p.metresPerUnit !== undefined && (!Number.isFinite(p.metresPerUnit) || p.metresPerUnit <= 0)) ||
    (p.transformId !== undefined && (typeof p.transformId !== 'string' || p.transformId.length > 200))
  )
    throw new Error('Invalid source-analysis preview.');
  if (p.background) {
    const b = p.background;
    if (
      typeof b.pngBase64 !== 'string' ||
      b.pngBase64.length > 6_000_000 ||
      !/^iVBORw0KGgo[A-Za-z0-9+/]*={0,2}$/.test(b.pngBase64) ||
      !Array.isArray(b.bounds) ||
      b.bounds.length !== 4 ||
      !Array.isArray(b.matrix) ||
      b.matrix.length !== 6 ||
      [...b.bounds, ...b.matrix].some(n => !Number.isFinite(n) || Math.abs(n) > 1e12) ||
      b.bounds[2] <= b.bounds[0] ||
      b.bounds[3] <= b.bounds[1]
    )
      throw new Error('Invalid source-analysis background.');
  }
  // Restricted geometry/text only. The component also displays SVG as an inert image, never
  // inserts source markup into the editor DOM. Keep this contract usable without an XML library.
  const tags = p.svg.matchAll(/<\/?([a-zA-Z][\w:-]*)\b/g);
  for (const [, tag] of tags)
    if (!['svg', 'defs', 'clipPath', 'g', 'path', 'text', 'title'].includes(tag))
      throw new Error('Unsupported analysis SVG element.');
  if (/<!|<\?|\s(?:on\w+|(?:xlink:)?href|style)\s*=|url\(\s*[^#]/i.test(p.svg))
    throw new Error('Unsupported analysis SVG content.');
  return p;
}
const key = (sourceId: string) => `${sourceId}:analysis-preview`;
export async function saveAnalysisPreview(assets: AssetRepository, sourceId: string, preview: ImportAnalysisPreview) {
  await assets.put(
    key(sourceId),
    new Blob([JSON.stringify(readAnalysisPreview(preview))], { type: 'application/json' }),
  );
}
export async function loadAnalysisPreview(assets: AssetRepository, sourceId: string) {
  const blob = await assets.get(key(sourceId));
  if (blob) return readAnalysisPreview(JSON.parse(await blob.text()));
}
export const deleteAnalysisPreview = (assets: AssetRepository, sourceId: string) => assets.delete(key(sourceId));

/** Compose only validated local evidence. Render as an inert image, never innerHTML. */
export function analysisPreviewSvg(
  preview: ImportAnalysisPreview,
  hidden: string[] = [],
  showBackground = true,
  opacity = 0.85,
) {
  const allowed = ['wall', 'outline', 'label', 'symbol', 'path'];
  const css = hidden
    .filter(k => allowed.includes(k))
    .map(kind => `g[data-kind="${kind}"]{display:none}`)
    .join('');
  const b = showBackground ? preview.background : undefined;
  const alpha = Number.isFinite(opacity) ? Math.max(0, Math.min(1, opacity)) : 0.85;
  const underlay = b
    ? `<image x="${b.bounds[0]}" y="${b.bounds[1]}" width="${b.bounds[2] - b.bounds[0]}" height="${b.bounds[3] - b.bounds[1]}" transform="matrix(${b.matrix.join(' ')})" preserveAspectRatio="none" href="data:image/png;base64,${b.pngBase64}"/>`
    : '';
  return preview.svg
    .replace(/(<svg\b[^>]*>)/, `$1<style>${css}</style>${underlay}<g opacity="${alpha}">`)
    .replace('</svg>', '</g></svg>');
}
