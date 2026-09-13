// Geometry gestures shared by the editor and the randomized authoring tests.
import {
  addBarrier,
  barrierEnds,
  barrierStrokeIssue,
  centroid,
  closeRing,
  distance,
  intersects,
  objectArea,
  openRing,
  MIN_SEGMENT,
} from './geometry';
import { inSpace } from './spaces';
import { createObject } from './factory';
import { divideSpaces } from './inference';
import type { Point, ProjectDocument, Ring } from './types';
import { transact } from './validate';
import {
  bindSpaceToRegion,
  boundaryEdges,
  boundaryRegionAt,
  derivedSpaceRings,
  normalizeBoundaries,
} from './boundaries';

/** Ignore double-click duplicates; reject a crossing while the last good draft is still editable. */
export function appendAreaPoint(draft: Ring, point: Point): { points: Ring; error?: string } {
  if (!draft.length) return { points: [point] };
  if (distance(draft.at(-1)!, point) < 0.001) return { points: draft };
  for (let i = 0; i + 2 < draft.length; i++)
    if (intersects(draft.at(-1)!, point, draft[i], draft[i + 1]))
      return { points: draft, error: 'That edge crosses the outline. Choose another point, or undo the last point.' };
  return { points: [...draft, point] };
}

/** The wall/partition tool: divide along the endpoints actually used after welding. */
export function drawBarrier(
  project: ProjectDocument,
  floorId: string | null,
  a: Point,
  b: Point,
  kind: 'wall' | 'fence' = 'wall',
) {
  if (distance(a, b) < MIN_SEGMENT - 1e-6) return;
  const issue = barrierStrokeIssue(project, a, b, floorId);
  if (issue) throw new Error(issue);
  const barrier = addBarrier(project, a, b, floorId, kind);
  if (barrier && kind === 'wall') divideSpaces(project, floorId, ...barrierEnds(project, barrier));
  return barrier;
}

/** The enclose tool: creating and re-fitting use exactly the same generated outline. */
export function encloseRoom(project: ProjectDocument, floorId: string | null, point: Point) {
  normalizeBoundaries(project, floorId);
  const region = boundaryRegionAt(project, floorId, point);
  if (!region) return null;
  const ring = region.rings[0];
  const existing = project.objects
    .filter(o => o.floorId === floorId && o.kind === 'room' && inSpace(o, point))
    .sort((a, b) => objectArea(a) - objectArea(b))[0];
  const room = existing ?? createObject('room', centroid(ring), floorId, 'Room');
  const probe = { ...room, geometry: { mode: 'boundaries' as const, loops: region.loops } };
  probe.rings = derivedSpaceRings(project, probe);
  if (!inSpace(probe, point)) return null;
  const key = (loops: import('./types').BoundaryUse[][]) =>
    loops
      .flat()
      .map(u => `${u.edgeId}:${!!u.reversed}`)
      .sort()
      .join('|');
  const same = project.objects.find(
    o => o.geometry?.mode === 'boundaries' && key(o.geometry.loops) === key(region.loops),
  );
  if (same) return { room: same, existing: true };
  bindSpaceToRegion(project, room, region);
  if (!existing) project.objects.push(room);
  return { room, existing: !!existing };
}

export type GeometryDrag =
  | { kind: 'junction'; id: string; point: Point }
  | { kind: 'barrier'; id: string; point: Point }
  | { kind: 'ring'; id: string; point: Point; ringIndex: number; index: number };

/** Keep ordered openings on a resized wall. Move them only as far as necessary to fit;
 *  when their total width cannot fit, validation limits the wall movement instead. */
function fitAttachedOpenings(project: ProjectDocument, changed: Set<string>) {
  for (const barrier of project.barriers) {
    if (!changed.has(barrier.startId) && !changed.has(barrier.endId)) continue;
    const length = distance(...barrierEnds(project, barrier));
    const openings = project.objects
      .filter(o => o.barrierId === barrier.id)
      .sort((a, b) => (a.offset ?? 0) - (b.offset ?? 0));
    let end = length;
    for (const o of [...openings].reverse()) {
      o.offset = Math.min(o.offset ?? 0, end - o.width / 2);
      end = o.offset - o.width / 2;
    }
    let start = 0;
    for (const o of openings) {
      o.offset = Math.max(o.offset ?? 0, start + o.width / 2);
      start = o.offset + o.width / 2;
    }
  }
}

function geometryMutation(project: ProjectDocument, move: GeometryDrag) {
  const deltas = new Map<string, Point>();
  let vertex: Point | undefined;
  if (move.kind === 'junction') {
    const j = project.junctions.find(j => j.id === move.id);
    if (!j) return;
    deltas.set(j.id, [move.point[0] - j.position[0], move.point[1] - j.position[1]]);
  } else if (move.kind === 'barrier') {
    const b = boundaryEdges(project).find(b => b.id === move.id);
    if (!b) return;
    const [a, c] = barrierEnds(project, b);
    const length = distance(a, c);
    const nx = -(c[1] - a[1]) / length,
      ny = (c[0] - a[0]) / length;
    const slide = (move.point[0] - (a[0] + c[0]) / 2) * nx + (move.point[1] - (a[1] + c[1]) / 2) * ny;
    for (const id of [b.startId, b.endId]) deltas.set(id, [nx * slide, ny * slide]);
  } else {
    const ring = project.objects.find(o => o.id === move.id)?.rings?.[move.ringIndex];
    if (project.objects.find(o => o.id === move.id)?.geometry?.mode === 'boundaries') return;
    vertex = ring && openRing(ring)[move.index];
    if (!vertex) return;
  }
  return (draft: ProjectDocument, fraction: number) => {
    for (const j of draft.junctions) {
      const delta = deltas.get(j.id);
      if (delta) j.position = [j.position[0] + delta[0] * fraction, j.position[1] + delta[1] * fraction];
    }
    if (move.kind === 'ring') {
      const o = draft.objects.find(o => o.id === move.id)!;
      const ring = openRing(o.rings![move.ringIndex]);
      ring[move.index] = [
        vertex![0] + (move.point[0] - vertex![0]) * fraction,
        vertex![1] + (move.point[1] - vertex![1]) * fraction,
      ];
      o.rings![move.ringIndex] = closeRing(ring);
      o.position = centroid(o.rings![0]);
    } else {
      fitAttachedOpenings(draft, new Set(deltas.keys()));
    }
  };
}

/** Apply one requested drop to a transaction draft. The editor previews snapping alone and calls
 * this once on release; transact either accepts the entire move or leaves the original intact. */
export function applyGeometryDrag(project: ProjectDocument, move: GeometryDrag) {
  geometryMutation(project, move)?.(project, 1);
}

/** Optional constrained authoring operation for hosts and scripted drawing: find a valid position
 * along a requested movement. Interactive editor drags use applyGeometryDrag on release instead. */
export function dragGeometry(project: ProjectDocument, _floorId: string | null, move: GeometryDrag): ProjectDocument {
  const mutation = geometryMutation(project, move);
  if (!mutation) return project;
  const trial = (fraction: number) => transact(project, draft => mutation(draft, fraction));
  const full = trial(1);
  if (full.ok) return full.project;
  let low = 0,
    high = 1,
    best = project;
  // Eighteen trials resolve even a 100 m gesture to less than a millimetre.
  for (let i = 0; i < 18; i++) {
    const mid = (low + high) / 2;
    const result = trial(mid);
    if (result.ok) {
      low = mid;
      best = result.project;
    } else high = mid;
  }
  return best;
}
