// Wall reconstruction: face runs pair into walls, walls chain into the envelope ring. Pure
// geometry over runs.ts — nothing here touches a ProjectDocument.
import { MIN_SEGMENT } from '../schema';
import type { Point } from '../schema';
import type { Run } from './runs';

export interface Wall {
  axis: 'h' | 'v';
  c: number;
  lo: number;
  hi: number;
  thickness: number;
  gaps: [number, number][];
}

/** Pair opposing face runs into walls: same axis, cross-distance within a wall thickness, intervals
 *  overlapping. The wall sits on the centreline. `gapMode` decides what counts as an opening: for
 *  partitions both faces must break ('both'); for the envelope the silhouette line is often drawn
 *  continuous, so a break in either face counts ('either'). */
export function pairWalls(
  a: Run[],
  b: Run[],
  minT: number,
  maxT: number,
  minOverlap: number,
  gapMode: 'both' | 'either' = 'both',
  /** Wall extent from the pair: 'union' for the envelope (its faces fragment unevenly and corners
   *  are closed afterwards); 'overlap' for partitions — a wall exists only where BOTH faces do,
   *  and taking the union would stretch it over stretches where a lone line means something else. */
  extentMode: 'union' | 'overlap' = 'union',
): Wall[] {
  const walls: Wall[] = [];
  const used = new Set<Run>();
  for (const one of a) {
    if (used.has(one)) continue;
    let best: { other: Run; t: number } | null = null;
    for (const other of b) {
      if (other === one || used.has(other) || other.axis !== one.axis) continue;
      const t = Math.abs(other.c - one.c);
      if (t < minT || t > maxT) continue;
      const overlap = Math.min(one.hi, other.hi) - Math.max(one.lo, other.lo);
      if (overlap < minOverlap) continue;
      if (!best || t < best.t) best = { other, t };
    }
    if (!best) continue;
    used.add(one);
    used.add(best.other);
    const gaps =
      gapMode === 'both'
        ? one.gaps.filter(g => best!.other.gaps.some(h => Math.max(g[0], h[0]) < Math.min(g[1], h[1])))
        : [
            ...one.gaps,
            ...best.other.gaps.filter(h => !one.gaps.some(g => Math.max(g[0], h[0]) < Math.min(g[1], h[1]))),
          ];
    walls.push({
      axis: one.axis,
      c: (one.c + best.other.c) / 2,
      lo: extentMode === 'union' ? Math.min(one.lo, best.other.lo) : Math.max(one.lo, best.other.lo),
      hi: extentMode === 'union' ? Math.max(one.hi, best.other.hi) : Math.min(one.hi, best.other.hi),
      thickness: Math.round(best.t * 1000) / 1000,
      gaps: gaps.map(g => [...g] as [number, number]),
    });
  }
  return mergeSolids(walls);
}

/** Collapse walls whose bodies occupy the same space into one spanning the outermost faces.
 *
 *  Pairing consumes each run once and takes the nearest partner, which is right when a wall is drawn
 *  as exactly two face lines. Some offices draw four — sheathing, both sides of the stud frame, and
 *  the inner lining — and those pair up as two thin walls standing inside each other. Two walls
 *  cannot occupy the same volume, so where the bodies overlap the drawing meant one wall, and its
 *  faces are the outermost lines. On a two-line drawing no two walls overlap and this does nothing. */
function mergeSolids(walls: Wall[]): Wall[] {
  const out: Wall[] = [];
  for (const w of walls) {
    const host = out.find(
      o =>
        o.axis === w.axis &&
        // Bodies intersect across the wall, not merely run near each other.
        Math.abs(o.c - w.c) < (o.thickness + w.thickness) / 2 - 1e-6 &&
        // …and they cover the same stretch along it.
        Math.min(o.hi, w.hi) - Math.max(o.lo, w.lo) > 0,
    );
    if (!host) {
      out.push(w);
      continue;
    }
    const lo = Math.min(host.c - host.thickness / 2, w.c - w.thickness / 2);
    const hi = Math.max(host.c + host.thickness / 2, w.c + w.thickness / 2);
    host.c = (lo + hi) / 2;
    host.thickness = Math.round((hi - lo) * 1000) / 1000;
    host.lo = Math.min(host.lo, w.lo);
    host.hi = Math.max(host.hi, w.hi);
    // An opening is only an opening where both readings agree it is one.
    host.gaps = host.gaps.filter(g => w.gaps.some(h => Math.max(g[0], h[0]) < Math.min(g[1], h[1])));
  }
  return out;
}

export const wallEnds = (w: Wall): [Point, Point] =>
  w.axis === 'h'
    ? [
        [w.lo, w.c],
        [w.hi, w.c],
      ]
    : [
        [w.c, w.lo],
        [w.c, w.hi],
      ];
export const along = (w: Wall, t: number): Point => (w.axis === 'h' ? [t, w.c] : [w.c, t]);

/** Merge an opening gap into a wall, unioning with any gap it overlaps — both faces usually report
 *  the same opening at slightly different extents, and it must become ONE opening. */
export function addGap(w: Wall, gap: [number, number]) {
  const twin = w.gaps.find(g => Math.max(g[0], gap[0]) < Math.min(g[1], gap[1]));
  if (twin) {
    twin[0] = Math.min(twin[0], gap[0]);
    twin[1] = Math.max(twin[1], gap[1]);
  } else w.gaps.push([...gap]);
}

/** Snap wall ends onto the centreline of the perpendicular wall they meet. CAD face lines are
 *  drawn to the crossing wall's far face — or stop at its near one — so raw run extents overshoot
 *  or undershoot T-junctions by half a thickness. Landing exactly on the centreline is what a
 *  hand-drawn wall does in the editor, and it is what lets rendered caps disappear inside the
 *  crossing wall instead of poking past it. */
export function snapEnds(walls: Wall[], targets: Wall[], tolerance = 0.45) {
  for (const w of walls) {
    for (const end of ['lo', 'hi'] as const) {
      const candidates = targets
        .filter(t => t !== w && t.axis !== w.axis && w.c > t.lo - 0.3 && w.c < t.hi + 0.3)
        .map(t => ({ c: t.c, d: Math.abs(t.c - w[end]) }))
        .sort((x, y) => x.d - y.d);
      const near = candidates[0];
      if (!near || near.d > tolerance || near.d < 0.005) continue;
      const next = { ...w, [end]: near.c } as Wall;
      if (next.hi - next.lo > MIN_SEGMENT) w[end] = near.c;
    }
  }
  // An end landing on a wall's centreline welds a junction there and splits the wall (joinAt), so
  // two T-ends closer together than a legal segment — a staggered junction — would leave
  // sub-MIN_SEGMENT debris the document refuses. Retract such an end to the target's near FACE
  // instead: visually flush, hidden under the crossing wall's stroke, but far enough off the
  // centreline that no junction welds.
  for (const t of targets) {
    const tees: { w: Wall; end: 'lo' | 'hi'; at: number }[] = [];
    for (const w of walls) {
      if (w.axis === t.axis || w.c <= t.lo + 0.01 || w.c >= t.hi - 0.01) continue;
      for (const end of ['lo', 'hi'] as const) if (Math.abs(w[end] - t.c) < 0.01) tees.push({ w, end, at: w.c });
    }
    // Retract one end at a time and re-check: a staggered pair needs only ONE of its two ends
    // pulled back to make the junctions legal, and the one to keep welded is the end whose wall
    // has an opening close by — a retracted end eats into the clearance that opening needs.
    const gapNearEnd = (x: (typeof tees)[number]) =>
      x.w.gaps.some(g => Math.min(Math.abs(g[0] - x.w[x.end]), Math.abs(g[1] - x.w[x.end])) < 1);
    const pending = [...tees].sort(
      (x, y) => Number(gapNearEnd(x)) - Number(gapNearEnd(y)) || x.w.thickness - y.w.thickness || y.at - x.at,
    );
    for (const tee of pending) {
      if (Math.abs(tee.w[tee.end] - t.c) > 0.01) continue; // already retracted
      const points = [t.lo, t.hi, ...tees.filter(x => x !== tee && Math.abs(x.w[x.end] - t.c) < 0.01).map(x => x.at)];
      const nearest = Math.min(...points.filter(p => Math.abs(p - tee.at) > 1e-9).map(p => Math.abs(p - tee.at)));
      if (nearest >= MIN_SEGMENT) continue;
      const back = t.thickness / 2 + 0.01;
      const retracted = tee.end === 'lo' ? t.c + back : t.c - back;
      const next = { ...tee.w, [tee.end]: retracted } as Wall;
      if (next.hi - next.lo > MIN_SEGMENT) tee.w[tee.end] = retracted;
    }
  }
}

/** Extend each envelope wall to the centreline of its perpendicular neighbours, closing corners. */
export function closeCorners(envelope: Wall[]) {
  for (const w of envelope) {
    const perpendicular = envelope.filter(o => o.axis !== w.axis);
    for (const end of ['lo', 'hi'] as const) {
      const near = perpendicular.map(o => ({ o, d: Math.abs(o.c - w[end]) })).sort((x, y) => x.d - y.d)[0];
      if (near && near.d < 0.8) w[end] = near.o.c;
    }
  }
}

/** Chain envelope walls into the closed inner-face ring. Each corner is the intersection of two
 *  adjacent walls' INNER faces (centreline offset half a thickness toward the building), so the
 *  plate is the actual floor area, not the wall footprint. Handles L and T footprints; returns
 *  null when the walls do not close into one loop. */
export function traceRing(envelope: Wall[]): Point[] | null {
  if (envelope.length < 4) return null;
  const cx = envelope.reduce((s, w) => s + (w.axis === 'v' ? w.c : (w.lo + w.hi) / 2), 0) / envelope.length;
  const cy = envelope.reduce((s, w) => s + (w.axis === 'h' ? w.c : (w.lo + w.hi) / 2), 0) / envelope.length;
  const innerC = (w: Wall) => {
    const towards = w.axis === 'h' ? Math.sign(cy - w.c) : Math.sign(cx - w.c);
    return w.c + (towards || 1) * (w.thickness / 2);
  };
  // Adjacency: two perpendicular walls meet when each one's centreline lies near an END of the
  // other's interval. Walk the loop by always leaving through the end we did not enter by.
  const meets = (a: Wall, end: number, b: Wall) =>
    Math.abs(b.c - end) < 0.8 && (Math.abs(b.lo - a.c) < 0.8 || Math.abs(b.hi - a.c) < 0.8);
  const unvisited = new Set(envelope);
  let current = envelope[0];
  unvisited.delete(current);
  let exitEnd = current.hi;
  const ring: Point[] = [];
  for (let steps = 0; steps < envelope.length; steps++) {
    const next = [...unvisited]
      .filter(w => w.axis !== current.axis && meets(current, exitEnd, w))
      .sort((x, y) => Math.abs(x.c - exitEnd) - Math.abs(y.c - exitEnd))[0];
    const closes = !next && !unvisited.size && meets(current, exitEnd, envelope[0]);
    const partner = next ?? (closes ? envelope[0] : null);
    if (!partner) return null;
    ring.push(current.axis === 'h' ? [innerC(partner), innerC(current)] : [innerC(current), innerC(partner)]);
    if (!next) break;
    // Enter `next` at the end near the wall we came from; leave through the other one.
    exitEnd = Math.abs(next.lo - current.c) < Math.abs(next.hi - current.c) ? next.hi : next.lo;
    current = next;
    unvisited.delete(current);
  }
  if (unvisited.size || ring.length < 4) return null;
  return ring;
}
