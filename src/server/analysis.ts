import { calibrateImport, type ImportBrief } from '../import/brief';
import type { RasterEvidence } from './rasterAnalysis';

export const CANDIDATE_KINDS = ['path', 'label', 'clip', 'image-region', 'wall', 'outline', 'symbol'] as const;

export type VectorPoint = [number, number];
export type VectorBounds = [number, number, number, number];
export type VectorCommand =
  | ['M' | 'L', number, number]
  | ['C', number, number, number, number, number, number]
  | ['Q', number, number, number, number]
  | ['Z'];
export interface SourceCandidate {
  id: string;
  kind: (typeof CANDIDATE_KINDS)[number];
  /** Original source coordinates. Detected walls/outlines are proposals, never committed geometry. */
  path: VectorCommand[];
  bounds: VectorBounds;
  text?: string;
  layer?: string;
  strokeWidth?: number;
  stroke?: string;
  fill?: string;
  fillRule?: 'evenodd' | 'nonzero';
  clipIds?: string[];
  evidence: string;
  uncertainty?: string;
  /** Heuristic support, NOT a calibrated probability. */
  score?: number;
  /** Estimated wall thickness in the same units as path. */
  thickness?: number;
  evidenceIds?: string[];
}
export interface SourceAnalysis {
  version: 1;
  id: string;
  sourceHash: string;
  page: number;
  sourceKind: 'cad' | 'pdf' | 'image';
  units: 'm' | 'pt' | 'px';
  axis: 'y-up' | 'y-down';
  bounds: VectorBounds;
  candidates: SourceCandidate[];
  warnings: string[];
  raster?: RasterEvidence;
}
export interface SourceTransform {
  id: string;
  artifactId: string;
  matrix: [number, number, number, number, number, number];
  metresPerUnit: number;
  referenceIds: string[];
  basis: string;
}
export interface CandidateQuery {
  ids?: string[];
  kind?: SourceCandidate['kind'];
  bbox?: VectorBounds;
  cursor?: string;
  limit?: number;
  format?: 'json' | 'svg';
  minScore?: number;
}
export const ANALYSIS_MAX_CANDIDATES = 20_000;
export const ANALYSIS_MAX_BYTES = 8 * 1024 * 1024;
export const ANALYSIS_RESULT_CHARS = 12_000;
const round = (n: number) => Math.round(n * 1e6) / 1e6;
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 1e12;
const idPattern = /^[a-zA-Z0-9:_-]{1,160}$/;
export const vectorPoint = (m: number[], p: VectorPoint): VectorPoint => [
  round(m[0] * p[0] + m[2] * p[1] + m[4]),
  round(m[1] * p[0] + m[3] * p[1] + m[5]),
];
export const vectorPath = (path: VectorCommand[], m: number[]): VectorCommand[] =>
  path.map(command => {
    const result: (string | number)[] = [command[0]];
    for (let i = 1; i < command.length; i += 2)
      result.push(...vectorPoint(m, [command[i] as number, command[i + 1] as number]));
    return result as VectorCommand;
  });
/** Control-point bounds are conservative for curves; never use them as a measured curved outline. */
export function vectorBounds(path: VectorCommand[]): VectorBounds {
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const c of path)
    for (let i = 1; i < c.length; i += 2) {
      const x = c[i] as number,
        y = c[i + 1] as number;
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
    }
  return x0 === Infinity ? [0, 0, 0, 0] : [x0, y0, x1, y1];
}
export function validateSourceAnalysis(value: unknown): SourceAnalysis {
  const a = value as SourceAnalysis;
  if (
    !a ||
    a.version !== 1 ||
    typeof a.id !== 'string' ||
    !idPattern.test(a.id) ||
    !/^[a-f0-9]{64}$/.test(a.sourceHash) ||
    !Number.isInteger(a.page) ||
    a.page < 1 ||
    !['cad', 'pdf', 'image'].includes(a.sourceKind) ||
    !['m', 'pt', 'px'].includes(a.units) ||
    !['y-up', 'y-down'].includes(a.axis)
  )
    throw new Error('Invalid source analysis metadata.');
  const bounds = (b: unknown): b is VectorBounds =>
    Array.isArray(b) && b.length === 4 && b.every(finite) && b[2] >= b[0] && b[3] >= b[1];
  if (
    !bounds(a.bounds) ||
    !Array.isArray(a.warnings) ||
    a.warnings.length > 100 ||
    a.warnings.some(w => typeof w !== 'string' || w.length > 1000) ||
    !Array.isArray(a.candidates) ||
    a.candidates.length > ANALYSIS_MAX_CANDIDATES
  )
    throw new Error('Invalid or oversized source analysis.');
  const ids = new Set<string>();
  let commands = 0;
  for (const c of a.candidates) {
    if (
      !c ||
      typeof c.id !== 'string' ||
      !idPattern.test(c.id) ||
      ids.has(c.id) ||
      !CANDIDATE_KINDS.includes(c.kind) ||
      !bounds(c.bounds) ||
      !Array.isArray(c.path) ||
      !c.path.length
    )
      throw new Error('Invalid source candidate.');
    ids.add(c.id);
    for (const p of c.path)
      if (!Array.isArray(p) || p.length !== ({ M: 3, L: 3, C: 7, Q: 5, Z: 1 }[p[0]] ?? -1) || !p.slice(1).every(finite))
        throw new Error('Invalid vector path.');
    commands += c.path.length;
    if (commands > 200_000) throw new Error('Source analysis contains too many path commands.');
    for (const key of ['text', 'layer', 'stroke', 'fill', 'evidence', 'uncertainty'] as const)
      if (c[key] !== undefined && (typeof c[key] !== 'string' || c[key]!.length > 2000))
        throw new Error('Invalid candidate text.');
    if (
      typeof c.evidence !== 'string' ||
      (c.strokeWidth !== undefined && (!finite(c.strokeWidth) || c.strokeWidth < 0))
    )
      throw new Error('Invalid candidate evidence or width.');
    if (
      (c.score !== undefined && (!finite(c.score) || c.score < 0 || c.score > 1)) ||
      (c.thickness !== undefined && (!finite(c.thickness) || c.thickness <= 0)) ||
      (c.evidenceIds !== undefined &&
        (!Array.isArray(c.evidenceIds) ||
          c.evidenceIds.length > 32 ||
          c.evidenceIds.some(id => typeof id !== 'string')))
    )
      throw new Error('Invalid detection evidence.');
    if (c.fillRule !== undefined && !['evenodd', 'nonzero'].includes(c.fillRule)) throw new Error('Invalid fill rule.');
    if (
      c.clipIds !== undefined &&
      (!Array.isArray(c.clipIds) || c.clipIds.length > 32 || c.clipIds.some(id => typeof id !== 'string'))
    )
      throw new Error('Invalid clip references.');
  }
  const clips = new Set(a.candidates.filter(c => c.kind === 'clip').map(c => c.id));
  for (const c of a.candidates)
    if (c.clipIds?.some(id => !clips.has(id)) || c.evidenceIds?.some(id => !ids.has(id) || id === c.id))
      throw new Error('Missing candidate or clipping evidence.');
  if (a.raster) {
    const r = a.raster;
    if (
      !bounds(r.region) ||
      !Number.isInteger(r.width) ||
      !Number.isInteger(r.height) ||
      r.width < 16 ||
      r.height < 16 ||
      r.width > 2400 ||
      r.height > 2400 ||
      typeof r.engine !== 'string' ||
      r.engine.length > 100 ||
      !['clean', 'scan'].includes(r.profile) ||
      typeof r.ocr !== 'boolean' ||
      !Array.isArray(r.rasterToSource) ||
      r.rasterToSource.length !== 6 ||
      !r.rasterToSource.every(finite) ||
      r.rasterToSource[0] * r.rasterToSource[3] - r.rasterToSource[1] * r.rasterToSource[2] <= 0 ||
      !Array.isArray(r.mainAxes) ||
      r.mainAxes.length > 4 ||
      r.mainAxes.some(axis => !finite(axis.degrees) || !finite(axis.score) || axis.score < 0 || axis.score > 1)
    )
      throw new Error('Invalid raster analysis metadata.');
    if (r.symbol && (!bounds(r.symbol.bounds) || typeof r.symbol.label !== 'string' || r.symbol.label.length > 60))
      throw new Error('Invalid symbol exemplar metadata.');
  }
  if (new TextEncoder().encode(JSON.stringify(a)).byteLength > ANALYSIS_MAX_BYTES)
    throw new Error('Source analysis exceeds its storage limit.');
  return a;
}

export function analysisSummary(a: SourceAnalysis) {
  return {
    artifactId: a.id,
    page: a.page,
    units: a.units,
    axis: a.axis,
    bounds: a.bounds,
    counts: Object.fromEntries(CANDIDATE_KINDS.map(kind => [kind, a.candidates.filter(c => c.kind === kind).length])),
    warnings: a.warnings,
    ...(a.raster ? { raster: a.raster } : {}),
    interpretation:
      'Source evidence only. Detected walls/outlines need interpretation; scores are heuristics. Query labels, outlines and walls before raw paths. Confirm exterior references before calibration.',
  };
}

/** Select actual extracted reference geometry; page margins and model-invented source measurements are not accepted. */
export function calibrateSource(
  a: SourceAnalysis,
  brief: ImportBrief | undefined,
  input: { referenceIds: string[]; origin?: VectorPoint; rotationDegrees?: number; realLengthMetres?: number },
  revision = 1,
): SourceTransform {
  if (!Array.isArray(input.referenceIds) || !input.referenceIds.length || input.referenceIds.length > 100)
    throw new Error('Select 1–100 reference candidate IDs.');
  const selected = [...new Set(input.referenceIds)].map(id => {
    const c = a.candidates.find(c => c.id === id);
    if (
      !c ||
      !['path', 'wall', 'outline'].includes(c.kind) ||
      c.clipIds?.length ||
      c.path.some(p => p[0] === 'C' || p[0] === 'Q')
    )
      throw new Error(
        `Reference ${id} must be an unclipped straight path. Curved/clipped extents need a measured reference instead.`,
      );
    if (
      c.bounds[0] < a.bounds[0] ||
      c.bounds[1] < a.bounds[1] ||
      c.bounds[2] > a.bounds[2] ||
      c.bounds[3] > a.bounds[3]
    )
      throw new Error('Reference extends outside the visible source page.');
    return c;
  });
  const rotation = input.rotationDegrees ?? 0;
  if (!finite(rotation)) throw new Error('Rotation must be a finite angle.');
  const angle = (-rotation * Math.PI) / 180,
    cos = Math.cos(angle),
    sin = Math.sin(angle),
    flip = a.axis === 'y-down' ? -1 : 1;
  const orient = [cos, sin, -sin * flip, cos * flip, 0, 0];
  const paths = selected.map(c => vectorPath(c.path, orient));
  const box = vectorBounds(paths.flat());
  let area: number | undefined;
  if (brief?.footprintAreaM2) {
    if (paths.length !== 1 || paths[0].filter(c => c[0] === 'M').length !== 1 || paths[0].at(-1)?.[0] !== 'Z')
      throw new Error('Area calibration requires one closed exterior outline, without holes or multiple subpaths.');
    const points = paths[0].filter((c): c is ['M' | 'L', number, number] => c[0] === 'M' || c[0] === 'L');
    area =
      Math.abs(
        points.reduce((sum, p, i) => {
          const q = points[(i + 1) % points.length];
          return sum + p[1] * q[2] - q[1] * p[2];
        }, 0),
      ) / 2;
  }
  const hasBriefScale = !!(brief?.widthMetres || brief?.depthMetres || brief?.footprintAreaM2);
  const line = paths[0];
  if (
    !hasBriefScale &&
    a.units !== 'm' &&
    (paths.length !== 1 || line.length !== 2 || line[0][0] !== 'M' || line[1][0] !== 'L')
  )
    throw new Error('Printed-length calibration requires a single straight reference segment.');
  const length =
    line.length === 2
      ? Math.hypot(Number(line[1][1]) - Number(line[0][1]), Number(line[1][2]) - Number(line[0][2]))
      : 0;
  const basis = `Extracted references ${selected.map(c => c.id).join(', ')}; ${rotation}° main axis in source y-up coordinates.`;
  const scale =
    !hasBriefScale && a.units === 'm'
      ? 1
      : calibrateImport(
          {
            drawingWidth: box[2] - box[0],
            drawingDepth: box[3] - box[1],
            drawingArea: area,
            drawingLength: length,
            realLengthMetres: input.realLengthMetres,
            basis: basis.slice(0, 500),
          },
          brief,
        ).metresPerUnit;
  if (!finite(scale) || scale <= 0) throw new Error('Reference produced an invalid scale.');
  const origin = input.origin ?? [a.bounds[0], a.axis === 'y-down' ? a.bounds[3] : a.bounds[1]];
  if (!Array.isArray(origin) || origin.length !== 2 || !origin.every(finite))
    throw new Error('Origin must be two finite source coordinates.');
  const m = orient.map(n => n * scale);
  m[4] = -m[0] * origin[0] - m[2] * origin[1];
  m[5] = -m[1] * origin[0] - m[3] * origin[1];
  return {
    id: `${a.id}:t${revision}`,
    artifactId: a.id,
    matrix: m as SourceTransform['matrix'],
    metresPerUnit: scale,
    referenceIds: selected.map(c => c.id),
    basis,
  };
}

const escape = (s: string) =>
  s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!);
const pathText = (path: VectorCommand[]) => path.map(c => c.join(' ')).join(' ');
const color = (s: string | undefined, fallback: string) => (s && /^#[a-f\d]{3,8}$/i.test(s) ? s : fallback);
/** Restricted SVG: generated paths and escaped text only, never source XML, scripts or external resources. */
export function analysisSvg(a: SourceAnalysis, candidates = a.candidates, transform?: SourceTransform): string {
  if (transform && transform.artifactId !== a.id) throw new Error('Transform belongs to a different source.');
  const matrix = transform?.matrix ?? [1, 0, 0, 1, 0, 0];
  const frame = vectorPath(
    [
      ['M', a.bounds[0], a.bounds[1]],
      ['L', a.bounds[2], a.bounds[1]],
      ['L', a.bounds[2], a.bounds[3]],
      ['L', a.bounds[0], a.bounds[3]],
      ['Z'],
    ],
    matrix,
  );
  const converted = candidates.filter(c => c.kind !== 'clip').map(c => ({ ...c, path: vectorPath(c.path, matrix) }));
  const b = vectorBounds(candidates === a.candidates || !converted.length ? frame : converted.flatMap(c => c.path));
  const width = Math.max(1e-6, b[2] - b[0]),
    height = Math.max(1e-6, b[3] - b[1]);
  const yUp = !!transform || a.axis === 'y-up';
  const requiredClips = new Set(converted.flatMap(c => c.clipIds ?? []));
  const defs = a.candidates
    .filter(c => requiredClips.has(c.id))
    .map(
      c =>
        `<clipPath id="${escape(c.id)}" clipPathUnits="userSpaceOnUse"><path d="${pathText(vectorPath(c.path, matrix))}" clip-rule="${c.fillRule ?? 'nonzero'}"/></clipPath>`,
    )
    .join('');
  const body = converted
    .map(c => {
      let element =
        c.kind === 'label'
          ? `<text transform="translate(${c.path[0][1]} ${c.path[0][2]})${yUp ? ' scale(1 -1)' : ''}" font-size="${Math.max(width / 200, (c.strokeWidth ?? 1) * (transform?.metresPerUnit ?? 1))}" fill="#526070">${escape(c.text ?? '')}</text>`
          : `<path d="${pathText(c.path)}" fill="${color(c.fill, 'none')}" fill-rule="${c.fillRule ?? 'nonzero'}" stroke="${color(c.stroke, c.fill ? 'none' : '#526070')}" stroke-width="${Math.max(width / 2000, (c.strokeWidth ?? 0) * (transform?.metresPerUnit ?? 1))}"/>`;
      for (const id of c.clipIds ?? []) element = `<g clip-path="url(#${escape(id)})">${element}</g>`;
      return `<g data-id="${escape(c.id)}" data-kind="${c.kind}" data-layer="${escape(c.layer ?? 'source')}"><title>${escape(c.id + (c.uncertainty ? ': ' + c.uncertainty : ''))}</title>${element}</g>`;
    })
    .join('');
  const pageClip = `viewport-${a.id}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${b[0]} ${yUp ? -b[3] : b[1]} ${width} ${height}" data-units="${transform ? 'm' : a.units}" data-axis="${yUp ? 'y-up' : 'y-down'}"><defs>${defs}<clipPath id="${pageClip}"><path d="${pathText(frame)}"/></clipPath></defs><g${yUp ? ' transform="scale(1 -1)"' : ''}><g clip-path="url(#${pageClip})">${body}</g></g></svg>`;
}

export function queryCandidates(a: SourceAnalysis, query: CandidateQuery = {}, transform?: SourceTransform) {
  if (transform && transform.artifactId !== a.id) throw new Error('Transform belongs to a different source.');
  if (query.kind !== undefined && !CANDIDATE_KINDS.includes(query.kind)) throw new Error('Unknown candidate kind.');
  if (query.minScore !== undefined && (!finite(query.minScore) || query.minScore < 0 || query.minScore > 1))
    throw new Error('Minimum score must be between 0 and 1.');
  if (query.format !== undefined && !['json', 'svg'].includes(query.format)) throw new Error('Choose json or svg.');
  if (
    query.ids !== undefined &&
    (!Array.isArray(query.ids) ||
      query.ids.length > 100 ||
      query.ids.some(id => typeof id !== 'string' || !a.candidates.some(c => c.id === id)))
  )
    throw new Error('Query contains unknown or too many candidate IDs.');
  const box = query.bbox;
  if (box && (!Array.isArray(box) || box.length !== 4 || !box.every(finite) || box[2] < box[0] || box[3] < box[1]))
    throw new Error('Invalid query bounding box.');
  const limit = query.limit ?? 25;
  if (!Number.isInteger(limit) || limit < 1 || limit > 25) throw new Error('Use a limit between 1 and 25.');
  // Cursor binds to the exact filter and transform. Do not silently paginate a different query.
  const key = JSON.stringify([
    a.id,
    transform?.id ?? null,
    query.kind ?? null,
    query.ids ?? null,
    box ?? null,
    query.format ?? 'json',
    query.minScore ?? null,
  ]);
  let offset = 0;
  if (query.cursor) {
    let cursor: unknown;
    try {
      cursor = JSON.parse(query.cursor);
    } catch {
      throw new Error('Invalid candidate cursor.');
    }
    if (!Array.isArray(cursor) || cursor[0] !== key || !Number.isInteger(cursor[1]) || cursor[1] < 0)
      throw new Error('Cursor does not match this source, transform or query.');
    offset = cursor[1];
  }
  const rows = a.candidates
    .filter(
      c =>
        (!query.kind || c.kind === query.kind) &&
        (!query.ids || query.ids.includes(c.id)) &&
        (query.minScore === undefined || (c.score !== undefined && c.score >= query.minScore)),
    )
    .map(c => {
      const path = transform ? vectorPath(c.path, transform.matrix) : c.path;
      return {
        ...c,
        path,
        bounds: vectorBounds(path),
        ...(transform && c.thickness !== undefined ? { thickness: round(c.thickness * transform.metresPerUnit) } : {}),
        ...(transform && c.strokeWidth !== undefined
          ? { strokeWidth: round(c.strokeWidth * transform.metresPerUnit) }
          : {}),
      };
    })
    .filter(
      c => !box || (c.bounds[0] <= box[2] && c.bounds[2] >= box[0] && c.bounds[1] <= box[3] && c.bounds[3] >= box[1]),
    );
  if (offset > rows.length) throw new Error('Candidate cursor is out of range.');
  let page = rows.slice(offset, offset + limit);
  const result = () => ({
    artifactId: a.id,
    transformId: transform?.id ?? null,
    units: transform ? 'm' : a.units,
    axis: transform ? 'y-up' : a.axis,
    total: rows.length,
    nextCursor: offset + page.length < rows.length ? JSON.stringify([key, offset + page.length]) : null,
    ...(query.format === 'svg'
      ? {
          svg: analysisSvg(
            a,
            a.candidates.filter(c => page.some(p => p.id === c.id)),
            transform,
          ),
        }
      : { candidates: page }),
  });
  while (page.length > 1 && JSON.stringify(result()).length > ANALYSIS_RESULT_CHARS) page = page.slice(0, -1);
  if (JSON.stringify(result()).length > ANALYSIS_RESULT_CHARS)
    throw new Error('This candidate exceeds the text limit. Query a smaller source region or inspect it visually.');
  return result();
}
