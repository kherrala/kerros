// The shared 2D boundary model. Barriers ARE physical edges; only unwalled edges need another record.
// Space loops reference these edges. Coordinates in rings are generated compatibility/render caches.
import polygonClipping from 'polygon-clipping';
import { validateRings } from './validate';
import type { Barrier, BoundaryUse, Point, ProjectDocument, Ring, SiteObject, VirtualBoundary } from './types';
import { isArea, uid } from './types';
import {
  addBarrier,
  centroid,
  closeRing,
  distance,
  footprint,
  openRing,
  pointInRing,
  rectangle,
  removeBarrier,
  ringArea,
  segmentProjection,
} from './geometry';
import {
  CLIP_SCALE,
  GEOMETRY_EPS as EPS,
  MIN_FACE_AREA,
  MIN_RING_EDGE,
  MIN_SPACE_AREA,
  MIN_WALL_LENGTH,
} from './precision';

export type BoundaryEdge = Barrier | VirtualBoundary;
export interface BoundaryRegion {
  loops: BoundaryUse[][];
  /** Centreline polygon, including holes. Net footprints also subtract the physical wall bodies. */
  rings: Ring[];
}
export const boundaryEdges = (p: ProjectDocument): BoundaryEdge[] => [...p.barriers, ...(p.virtualBoundaries ?? [])];
export const followsBoundaries = (o: SiteObject) => o.geometry?.mode === 'boundaries';
const ends = (p: ProjectDocument, e: BoundaryEdge): [Point, Point] => {
  const a = p.junctions.find(j => j.id === e.startId),
    b = p.junctions.find(j => j.id === e.endId);
  if (!a || !b) throw new Error('A space boundary references a missing junction.');
  return [a.position, b.position];
};
const reverse = (loop: BoundaryUse[]) => [...loop].reverse().map(u => ({ edgeId: u.edgeId, reversed: !u.reversed }));
const signedArea = (ring: Ring) =>
  ring.reduce((s, a, i) => {
    const b = ring[(i + 1) % ring.length];
    return s + a[0] * b[1] - b[0] * a[1];
  }, 0) / 2;
const area = (rings: Ring[]) => ringArea(rings[0]) - rings.slice(1).reduce((s, r) => s + ringArea(r), 0);
const totalArea = (polys: Ring[][]) => polys.reduce((s, pg) => s + area(pg), 0);
const quantize = (rings: Ring[]) =>
  rings.map(r =>
    closeRing(r).map(
      q => [Math.round(q[0] * CLIP_SCALE) / CLIP_SCALE, Math.round(q[1] * CLIP_SCALE) / CLIP_SCALE] as Point,
    ),
  );
/** Integer input coordinates avoid binary near-duplicates in the clipper's event queue. The
 * output keeps much finer precision so independently computed shared intersections agree. */
function difference(subject: Ring[], ...clips: Ring[][]): Ring[][] {
  const scaled = (rings: Ring[]) =>
    rings.map(r => closeRing(r).map(q => [Math.round(q[0] * CLIP_SCALE), Math.round(q[1] * CLIP_SCALE)] as Point));
  const input = scaled(subject),
    operands = clips.map(scaled);
  let result: Ring[][];
  try {
    result = polygonClipping.difference(input, ...operands) as Ring[][];
  } catch {
    // An equivalent Boolean evaluation avoids a clipper event-queue failure with many nearly
    // coincident wall corners. Do not quantize intermediate results or discard failed polygons.
    result = [input];
    for (const operand of operands) {
      if (!result.length) break;
      result = polygonClipping.difference(result, operand) as Ring[][];
    }
  }
  return result.map(pg =>
    pg.map(r =>
      r.map(
        q => [Math.round((q[0] / CLIP_SCALE) * 1e10) / 1e10, Math.round((q[1] / CLIP_SCALE) * 1e10) / 1e10] as Point,
      ),
    ),
  );
}

/** Keep every reference correct when a physical/virtual edge is split or replaced. */
export function replaceBoundaryUses(p: ProjectDocument, edgeId: string, replacement: BoundaryUse[]) {
  for (const o of p.objects)
    if (o.geometry?.mode === 'boundaries')
      o.geometry.loops = o.geometry.loops.map(loop =>
        loop.flatMap(u => (u.edgeId !== edgeId ? [u] : u.reversed ? reverse(replacement) : replacement)),
      );
}

export function boundaryRings(p: ProjectDocument, loops: BoundaryUse[][], floorId: string | null): Ring[] {
  const edges = new Map(boundaryEdges(p).map(e => [e.id, e]));
  return loops.map(loop => {
    if (loop.length < 3) throw new Error('A space boundary must form a closed loop.');
    const ring: Ring = [];
    for (let i = 0; i < loop.length; i++) {
      const u = loop[i],
        next = loop[(i + 1) % loop.length];
      const e = edges.get(u.edgeId),
        n = edges.get(next.edgeId);
      if (!e || !n || e.floorId !== floorId || n.floorId !== floorId)
        throw new Error('A space boundary references a missing edge or another floor.');
      if ((u.reversed ? e.startId : e.endId) !== (next.reversed ? n.endId : n.startId))
        throw new Error('Space boundary edges must share their junctions in order.');
      ring.push(ends(p, e)[u.reversed ? 1 : 0]);
    }
    return closeRing(ring);
  });
}

function splitEdge(p: ProjectDocument, edge: BoundaryEdge, cuts: { t: number; id: string }[]) {
  const [a, b] = ends(p, edge),
    length = distance(a, b);
  const interior = cuts.filter(c => c.t > EPS / length && c.t < 1 - EPS / length).sort((x, y) => x.t - y.t);
  const unique = interior.filter((c, i) => i === 0 || c.id !== interior[i - 1].id);
  if (!unique.length) return;
  const stops = [{ t: 0, id: edge.startId }, ...unique, { t: 1, id: edge.endId }];
  const openings = p.objects.filter(o => o.barrierId === edge.id);
  for (const c of unique)
    for (const o of openings)
      if (Math.abs((o.offset ?? 0) - c.t * length) < o.width / 2 - EPS)
        throw new Error('A junction cannot split an opening.');
  const physical = 'kind' in edge;
  const pieces = stops.slice(1).map((end, i) => {
    const start = stops[i];
    if ((end.t - start.t) * length < (physical ? MIN_WALL_LENGTH : MIN_RING_EDGE) - EPS)
      throw new Error('That crossing would leave a boundary segment too short.');
    return { ...edge, id: i === 0 ? edge.id : uid(), startId: start.id, endId: end.id };
  });
  for (const o of openings) {
    const at = (o.offset ?? 0) / length;
    const i = stops.slice(1).findIndex(s => at <= s.t + EPS);
    o.barrierId = pieces[i].id;
    o.offset = (o.offset ?? 0) - stops[i].t * length;
  }
  replaceBoundaryUses(
    p,
    edge.id,
    pieces.map(e => ({ edgeId: e.id })),
  );
  Object.assign(edge, pieces[0]);
  if (physical) p.barriers.push(...(pieces.slice(1) as Barrier[]));
  else (p.virtualBoundaries ??= []).push(...pieces.slice(1));
}

/** Planarize a floor: one junction at each intersection, with overlaps represented once.
 * Exact calculated intersections are shared; the input grid is not applied again here. */
export function normalizeBoundaries(p: ProjectDocument, floorId: string | null) {
  const edges = boundaryEdges(p).filter(e => e.floorId === floorId);
  const junctions = p.junctions.filter(j => j.floorId === floorId);
  const canonical = new Map<string, string>();
  const representatives: typeof junctions = [];
  for (const j of junctions) {
    const earlier = representatives.find(k => distance(k.position, j.position) <= EPS);
    if (earlier) canonical.set(j.id, earlier.id);
    else representatives.push(j);
  }
  for (const e of edges) {
    e.startId = canonical.get(e.startId) ?? e.startId;
    e.endId = canonical.get(e.endId) ?? e.endId;
  }
  p.junctions = p.junctions.filter(j => !canonical.has(j.id));
  const positions = new Map(p.junctions.map(j => [j.id, j.position]));
  // Resolve endpoints once, before the broad-phase pair scan. Looking each one up in the
  // full junction list inside the nested loop made planarization cubic in floor size.
  const spans = edges.map(e => ({
    points: [positions.get(e.startId)!, positions.get(e.endId)!] as [Point, Point],
    box: bounds([positions.get(e.startId)!, positions.get(e.endId)!]),
  }));
  const cuts = new Map<string, { t: number; id: string }[]>();
  const cut = (e: BoundaryEdge, at: Point) => {
    const [a, b] = ends(p, e),
      hit = segmentProjection(at, a, b);
    let j = p.junctions.find(j => j.floorId === floorId && distance(j.position, at) <= EPS);
    if (!j) {
      j = { id: uid(), floorId, position: at };
      p.junctions.push(j);
    }
    const list = cuts.get(e.id) ?? [];
    list.push({ t: hit.t, id: j.id });
    cuts.set(e.id, list);
  };
  for (let i = 0; i < edges.length; i++)
    for (let k = i + 1; k < edges.length; k++) {
      if (!boundsMeet(spans[i].box, spans[k].box)) continue;
      const one = edges[i],
        two = edges[k],
        [a, b] = spans[i].points,
        [c, d] = spans[k].points;
      const ux = b[0] - a[0],
        uy = b[1] - a[1],
        vx = d[0] - c[0],
        vy = d[1] - c[1];
      const det = ux * vy - uy * vx;
      if (Math.abs(det) > 1e-12 * Math.hypot(ux, uy) * Math.hypot(vx, vy)) {
        const t = ((c[0] - a[0]) * vy - (c[1] - a[1]) * vx) / det;
        const s = ((c[0] - a[0]) * uy - (c[1] - a[1]) * ux) / det;
        if (
          t >= -EPS / Math.hypot(ux, uy) &&
          t <= 1 + EPS / Math.hypot(ux, uy) &&
          s >= -EPS / Math.hypot(vx, vy) &&
          s <= 1 + EPS / Math.hypot(vx, vy)
        ) {
          const at: Point = [a[0] + Math.max(0, Math.min(1, t)) * ux, a[1] + Math.max(0, Math.min(1, t)) * uy];
          cut(one, at);
          cut(two, at);
        }
      } else {
        for (const at of [a, b])
          if (segmentProjection(at, c, d).distance <= EPS) {
            cut(one, at);
            cut(two, at);
          }
        for (const at of [c, d])
          if (segmentProjection(at, a, b).distance <= EPS) {
            cut(one, at);
            cut(two, at);
          }
      }
    }
  for (const e of edges) splitEdge(p, e, cuts.get(e.id) ?? []);
  // Physical edges precede virtual ones, so drawing a wall on a virtual division builds that wall.
  const byEnds = new Map<string, BoundaryEdge>();
  const removed = new Set<string>();
  for (const e of boundaryEdges(p).filter(e => e.floorId === floorId)) {
    const key = [e.startId, e.endId].sort().join('|'),
      kept = byEnds.get(key);
    if (!kept) {
      byEnds.set(key, e);
      continue;
    }
    const flipped = e.startId !== kept.startId;
    replaceBoundaryUses(p, e.id, [{ edgeId: kept.id, reversed: flipped }]);
    for (const o of p.objects.filter(o => o.barrierId === e.id)) {
      o.barrierId = kept.id;
      if (flipped) {
        o.offset = distance(...ends(p, kept)) - (o.offset ?? 0);
        if (o.kind === 'door') {
          o.doorHinge = o.doorHinge === 'right' ? 'left' : 'right';
          o.doorSwing = o.doorSwing === -1 ? 1 : -1;
        }
      }
    }
    removed.add(e.id);
  }
  p.barriers = p.barriers.filter(e => !removed.has(e.id));
  if (p.virtualBoundaries) p.virtualBoundaries = p.virtualBoundaries.filter(e => !removed.has(e.id));
  const used = new Set(boundaryEdges(p).flatMap(e => [e.startId, e.endId]));
  p.junctions = p.junctions.filter(j => !canonical.has(j.id) || used.has(j.id));
}

/** Bounded faces of the shared graph. Bridges do not divide a face; nested components form holes. */
export function boundaryRegions(p: ProjectDocument, floorId: string | null): BoundaryRegion[] {
  const edges = boundaryEdges(p).filter(e => e.floorId === floorId);
  const outgoing = new Map<string, { edge: BoundaryEdge; to: string }[]>();
  for (const e of edges)
    for (const [a, b] of [
      [e.startId, e.endId],
      [e.endId, e.startId],
    ]) {
      const list = outgoing.get(a) ?? [];
      list.push({ edge: e, to: b });
      outgoing.set(a, list);
    }
  const entered = new Map<string, number>(),
    low = new Map<string, number>(),
    bridges = new Set<string>();
  let time = 0;
  const visit = (at: string, parent?: string) => {
    entered.set(at, ++time);
    low.set(at, time);
    for (const { edge, to } of outgoing.get(at) ?? []) {
      if (edge.id === parent) continue;
      if (!entered.has(to)) {
        visit(to, edge.id);
        low.set(at, Math.min(low.get(at)!, low.get(to)!));
        if (low.get(to)! > entered.get(at)!) bridges.add(edge.id);
      } else low.set(at, Math.min(low.get(at)!, entered.get(to)!));
    }
  };
  for (const at of outgoing.keys()) if (!entered.has(at)) visit(at);
  const positions = new Map(p.junctions.map(j => [j.id, j.position]));
  for (const [at, list] of outgoing) {
    const a = positions.get(at)!;
    outgoing.set(
      at,
      list
        .filter(x => !bridges.has(x.edge.id))
        .sort((x, y) => {
          const b = positions.get(x.to)!,
            c = positions.get(y.to)!;
          return Math.atan2(b[1] - a[1], b[0] - a[0]) - Math.atan2(c[1] - a[1], c[0] - a[0]);
        }),
    );
  }
  const seen = new Set<string>(),
    cycles: { loop: BoundaryUse[]; ring: Ring }[] = [];
  for (const e of edges.filter(e => !bridges.has(e.id)))
    for (const reversed of [false, true]) {
      let use: BoundaryUse = { edgeId: e.id, reversed },
        current = e;
      const first = `${e.id}:${reversed}`,
        loop: BoundaryUse[] = [],
        ring: Ring = [];
      if (seen.has(first)) continue;
      for (let step = 0; step <= edges.length * 2; step++) {
        const key = `${use.edgeId}:${!!use.reversed}`;
        if (seen.has(key)) break;
        seen.add(key);
        loop.push(use);
        const from = use.reversed ? current.endId : current.startId,
          to = use.reversed ? current.startId : current.endId;
        ring.push(positions.get(from)!);
        const list = outgoing.get(to)!;
        const back = list.findIndex(x => x.edge.id === current.id);
        const next = list[(back + list.length - 1) % list.length];
        current = next.edge;
        use = { edgeId: current.id, reversed: current.endId === to };
        if (`${use.edgeId}:${!!use.reversed}` === first) break;
      }
      if (signedArea(ring) >= MIN_FACE_AREA) cycles.push({ loop, ring: closeRing(ring) });
    }
  const parent = cycles.map(
    (child, i) =>
      cycles
        .map((candidate, j) => ({ j, candidate }))
        .filter(
          ({ candidate, j }) =>
            j !== i &&
            ringArea(candidate.ring) > ringArea(child.ring) + EPS &&
            child.ring.every(q => pointInRing(q, candidate.ring)) &&
            !child.loop.some(u => candidate.loop.some(v => v.edgeId === u.edgeId)),
        )
        .sort((a, b) => ringArea(a.candidate.ring) - ringArea(b.candidate.ring))[0]?.j,
  );
  return cycles.map((c, i) => {
    const holes = cycles.filter((_, j) => parent[j] === i);
    return {
      loops: [c.loop, ...holes.map(h => reverse(h.loop))],
      rings: [c.ring, ...holes.map(h => closeRing([...openRing(h.ring)].reverse()))],
    };
  });
}

function wallBodies(p: ProjectDocument, floorId: string | null): Ring[][] {
  // Subdividing a straight wall must not change its swept body through separate rounding at
  // each new endpoint. Reconstitute collinear runs for clipping, retaining the individual IDs.
  const positions = new Map(p.junctions.map(j => [j.id, j.position]));
  const runs = p.barriers
    .filter(b => b.floorId === floorId)
    .map(b => ({
      points: [positions.get(b.startId)!, positions.get(b.endId)!] as [Point, Point],
      thickness: b.thickness,
    }));
  for (let i = 0; i < runs.length; i++) {
    let merged = true;
    while (merged) {
      merged = false;
      for (let k = i + 1; k < runs.length; k++) {
        const one = runs[i],
          two = runs[k];
        if (one.thickness !== two.thickness) continue;
        const [a, b] = one.points,
          [c, d] = two.points;
        const ab = distance(a, b),
          cd = distance(c, d);
        if (Math.abs((b[0] - a[0]) * (d[1] - c[1]) - (b[1] - a[1]) * (d[0] - c[0])) > EPS * ab * cd) continue;
        const pair = [
          [a, c, b, d],
          [a, d, b, c],
          [b, c, a, d],
          [b, d, a, c],
        ].find(([x, y]) => distance(x, y) <= EPS);
        if (!pair) continue;
        one.points = [pair[2], pair[3]];
        runs.splice(k, 1);
        merged = true;
        break;
      }
    }
  }
  return runs.map(({ points: [a, c], thickness }) => {
    // Canonical orientation makes reversed strokes use exactly the same clipping coordinates.
    if (a[0] > c[0] || (a[0] === c[0] && a[1] > c[1])) [a, c] = [c, a];
    const len = distance(a, c);
    return quantize([
      rectangle(
        [(a[0] + c[0]) / 2, (a[1] + c[1]) / 2],
        len + thickness,
        thickness,
        (Math.atan2(c[1] - a[1], c[0] - a[0]) * 180) / Math.PI,
      ),
    ]);
  });
}
function tidy(ring: Ring): Ring {
  const out: Ring = [];
  for (const q of openRing(ring)) if (!out.length || distance(out.at(-1)!, q) >= EPS) out.push(q);
  if (out.length > 1 && distance(out[0], out.at(-1)!) < EPS) out.pop();
  return closeRing(out);
}
type Bounds = { minX: number; minY: number; maxX: number; maxY: number };
const bounds = (ring: Ring): Bounds => {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const [x, y] of ring) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return { minX, minY, maxX, maxY };
};
const boundsMeet = (a: Bounds, b: Bounds) =>
  a.minX <= b.maxX + EPS && a.maxX + EPS >= b.minX && a.minY <= b.maxY + EPS && a.maxY + EPS >= b.minY;

/** Short-lived evaluation scope: coordinates are fixed during one refresh/validation pass. Reuse
 * wall bodies across its spaces, without caching a mutable transaction draft between edits. */
function netEvaluator(p: ProjectDocument) {
  const floors = new Map<string | null, { rings: Ring[]; box: Bounds }[]>();
  return (floorId: string | null, rings: Ring[], allowEmpty = false): Ring[] => {
    let solids = floors.get(floorId);
    if (!solids) {
      solids = wallBodies(p, floorId).map(rings => ({ rings, box: bounds(rings[0]) }));
      floors.set(floorId, solids);
    }
    const box = bounds(rings[0]);
    const nearby = solids.filter(s => boundsMeet(s.box, box)).map(s => s.rings);
    return netRings(rings, nearby, allowEmpty);
  };
}
function netRings(rings: Ring[], solids: Ring[][], allowEmpty = false): Ring[] {
  const pieces = solids.length ? difference(rings, ...solids) : [quantize(rings)];
  const usable = pieces.filter(pg => area(pg) >= MIN_SPACE_AREA);
  if (!usable.length && allowEmpty) return [];
  if (!usable.length)
    throw new Error(
      `A space needs at least ${MIN_SPACE_AREA} m² of usable area. Largest region after subtracting walls: ${Math.max(0, ...pieces.map(pg => area(pg))).toFixed(3)} m².`,
    );
  if (usable.length !== 1)
    throw new Error(
      `The wall would leave ${usable.length} disconnected usable regions (${usable.map(pg => area(pg).toFixed(2)).join(', ')} m²). Extend it to a boundary to divide the space.`,
    );
  return usable[0].map(tidy);
}
export function derivedSpaceRings(p: ProjectDocument, o: SiteObject): Ring[] {
  if (o.geometry?.mode !== 'boundaries') return footprint(o);
  return netEvaluator(p)(o.floorId, boundaryRings(p, o.geometry.loops, o.floorId));
}
function cacheRings(o: SiteObject, rings: Ring[]) {
  o.rings = rings;
  o.position = centroid(rings[0]);
  o.rotation = 0;
  const xs = rings[0].map(q => q[0]),
    ys = rings[0].map(q => q[1]);
  o.width = Math.max(...xs) - Math.min(...xs);
  o.depth = Math.max(...ys) - Math.min(...ys);
}

export function bindSpaceToRegion(p: ProjectDocument, o: SiteObject, region: BoundaryRegion) {
  if (!isArea(o.kind)) throw new Error('Only a drawn area can use shared boundaries.');
  o.geometry = { mode: 'boundaries', loops: structuredClone(region.loops) };
  cacheRings(o, derivedSpaceRings(p, o));
}
export function boundaryRegionAt(p: ProjectDocument, floorId: string | null, point: Point): BoundaryRegion | null {
  return (
    boundaryRegions(p, floorId)
      .filter(r => pointInRing(point, r.rings[0]) && !r.rings.slice(1).some(h => pointInRing(point, h)))
      .sort((a, b) => area(a.rings) - area(b.rings))[0] ?? null
  );
}

function junctionAt(p: ProjectDocument, floorId: string | null, point: Point): string {
  const existing = p.junctions.find(j => j.floorId === floorId && distance(j.position, point) <= EPS);
  if (existing) return existing.id;
  const id = uid();
  p.junctions.push({ id, floorId, position: point });
  return id;
}
export function addVirtualBoundary(p: ProjectDocument, floorId: string | null, a: Point, b: Point): string {
  if (distance(a, b) < MIN_RING_EDGE) throw new Error('A space boundary is too short.');
  const startId = junctionAt(p, floorId, a),
    endId = junctionAt(p, floorId, b);
  const existing = boundaryEdges(p).find(
    e =>
      e.floorId === floorId &&
      ((e.startId === startId && e.endId === endId) || (e.startId === endId && e.endId === startId)),
  );
  if (existing) return existing.id;
  const id = uid();
  (p.virtualBoundaries ??= []).push({ id, floorId, startId, endId });
  return id;
}

/** The drawing tool intentionally opens any collinear wall span. Ordinary addVirtualBoundary
 * remains non-destructive for generated space outlines and model normalization. */
export function drawVirtualBoundary(p: ProjectDocument, floorId: string | null, a: Point, b: Point): string {
  const length = distance(a, b);
  if (length < MIN_RING_EDGE) throw new Error('A space boundary is too short.');
  const onLine = (q: Point) => Math.abs((b[0] - a[0]) * (q[1] - a[1]) - (b[1] - a[1]) * (q[0] - a[0])) / length <= EPS;
  for (const wall of [...p.barriers].filter(w => w.floorId === floorId)) {
    const [start, end] = ends(p, wall);
    if (!onLine(start) || !onLine(end)) continue;
    const cuts = [a, b].flatMap(q => {
      const hit = segmentProjection(q, start, end);
      return hit.distance <= EPS && hit.t > 0 && hit.t < 1 ? [{ t: hit.t, id: junctionAt(p, floorId, hit.point) }] : [];
    });
    splitEdge(p, wall, cuts);
  }
  for (const wall of [...p.barriers].filter(w => w.floorId === floorId)) {
    if (!ends(p, wall).every(q => segmentProjection(q, a, b).distance <= EPS)) continue;
    // Retain the edge identity and room loops, even when no room has claimed it yet.
    (p.virtualBoundaries ??= []).push({ id: wall.id, floorId, startId: wall.startId, endId: wall.endId });
    removeBarrier(p, wall.id);
  }
  return addVirtualBoundary(p, floorId, a, b);
}

/** Explicit conversion: retain the drawn shape with shared virtual edges, or adopt its enclosing
 * walls on request. Legacy documents remain independent until this operation is chosen. */
export function connectSpace(p: ProjectDocument, objectId: string, source: 'outline' | 'walls' = 'outline') {
  const o = p.objects.find(o => o.id === objectId);
  if (!o || !isArea(o.kind)) throw new Error('Select an area to connect to boundaries.');
  if (source === 'walls') {
    normalizeBoundaries(p, o.floorId);
    // A concave outline's label position can lie outside it. An explicit adoption uses the
    // region containing the greatest part of its footprint, and refuses ambiguous choices.
    const sourceRings = footprint(o),
      sourceArea = area(sourceRings);
    const candidates = boundaryRegions(p, o.floorId)
      .map(region => ({
        region,
        overlap: sourceArea - totalArea(difference(sourceRings, region.rings)),
      }))
      .filter(c => c.overlap > EPS)
      .sort((a, b) => b.overlap - a.overlap);
    if (candidates.length > 1 && Math.abs(candidates[0].overlap - candidates[1].overlap) < EPS)
      throw new Error('More than one region matches this outline. Use Space from walls inside the intended region.');
    const region = candidates[0]?.region;
    if (!region) throw new Error('No closed wall boundary surrounds this space.');
    bindSpaceToRegion(p, o, region);
    return;
  }
  const loops = footprint(o).map((ring, ri) => {
    let points = openRing(ring);
    if (signedArea(points) > 0 !== (ri === 0)) points = [...points].reverse();
    return points.map((a, i) => {
      const b = points[(i + 1) % points.length],
        edgeId = addVirtualBoundary(p, o.floorId, a, b);
      const e = boundaryEdges(p).find(e => e.id === edgeId)!;
      return { edgeId, reversed: distance(ends(p, e)[0], a) > EPS };
    });
  });
  o.geometry = { mode: 'boundaries', loops };
  normalizeBoundaries(p, o.floorId);
  cacheRings(o, derivedSpaceRings(p, o));
}
export function disconnectSpace(p: ProjectDocument, objectId: string) {
  const o = p.objects.find(o => o.id === objectId);
  if (o) o.geometry = { mode: 'independent' };
}

export function addBoundaryHole(p: ProjectDocument, o: SiteObject, ring: Ring) {
  if (o.geometry?.mode !== 'boundaries') throw new Error('Select a space with shared boundaries.');
  let points = openRing(ring);
  if (signedArea(points) > 0) points = [...points].reverse();
  const loop = points.map((a, i) => {
    const edgeId = addVirtualBoundary(p, o.floorId, a, points[(i + 1) % points.length]);
    const e = boundaryEdges(p).find(e => e.id === edgeId)!;
    return { edgeId, reversed: distance(ends(p, e)[0], a) > EPS };
  });
  o.geometry.loops.push(loop);
}

export function splitBoundarySpace(p: ProjectDocument, o: SiteObject, a: Point, b: Point, wall = true): string {
  if (o.geometry?.mode !== 'boundaries') throw new Error('This space has no shared boundaries.');
  const length = distance(a, b);
  if (length < EPS) throw new Error('Draw a line across the space.');
  const dx = (b[0] - a[0]) / length,
    dy = (b[1] - a[1]) / length;
  const hits: number[] = [];
  for (const closed of boundaryRings(p, o.geometry.loops, o.floorId)) {
    const r = openRing(closed);
    for (let i = 0; i < r.length; i++) {
      const c = r[i],
        d = r[(i + 1) % r.length],
        ex = d[0] - c[0],
        ey = d[1] - c[1];
      const det = dx * ey - dy * ex;
      if (Math.abs(det) < 1e-12) continue;
      const t = ((c[0] - a[0]) * dy - (c[1] - a[1]) * dx) / det;
      if (t >= -EPS && t <= 1 + EPS) hits.push(((c[0] - a[0]) * ey - (c[1] - a[1]) * ex) / det);
    }
  }
  hits.sort((x, y) => x - y);
  const unique = hits.filter((x, i) => i === 0 || x - hits[i - 1] > EPS);
  for (let i = 0; i + 1 < unique.length; i += 2) {
    const start: Point = [a[0] + unique[i] * dx, a[1] + unique[i] * dy];
    const end: Point = [a[0] + unique[i + 1] * dx, a[1] + unique[i + 1] * dy];
    if (wall) {
      const edge = addBarrier(p, start, end, o.floorId, 'wall');
      if (edge) {
        edge.name = 'Partition';
        edge.thickness = 0.18;
      }
    } else addVirtualBoundary(p, o.floorId, start, end);
  }
  normalizeBoundaries(p, o.floorId);
  const created = refreshBoundarySpaces(p);
  if (!created.length) throw new Error('The cut must divide the space into usable regions.');
  return created[0];
}

/** Join centreline loops before deriving the net footprint, including the former wall's floor area. */
export function mergeBoundaryGeometry(p: ProjectDocument, keep: SiteObject, absorbed: SiteObject): boolean {
  if (keep.geometry?.mode !== 'boundaries' || absorbed.geometry?.mode !== 'boundaries')
    throw new Error('Connect both spaces to shared boundaries before merging their boundaries.');
  const a = keep.geometry.loops.flat(),
    b = absorbed.geometry.loops.flat();
  const shared = new Set(
    a.filter(u => b.some(v => v.edgeId === u.edgeId && !!v.reversed !== !!u.reversed)).map(u => u.edgeId),
  );
  if (!shared.size) return false;
  if (p.barriers.some(e => shared.has(e.id))) throw new Error('Remove the dividing wall before merging these spaces.');
  const edges = new Map(boundaryEdges(p).map(e => [e.id, e]));
  const remaining = [...a, ...b].filter(u => !shared.has(u.edgeId));
  const loops: BoundaryUse[][] = [];
  while (remaining.length) {
    const loop = [remaining.shift()!];
    const first = edges.get(loop[0].edgeId)!;
    const start = loop[0].reversed ? first.endId : first.startId;
    let at = loop[0].reversed ? first.startId : first.endId;
    while (at !== start) {
      const index = remaining.findIndex(u => {
        const e = edges.get(u.edgeId)!;
        return (u.reversed ? e.endId : e.startId) === at;
      });
      if (index < 0) throw new Error('The merged space boundary is not closed.');
      const u = remaining.splice(index, 1)[0],
        e = edges.get(u.edgeId)!;
      loop.push(u);
      at = u.reversed ? e.startId : e.endId;
    }
    loops.push(loop);
  }
  loops.sort(
    (a, b) =>
      signedArea(openRing(boundaryRings(p, [b], keep.floorId)[0])) -
      signedArea(openRing(boundaryRings(p, [a], keep.floorId)[0])),
  );
  keep.geometry = { mode: 'boundaries', loops };
  p.virtualBoundaries = (p.virtualBoundaries ?? []).filter(
    e =>
      !shared.has(e.id) ||
      p.objects.some(
        o =>
          o.id !== absorbed.id &&
          o.geometry?.mode === 'boundaries' &&
          o.geometry.loops.some(l => l.some(u => u.edgeId === e.id)),
      ),
  );
  cacheRings(keep, derivedSpaceRings(p, keep));
  return true;
}

/** A removed wall leaves the semantic division as a virtual boundary. */
export function preserveBoundary(p: ProjectDocument, edge: BoundaryEdge) {
  if (
    !p.objects.some(
      o => o.geometry?.mode === 'boundaries' && o.geometry.loops.some(l => l.some(u => u.edgeId === edge.id)),
    )
  )
    return;
  if (!(p.virtualBoundaries ?? []).some(e => e.id === edge.id))
    (p.virtualBoundaries ??= []).push({ id: edge.id, floorId: edge.floorId, startId: edge.startId, endId: edge.endId });
}

/** Regenerate by explicit loops, subdividing identities only when a new boundary divides a space.
 * No old/new footprint-overlap matching is involved in ordinary wall movements. */
export function refreshBoundarySpaces(p: ProjectDocument, topologyChanged?: Set<string | null>): string[] {
  const created: string[] = [],
    regions = new Map<string | null, BoundaryRegion[]>();
  const net = netEvaluator(p);
  for (const o of [...p.objects]) {
    if (o.geometry?.mode !== 'boundaries') continue;
    const envelope = boundaryRings(p, o.geometry.loops, o.floorId);
    // Moving a vertex changes the shape of a face, not its identity. Only a changed edge graph
    // needs face discovery and polygon containment against every other region on the floor.
    if (topologyChanged && !topologyChanged.has(o.floorId)) {
      cacheRings(o, net(o.floorId, envelope));
      continue;
    }
    if (!regions.has(o.floorId)) regions.set(o.floorId, boundaryRegions(p, o.floorId));
    const inside = regions.get(o.floorId)!.filter(r => totalArea(difference(r.rings, envelope)) < EPS);
    if (!inside.length) throw new Error('The space boundaries no longer form a closed region.');
    inside.sort((a, b) => area(b.rings) - area(a.rings));
    // Interior walls can eliminate a tiny region, but a labelled space must never disappear silently.
    const usable = inside
      .map(r => ({ region: r, rings: net(o.floorId, r.rings, inside.length > 1) }))
      .filter(r => r.rings.length)
      .sort((a, b) => area(b.rings) - area(a.rings));
    if (!usable.length) throw new Error('The walls would remove all usable area from this space.');
    for (let i = 0; i < usable.length; i++) {
      const target = i === 0 ? o : { ...structuredClone(o), id: uid(), name: `${o.name} ${i + 1}`, feedId: undefined };
      target.geometry = { mode: 'boundaries', loops: structuredClone(usable[i].region.loops) };
      cacheRings(target, usable[i].rings);
      if (i > 0) {
        p.objects.push(target);
        created.push(target.id);
        for (const z of p.zones ?? []) if (z.spaceIds.includes(o.id)) z.spaceIds.push(target.id);
      }
    }
  }
  return created;
}

/** One synchronization gate for UI gestures, host mutations, history and persistence. */
export function synchronizeGeometry(before: ProjectDocument, p: ProjectDocument) {
  // A host may install the frozen result of another transaction in its draft (e.g. a constrained
  // drag). Thaw those collections before the normalization pass, without touching its input.
  for (const key of ['barriers', 'junctions', 'objects', 'virtualBoundaries', 'zones'] as const) {
    const collection = p[key];
    if (collection && (Object.isFrozen(collection) || collection.some(e => Object.isFrozen(e))))
      Object.assign(p, { [key]: structuredClone(collection) });
  }
  const edges = boundaryEdges(p),
    ids = new Set(edges.map(e => e.id));
  for (const e of boundaryEdges(before))
    if (!ids.has(e.id)) {
      preserveBoundary(p, e);
      if ((p.virtualBoundaries ?? []).some(v => v.id === e.id))
        for (const id of [e.startId, e.endId]) {
          if (!p.junctions.some(j => j.id === id)) {
            const old = before.junctions.find(j => j.id === id);
            if (old) p.junctions.push(structuredClone(old));
          }
        }
    }
  const signature = (doc: ProjectDocument, floor: string | null) =>
    JSON.stringify([
      boundaryEdges(doc)
        .filter(e => e.floorId === floor)
        .map(e => [e.id, e.startId, e.endId]),
      doc.junctions.filter(j => j.floorId === floor).map(j => [j.id, j.position]),
    ]);
  const floors = new Set(boundaryEdges(p).map(e => e.floorId));
  for (const floor of floors) if (signature(before, floor) !== signature(p, floor)) normalizeBoundaries(p, floor);
  const topology = (doc: ProjectDocument, floor: string | null) =>
    JSON.stringify(
      boundaryEdges(doc)
        .filter(e => e.floorId === floor)
        .map(e => [e.id, e.startId, e.endId]),
    );
  const changed = new Set([...floors].filter(floor => topology(before, floor) !== topology(p, floor)));
  refreshBoundarySpaces(p, changed);
}

/** Validate the explicit topology and its cache. Independent polygons retain their existing rules. */
export function validateSpaceBoundaries(p: ProjectDocument) {
  const occupied = new Set<string>();
  const faces = new Map<string | null, Set<string>>();
  const net = netEvaluator(p);
  const loopKey = (loops: BoundaryUse[][]) =>
    loops
      .flat()
      .map(u => `${u.edgeId}:${!!u.reversed}`)
      .sort()
      .join('|');
  for (const o of p.objects) {
    if (o.geometry === undefined) continue;
    if (!o.geometry || !['independent', 'boundaries'].includes(o.geometry.mode))
      throw new Error('Unknown space geometry mode.');
    if (o.geometry.mode === 'independent') continue;
    if (
      !isArea(o.kind) ||
      !Array.isArray(o.geometry.loops) ||
      !o.geometry.loops.length ||
      o.geometry.loops.some(
        l =>
          !Array.isArray(l) ||
          l.some(
            u => !u || typeof u.edgeId !== 'string' || (u.reversed !== undefined && typeof u.reversed !== 'boolean'),
          ),
      )
    )
      throw new Error('Malformed space boundary loops.');
    const rings = boundaryRings(p, o.geometry.loops, o.floorId);
    const issue = validateRings(rings, EPS, MIN_FACE_AREA);
    if (issue) throw new Error(issue);
    if (signedArea(openRing(rings[0])) <= 0 || rings.slice(1).some(r => signedArea(openRing(r)) >= 0))
      throw new Error('Space boundary loops must keep the space on their left.');
    if (!faces.has(o.floorId)) faces.set(o.floorId, new Set(boundaryRegions(p, o.floorId).map(r => loopKey(r.loops))));
    if (!faces.get(o.floorId)!.has(loopKey(o.geometry.loops)))
      throw new Error('A connected space must follow one face of the boundary network.');
    for (const loop of o.geometry.loops)
      for (const u of loop) {
        const key = `${u.edgeId}:${!!u.reversed}`;
        if (occupied.has(key)) throw new Error('Two spaces cannot occupy the same side of a shared boundary.');
        occupied.add(key);
      }
    const calculated = net(o.floorId, rings);
    if (
      !o.rings ||
      calculated.length !== o.rings.length ||
      calculated.some(
        (r, ri) => r.length !== o.rings![ri].length || r.some((q, i) => distance(q, o.rings![ri][i]) > EPS),
      )
    )
      throw new Error('The space footprint is stale. Update it through a geometry transaction.');
    const xs = calculated[0].map(q => q[0]),
      ys = calculated[0].map(q => q[1]);
    if (
      distance(o.position, centroid(calculated[0])) > EPS ||
      Math.abs(o.width - (Math.max(...xs) - Math.min(...xs))) > EPS ||
      Math.abs(o.depth - (Math.max(...ys) - Math.min(...ys))) > EPS ||
      o.rotation !== 0
    )
      throw new Error('A boundary-driven space has stale calculated dimensions.');
  }
}
