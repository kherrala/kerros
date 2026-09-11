// Axis-aligned runs: the unit the wall reconstruction works in. A "run" is a maximal straight
// stretch of wall face — an axis ('h' along x, 'v' along y), the cross-axis coordinate it sits at,
// and the interval it covers. Merging collinear fragments into runs, bridging the gaps doors and
// windows punch through a face, is what turns 93 exterior scribbles into four walls.
import type { Point } from '../schema';
import type { PlanEntity } from './types';

export interface FaceSegment {
  axis: 'h' | 'v';
  c: number;
  lo: number;
  hi: number;
}
export interface Run extends FaceSegment {
  /** Bridged gaps big enough to be openings, as [lo, hi] along the run. */
  gaps: [number, number][];
}
export const EPS = 0.02;

/** Axis-aligned LINE/POLYLINE segments on a layer, as face segments. Oblique strokes are ignored —
 *  this importer reads Manhattan drawings. */
export function faceSegments(entities: PlanEntity[], layer: RegExp): FaceSegment[] {
  const out: FaceSegment[] = [];
  const push = (a: Point, b: Point) => {
    if (Math.abs(a[1] - b[1]) < EPS)
      out.push({ axis: 'h', c: (a[1] + b[1]) / 2, lo: Math.min(a[0], b[0]), hi: Math.max(a[0], b[0]) });
    else if (Math.abs(a[0] - b[0]) < EPS)
      out.push({ axis: 'v', c: (a[0] + b[0]) / 2, lo: Math.min(a[1], b[1]), hi: Math.max(a[1], b[1]) });
  };
  for (const e of entities) {
    if (!layer.test(e.layer)) continue;
    if (e.type === 'LINE' && e.a && e.b) push(e.a, e.b);
    if (e.type === 'POLYLINE' && e.points) for (let i = 1; i < e.points.length; i++) push(e.points[i - 1], e.points[i]);
  }
  return out.filter(s => s.hi - s.lo > EPS);
}

/** Merge collinear fragments into runs, bridging gaps up to `bridge` metres. Gaps in the opening
 *  size range are bridged but remembered — they are the doorways and windows. */
export function mergeRuns(segments: FaceSegment[], bridge: number, openingGaps?: [number, number]): Run[] {
  const out: Run[] = [];
  for (const axis of ['h', 'v'] as const) {
    const pool = segments.filter(s => s.axis === axis).sort((x, y) => x.c - y.c || x.lo - y.lo);
    let group: typeof pool = [];
    const flush = () => {
      if (!group.length) return;
      const c = group.reduce((s, g) => s + g.c, 0) / group.length;
      const sorted = [...group].sort((x, y) => x.lo - y.lo);
      let lo = sorted[0].lo,
        hi = sorted[0].hi;
      let gaps: [number, number][] = [];
      const emit = () => out.push({ axis, c, lo, hi, gaps });
      for (const s of sorted.slice(1)) {
        const gap = s.lo - hi;
        if (gap <= EPS) hi = Math.max(hi, s.hi);
        else if (gap <= bridge) {
          if (openingGaps && gap >= openingGaps[0] && gap <= openingGaps[1]) gaps.push([hi, s.lo]);
          hi = Math.max(hi, s.hi);
        } else {
          emit();
          lo = s.lo;
          hi = s.hi;
          gaps = [];
        }
      }
      emit();
    };
    for (const s of pool) {
      if (group.length && Math.abs(s.c - group[0].c) > EPS * 2) {
        flush();
        group = [];
      }
      group.push(s);
    }
    flush();
  }
  return out;
}

/** Every point a layer's geometry touches, sampled densely along strokes and arcs — the raw
 *  material for "is there a door/window symbol standing in this opening?" scoring. */
export function symbolPoints(entities: PlanEntity[], layer: RegExp): Point[] {
  const pts: Point[] = [];
  const sample = (a: Point, b: Point) => {
    const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 0.2));
    for (let i = 0; i <= n; i++) pts.push([a[0] + ((b[0] - a[0]) * i) / n, a[1] + ((b[1] - a[1]) * i) / n]);
  };
  for (const e of entities) {
    if (!layer.test(e.layer)) continue;
    if (e.a && e.b) sample(e.a, e.b);
    if (e.points) for (let i = 1; i < e.points.length; i++) sample(e.points[i - 1], e.points[i]);
    if (e.at) pts.push(e.at);
    if (e.center && e.r) {
      const a0 = ((e.start ?? 0) * Math.PI) / 180;
      const a1 = ((e.end ?? 360) * Math.PI) / 180;
      const n = Math.max(4, Math.ceil((Math.abs(a1 - a0) * e.r) / 0.2));
      for (let i = 0; i <= n; i++) {
        const a = a0 + ((a1 - a0) * i) / n;
        pts.push([e.center[0] + e.r * Math.cos(a), e.center[1] + e.r * Math.sin(a)]);
      }
    }
  }
  return pts;
}
