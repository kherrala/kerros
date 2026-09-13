import { distance, footprint, intersects, openRing, pointInRing, segmentProjection } from './geometry';
import type { Point, ProjectDocument, Ring } from './types';

/** Extra room for shoulders and for the route marking, in plan metres. */
export const ROUTE_CLEARANCE = 0.4;
type Bounds = [number, number, number, number];
export const routeBounds = (points: Point[], pad = 0): Bounds => [
  Math.min(...points.map(p => p[0])) - pad,
  Math.min(...points.map(p => p[1])) - pad,
  Math.max(...points.map(p => p[0])) + pad,
  Math.max(...points.map(p => p[1])) + pad,
];
const overlaps = (a: Bounds, b: Bounds) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
const gap = (a: Point, b: Point, c: Point, d: Point) =>
  intersects(a, b, c, d)
    ? 0
    : Math.min(
        segmentProjection(a, c, d).distance,
        segmentProjection(b, c, d).distance,
        segmentProjection(c, a, b).distance,
        segmentProjection(d, a, b).distance,
      );

/** A geometric guard for walking connections. It checks the whole segment, not samples along it.
 * Walls retain their thickness; doors/gates cut their actual apertures. Pools and floor holes are
 * obstacles even when a containing room's outer ring includes them. Build once for a document. */
export function createRouteClearance(project: ProjectDocument) {
  const junctions = new Map(project.junctions.map(j => [j.id, j.position]));
  const openings = new Map<string, [number, number][]>();
  for (const o of project.objects) {
    if (!o.barrierId || (o.kind !== 'door' && o.kind !== 'gate')) continue;
    const ranges = openings.get(o.barrierId) ?? [];
    ranges.push([(o.offset ?? 0) - o.width / 2, (o.offset ?? 0) + o.width / 2]);
    openings.set(o.barrierId, ranges);
  }
  const walls = new Map<string | null, { ring: Ring; bounds: Bounds }[]>();
  for (const wall of project.barriers) {
    const a = junctions.get(wall.startId),
      b = junctions.get(wall.endId);
    if (!a || !b) continue;
    const length = distance(a, b);
    if (!length) continue;
    const at = (d: number): Point => [a[0] + ((b[0] - a[0]) * d) / length, a[1] + ((b[1] - a[1]) * d) / length];
    const parts = walls.get(wall.floorId) ?? [];
    const nx = (((a[1] - b[1]) / length) * wall.thickness) / 2;
    const ny = (((b[0] - a[0]) / length) * wall.thickness) / 2;
    const add = (from: number, to: number) => {
      if (to <= from) return;
      const start = at(from),
        end = at(to);
      const ring: Ring = [
        [start[0] + nx, start[1] + ny],
        [end[0] + nx, end[1] + ny],
        [end[0] - nx, end[1] - ny],
        [start[0] - nx, start[1] - ny],
      ];
      parts.push({ ring, bounds: routeBounds(ring, ROUTE_CLEARANCE) });
    };
    let cursor = 0;
    for (const [from, to] of (openings.get(wall.id) ?? []).sort((a, b) => a[0] - b[0])) {
      add(cursor, Math.min(length, Math.max(0, from)));
      cursor = Math.max(cursor, Math.min(length, to));
    }
    add(cursor, length);
    walls.set(wall.floorId, parts);
  }
  const holes = new Map<string | null, { ring: Ring; bounds: Bounds }[]>();
  for (const o of project.objects) {
    const rings = o.water
      ? footprint(o).slice(0, 1)
      : o.kind === 'room' || o.kind === 'zone'
        ? footprint(o).slice(1)
        : [];
    const parts = holes.get(o.floorId) ?? [];
    for (const ring of rings) parts.push({ ring: openRing(ring), bounds: routeBounds(ring, ROUTE_CLEARANCE) });
    holes.set(o.floorId, parts);
  }
  /** Restrict the obstacle list once per room or query, so graph construction stays local. */
  return (floorId: string | null, extent?: Bounds) => {
    const localWalls = (walls.get(floorId) ?? []).filter(w => !extent || overlaps(extent, w.bounds));
    const localHoles = (holes.get(floorId) ?? []).filter(h => !extent || overlaps(extent, h.bounds));
    const obstacles = [...localWalls, ...localHoles];
    return (a: Point, b: Point): boolean => {
      const bounds = routeBounds([a, b]);
      for (const h of obstacles) {
        if (!overlaps(bounds, h.bounds)) continue;
        if (pointInRing(a, h.ring) || pointInRing(b, h.ring)) return false;
        for (let i = 0; i < h.ring.length; i++)
          if (gap(a, b, h.ring[i], h.ring[(i + 1) % h.ring.length]) < ROUTE_CLEARANCE - 1e-7) return false;
      }
      return true;
    };
  };
}

const cache = new WeakMap<ProjectDocument, ReturnType<typeof createRouteClearance>>();
export function routeClearance(project: ProjectDocument) {
  let check = cache.get(project);
  if (!check) {
    check = createRouteClearance(project);
    cache.set(project, check);
  }
  return check;
}
