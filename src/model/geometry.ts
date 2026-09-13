import polygonClipping from 'polygon-clipping';
import type {
  Barrier,
  Drawing,
  Origin,
  Point,
  ProjectDocument,
  Ring,
  SiteObject,
  Slope,
  VirtualBoundary,
} from './types';
import { uid } from './types';
import { boundaryEdges, preserveBoundary, replaceBoundaryUses, splitBoundarySpace } from './boundaries';
import { GEOMETRY_EPS, JOIN_EPS, MIN_RING_EDGE, MIN_SPACE_AREA, MIN_WALL_LENGTH } from './precision';

export const distance = (a: Point, b: Point) => Math.hypot(a[0] - b[0], a[1] - b[1]);
export const rotate = (p: Point, degrees: number): Point => {
  const r = (degrees * Math.PI) / 180;
  return [p[0] * Math.cos(r) - p[1] * Math.sin(r), p[0] * Math.sin(r) + p[1] * Math.cos(r)];
};
// Local planar frame via an ellipsoidal local-tangent-plane around the origin's lng/lat — accurate to
// sub-centimetre at building scale with no projection library and no region assumption. `origin` is
// [lng, lat, bearing?]; origin[2] is the site bearing (clockwise from true north), so a plan can align
// to a real street grid while its coordinates stay simple and axis-aligned.
const DEG = Math.PI / 180,
  WGS84_A = 6378137,
  WGS84_E2 = 0.00669437999014;
const metresPerDegree = (lat: number) => {
  const s = Math.sin(lat * DEG) ** 2;
  return {
    lng: DEG * (WGS84_A / Math.sqrt(1 - WGS84_E2 * s)) * Math.cos(lat * DEG),
    lat: (DEG * (WGS84_A * (1 - WGS84_E2))) / (1 - WGS84_E2 * s) ** 1.5,
  };
};
export const geoOrigin = (lngLat: Point, bearing = 0): Origin =>
  bearing ? [lngLat[0], lngLat[1], bearing] : [lngLat[0], lngLat[1]];
/** Shift a site anchor by a distance on the ground, in metres east and north.
 *
 *  Nudging a building into place is a thing you do in metres — "half a metre that way" — and the
 *  anchor is stored in degrees, where the useful step depends on latitude and differs between the
 *  two axes. Deliberately NOT rotated by the site bearing: this moves the site across the world,
 *  and the directions that make sense for that are the compass ones, not the plan's own grid. */
export const moveOrigin = (origin: Origin, east: number, north: number): Origin => {
  const m = metresPerDegree(origin[1]);
  const moved: Origin = [origin[0] + east / m.lng, origin[1] + north / m.lat];
  return origin[2] ? [moved[0], moved[1], origin[2]] : moved;
};
export const toLocal = (lngLat: Point, origin: Origin): Point => {
  const m = metresPerDegree(origin[1]);
  const d: Point = [(lngLat[0] - origin[0]) * m.lng, (lngLat[1] - origin[1]) * m.lat];
  return origin[2] ? rotate(d, origin[2]) : d;
};
export const toLngLat = (p: Point, origin: Origin): Point => {
  const m = metresPerDegree(origin[1]);
  const r = origin[2] ? rotate(p, -origin[2]) : p;
  return [origin[0] + r[0] / m.lng, origin[1] + r[1] / m.lat];
};
export const add = (a: Point, b: Point): Point => [a[0] + b[0], a[1] + b[1]];
export const closeRing = (ring: Ring): Ring =>
  !ring.length ? [] : distance(ring[0], ring[ring.length - 1]) < 1e-8 ? ring : [...ring, ring[0]];
export const openRing = (ring: Ring): Ring =>
  ring.length > 1 && distance(ring[0], ring[ring.length - 1]) < 1e-8 ? ring.slice(0, -1) : ring;
export const ringArea = (ring: Ring) =>
  Math.abs(
    ring.reduce((sum, p, i) => {
      const q = ring[(i + 1) % ring.length];
      return sum + p[0] * q[1] - q[0] * p[1];
    }, 0),
  ) / 2;
export const objectArea = (object: SiteObject) =>
  object.rings
    ? ringArea(object.rings[0]) - object.rings.slice(1).reduce((sum, r) => sum + ringArea(r), 0)
    : object.width * object.depth;
export const centroid = (ring: Ring): Point => {
  const points = openRing(ring);
  return [points.reduce((s, p) => s + p[0], 0) / points.length, points.reduce((s, p) => s + p[1], 0) / points.length];
};
export const rectangle = (center: Point, width: number, depth: number, rotation = 0): Ring =>
  closeRing(
    (
      [
        [-width / 2, -depth / 2],
        [width / 2, -depth / 2],
        [width / 2, depth / 2],
        [-width / 2, depth / 2],
      ] as Point[]
    ).map(p => add(center, rotate(p, rotation))),
  );
/** Do the two open segments cross? Used for line of sight: a wall between two points blocks it.
 *  Touching at an endpoint does not count — walls meet at shared junctions, and a sightline grazing
 *  such a corner is not obstructed by it. */
export function segmentsCross(a: Point, b: Point, c: Point, d: Point): boolean {
  const side = (p: Point, q: Point, r: Point) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const [s1, s2, s3, s4] = [side(a, b, c), side(a, b, d), side(c, d, a), side(c, d, b)];
  const EPS = 1e-9;
  return ((s1 > EPS && s2 < -EPS) || (s1 < -EPS && s2 > EPS)) && ((s3 > EPS && s4 < -EPS) || (s3 < -EPS && s4 > EPS));
}
export function segmentProjection(p: Point, a: Point, b: Point) {
  const length = distance(a, b);
  const t = length
    ? Math.max(0, Math.min(1, ((p[0] - a[0]) * (b[0] - a[0]) + (p[1] - a[1]) * (b[1] - a[1])) / length ** 2))
    : 0;
  const point: Point = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  return { point, t, distance: distance(p, point), length };
}
/** Elevation of a sloped area at a point: project onto the slope axis and lerp high → low. Points
 * beyond either end clamp, so a footprint wider than its axis keeps flat aprons at both ends. */
export function slopeElevation(slope: Slope, point: Point): number {
  const { t } = segmentProjection(point, slope.axis[0], slope.axis[1]);
  return slope.high + (slope.low - slope.high) * t;
}
/** The ground an object covers. Most areas carry an explicit outline; anything placed by size falls
 *  back to the rectangle its width, depth and rotation describe. One definition, so the model and the
 *  renderer cannot disagree about where a thing is. */
export const footprint = (o: SiteObject): Ring[] => o.rings ?? [rectangle(o.position, o.width, o.depth, o.rotation)];
// Store array indices, not coordinates: transaction drafts move/replace junctions in place. Verify
// each hit so same-length splices and reordering cannot leave the rendering or snapping cache stale.
const junctionIndices = new WeakMap<ProjectDocument['junctions'], { length: number; ids: Map<string, number> }>();
function indexedJunction(junctions: ProjectDocument['junctions'], id: string) {
  let index = junctionIndices.get(junctions);
  const position = index?.ids.get(id);
  if (!index || index.length !== junctions.length || position === undefined || junctions[position]?.id !== id) {
    const ids = new Map<string, number>();
    junctions.forEach((j, i) => {
      if (!ids.has(j.id)) ids.set(j.id, i);
    });
    index = { length: junctions.length, ids };
    junctionIndices.set(junctions, index);
  }
  const at = index.ids.get(id);
  return at === undefined ? undefined : junctions[at];
}
export function barrierEnds(project: ProjectDocument, barrier: Barrier | VirtualBoundary): [Point, Point] {
  return [
    indexedJunction(project.junctions, barrier.startId)!.position,
    indexedJunction(project.junctions, barrier.endId)!.position,
  ];
}
export function objectPosition(project: ProjectDocument, object: SiteObject): Point {
  const barrier = project.barriers.find(b => b.id === object.barrierId);
  if (!barrier) return object.position;
  const [a, b] = barrierEnds(project, barrier);
  const l = distance(a, b);
  const t = l ? (object.offset ?? l / 2) / l : 0;
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}
export function objectRotation(project: ProjectDocument, object: SiteObject) {
  const barrier = project.barriers.find(b => b.id === object.barrierId);
  if (!barrier) return object.rotation;
  const [a, b] = barrierEnds(project, barrier);
  return (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI;
}
export function pointInRing(point: Point, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i],
      b = ring[j];
    if (a[1] > point[1] !== b[1] > point[1] && point[0] < ((b[0] - a[0]) * (point[1] - a[1])) / (b[1] - a[1]) + a[0])
      inside = !inside;
  }
  return inside;
}
const cross = (a: Point, b: Point, c: Point) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
/** Whether segments a–b and c–d cross or touch, endpoints included. */
export function intersects(a: Point, b: Point, c: Point, d: Point) {
  const on = (p: Point, x: Point, y: Point) =>
    Math.abs(cross(x, y, p)) < 1e-8 * distance(x, y) &&
    p[0] >= Math.min(x[0], y[0]) - 1e-8 &&
    p[0] <= Math.max(x[0], y[0]) + 1e-8 &&
    p[1] >= Math.min(x[1], y[1]) - 1e-8 &&
    p[1] <= Math.max(x[1], y[1]) + 1e-8;
  return (
    (cross(a, b, c) * cross(a, b, d) < 0 && cross(c, d, a) * cross(c, d, b) < 0) ||
    on(c, a, b) ||
    on(d, a, b) ||
    on(a, c, d) ||
    on(b, c, d)
  );
}
// Ring and relationship validation moved to validate.ts — the validity layer stands on its own.
export function containedBy(child: Ring[], parent: Ring[]): boolean {
  try {
    return polygonClipping.difference(child, parent).every(p => ringArea(p[0] as Ring) < 0.001);
  } catch {
    return false;
  }
}
export function snapPoint(
  project: ProjectDocument,
  floorId: string | null,
  point: Point,
  tolerance: number,
  previous?: Point,
  grid = true,
  /** Direction the segment from `previous` is held to, with its 15° multiples. Default 0 is the site
   *  grid; pass `referenceAxis(...).angle` to hold to the building or to a neighbouring wall instead. */
  axis = 0,
): { point: Point; label: string } {
  let best = tolerance,
    result: Point | null = null,
    label = '';
  let junctionScore = 1;
  const degrees = new Map<string, number>();
  for (const b of boundaryEdges(project))
    for (const id of [b.startId, b.endId]) degrees.set(id, (degrees.get(id) ?? 0) + 1);
  for (const junction of project.junctions.filter(j => j.floorId === floorId)) {
    const d = distance(point, junction.position);
    const degree = degrees.get(junction.id) ?? 0;
    // A T junction attracts the fourth branch before a projection onto an adjacent wall can
    // create a second, almost coincident T. All four branches reuse the same junction identity.
    const score = d / (tolerance * (degree >= 3 ? 1.5 : 1));
    if (score < junctionScore) {
      junctionScore = score;
      result = junction.position;
      label = degree >= 3 ? 'Junction' : 'Endpoint';
    }
  }
  if (result) return { point: result, label };
  const angleLabel = (quarter: number) => {
    const turn = Math.round(quarter * 45);
    const acute = turn > 90 ? 180 - turn : turn;
    return acute === 0 ? 'Parallel' : acute === 90 ? 'Square' : `${acute}°`;
  };
  const held = previous && holdAngle(previous, point, axis, tolerance);
  if (held && previous) {
    const dx = held.point[0] - previous[0],
      dy = held.point[1] - previous[1];
    for (const barrier of boundaryEdges(project).filter(b => b.floorId === floorId)) {
      const [a, b] = barrierEnds(project, barrier);
      const ex = b[0] - a[0],
        ey = b[1] - a[1];
      const denom = dx * ey - dy * ex;
      if (Math.abs(denom) < 1e-9) continue;
      const ax = a[0] - previous[0],
        ay = a[1] - previous[1];
      const t = (ax * ey - ay * ex) / denom,
        u = (ax * dy - ay * dx) / denom;
      if (t <= 0 || u < 0 || u > 1) continue;
      const hit: Point = [previous[0] + dx * t, previous[1] + dy * t];
      const d = distance(point, hit);
      if (d >= best) continue;
      best = d;
      result = barrierJoinPoint(project, hit, floorId);
      label = distance(result, hit) < 1e-6 ? angleLabel(held.quarter) : 'Endpoint';
    }
    if (result) return { point: result, label };
  }
  for (const barrier of boundaryEdges(project).filter(b => b.floorId === floorId)) {
    const projected = segmentProjection(point, ...barrierEnds(project, barrier));
    if (projected.distance < best) {
      best = projected.distance;
      result = barrierJoinPoint(project, projected.point, floorId);
      label = 'On segment';
    }
  }
  if (result) return { point: result, label };
  let p: Point = grid ? [Math.round(point[0] * 2) / 2, Math.round(point[1] * 2) / 2] : point;
  if (previous) {
    const held = holdAngle(previous, p, axis, tolerance);
    if (held) {
      p = held.point;
      label = angleLabel(held.quarter);
    }
  }
  return { point: p, label: label || (grid ? '0.5 m grid' : '') };
}
/** Hold a segment to `axis` and every 15° off it (including 45° and 90°). See
 *  `referenceAxis` in ./walls for where a meaningful axis comes from; 0 is the site's own grid.
 *
 *  The test is perpendicular distance from the candidate ray, not an angle, so the tolerance stays a
 *  constant width on screen: a short wall snaps readily and a long one keeps fine control of its far
 *  end, which is the behaviour that makes the constraint feel like help rather than a fight. Null when
 *  the pointer is near none of them — an angle nobody asked for is worse than no angle at all. */
const zero = (v: number) => (Math.abs(v) < 1e-12 ? 0 : v);
export function holdAngle(
  previous: Point,
  point: Point,
  axis: number,
  tolerance: number,
): { point: Point; degrees: number; quarter: number } | null {
  const vx = point[0] - previous[0],
    vy = point[1] - previous[1];
  if (Math.hypot(vx, vy) < 1e-6) return null;
  let best: { point: Point; degrees: number; quarter: number; offset: number } | null = null;
  for (let k = 0; k < 24; k++) {
    const degrees = axis + k * 15,
      rad = (degrees * Math.PI) / 180,
      // cos(90°) comes back as 6e-17 rather than 0, which would leave a wall a hair off the very axis
      // it was just held to — harmless on screen, but it is what gets written to the document.
      dx = zero(Math.cos(rad)),
      dy = zero(Math.sin(rad)),
      along = vx * dx + vy * dy;
    if (along <= 0) continue; // the opposing ray of a pair already covered by its partner
    const offset = Math.abs(vx * dy - vy * dx);
    if (offset >= tolerance || (best && offset >= best.offset)) continue;
    best = { point: [previous[0] + dx * along, previous[1] + dy * along], degrees, quarter: (k % 12) / 3, offset };
  }
  return best && { point: best.point, degrees: best.degrees, quarter: best.quarter };
}
/** One centimetre is the model's degeneracy guard, independent of the drawing grid and zoom.
 *  Short returns, jambs and staggered junctions are real geometry; their screen handles spread
 *  apart when necessary so they remain editable. */
export const MIN_SEGMENT = MIN_WALL_LENGTH;
/** An opening needs a valid wall AND enough length for its actual width. Kept as an exported
 *  base limit for callers; there is no additional one-metre restriction on narrow doors/windows. */
export const OPENING_MIN_SEGMENT = MIN_SEGMENT;
/** Automatic joins only absorb sub-millimetre coordinate noise. Interactive snapping has its
 *  own screen-based reach, so a deliberate centimetre-scale feature survives with snapping off. */

/** Weld a connection near the end of a wall to that end. The snap preview and the actual
 *  junction use the same rule, so an ordinary T-junction cannot leave an uneditable stub. */
export function barrierJoinPoint(project: ProjectDocument, point: Point, floorId: string | null): Point {
  const existing = project.junctions.find(j => j.floorId === floorId && distance(j.position, point) < JOIN_EPS);
  if (existing) return existing.position;
  for (const barrier of project.barriers) {
    if (barrier.floorId !== floorId) continue;
    const [a, b] = barrierEnds(project, barrier);
    const hit = segmentProjection(point, a, b);
    if (hit.distance > JOIN_EPS) continue;
    const nearest = hit.t <= 0.5 ? a : b;
    if (distance(hit.point, nearest) < MIN_SEGMENT - 1e-6) return nearest;
  }
  return point;
}

/** A preview can check a connection without partially splitting any walls. */
export function junctionIssue(project: ProjectDocument, point: Point, floorId: string | null): string | null {
  point = barrierJoinPoint(project, point, floorId);
  if (project.junctions.some(j => j.floorId === floorId && distance(j.position, point) < JOIN_EPS)) return null;
  for (const barrier of project.barriers.filter(b => b.floorId === floorId)) {
    const [a, b] = barrierEnds(project, barrier);
    const hit = segmentProjection(point, a, b);
    if (hit.distance > JOIN_EPS || hit.t <= 0 || hit.t >= 1) continue;
    const cut = distance(a, point);
    for (const o of project.objects.filter(o => o.barrierId === barrier.id)) {
      if (Math.abs((o.offset ?? 0) - cut) < o.width / 2) return 'A junction cannot split an opening.';
      if (((o.offset ?? 0) < cut ? cut : distance(point, b)) < OPENING_MIN_SEGMENT - 1e-6)
        return `Leave at least ${OPENING_MIN_SEGMENT} m of wall around an opening.`;
    }
  }
  return null;
}

/** Preflight the complete stroke, including openings crossed between its endpoints. */
export function barrierStrokeIssue(
  project: ProjectDocument,
  a: Point,
  b: Point,
  floorId: string | null,
): string | null {
  a = barrierJoinPoint(project, a, floorId);
  b = barrierJoinPoint(project, b, floorId);
  const atStart = junctionIssue(project, a, floorId) ?? junctionIssue(project, b, floorId);
  if (atStart) return atStart;
  const ux = b[0] - a[0],
    uy = b[1] - a[1];
  const length = distance(a, b),
    cuts = [0, length];
  const tooShort = (span: number, minimum: number) => span > GEOMETRY_EPS && span < minimum - GEOMETRY_EPS;
  for (const wall of boundaryEdges(project).filter(w => w.floorId === floorId)) {
    const [c, d] = barrierEnds(project, wall),
      vx = d[0] - c[0],
      vy = d[1] - c[1];
    const det = ux * vy - uy * vx;
    if (Math.abs(det) < 1e-12 * length * distance(c, d)) {
      for (const q of [c, d]) {
        const hit = segmentProjection(q, a, b);
        if (hit.distance <= GEOMETRY_EPS) cuts.push(hit.t * length);
      }
      continue;
    }
    const t = ((c[0] - a[0]) * vy - (c[1] - a[1]) * vx) / det;
    const s = ((c[0] - a[0]) * uy - (c[1] - a[1]) * ux) / det;
    if (t < 0 || t > 1 || s < 0 || s > 1) continue;
    cuts.push(t * length);
    if (tooShort(Math.min(s, 1 - s) * distance(c, d), 'kind' in wall ? MIN_SEGMENT : MIN_RING_EDGE))
      return 'That crossing would leave a boundary segment too short.';
    const issue = junctionIssue(project, [a[0] + t * ux, a[1] + t * uy], floorId);
    if (issue) return issue;
  }
  cuts.sort((x, y) => x - y);
  if (cuts.some((cut, i) => i > 0 && tooShort(cut - cuts[i - 1], MIN_SEGMENT)))
    return 'That crossing would leave a boundary segment too short.';
  return null;
}

export function joinAt(project: ProjectDocument, point: Point, floorId: string | null): string {
  point = barrierJoinPoint(project, point, floorId);
  const existing = project.junctions.find(j => j.floorId === floorId && distance(j.position, point) < JOIN_EPS);
  if (existing) return existing.id;
  const issue = junctionIssue(project, point, floorId);
  if (issue) throw new Error(issue);
  const id = uid();
  project.junctions.push({ id, floorId, position: point });
  for (const barrier of [...project.barriers].filter(b => b.floorId === floorId)) {
    const [a, b] = barrierEnds(project, barrier);
    const hit = segmentProjection(point, a, b);
    if (hit.distance > JOIN_EPS || hit.t <= 0 || hit.t >= 1) continue;
    const cut = distance(a, point);
    const attachments = project.objects.filter(o => o.barrierId === barrier.id);
    const newId = uid();
    const oldEnd = barrier.endId;
    barrier.endId = id;
    project.barriers.push({ ...barrier, id: newId, startId: id, endId: oldEnd });
    replaceBoundaryUses(project, barrier.id, [{ edgeId: barrier.id }, { edgeId: newId }]);
    attachments.forEach(o => {
      if ((o.offset ?? 0) > cut) {
        o.barrierId = newId;
        o.offset = (o.offset ?? 0) - cut;
      }
    });
  }
  return id;
}
/** Take a wall out of the document, with everything that only existed because it was there.
 *
 *  A wall is never alone: doors and windows hang in it, junctions exist to hold its ends, and route
 *  nodes may be bound to those openings. Removing the barrier alone leaves each of those pointing at
 *  something that is gone, and the document refuses the whole edit — so the delete appears to do
 *  nothing at all, which is worse than either outcome. Everything that removes a wall goes through
 *  here so that cannot happen in one place and not another.
 *
 *  A junction survives if any other wall still ends there; the ontology is pruned by the caller,
 *  which knows whether spaces are also being merged. */
export function removeBarrier(project: ProjectDocument, barrierId: string) {
  const removed = project.barriers.find(b => b.id === barrierId);
  if (removed) preserveBoundary(project, removed);
  const openings = new Set(project.objects.filter(o => o.barrierId === barrierId).map(o => o.id));
  project.objects = project.objects.filter(o => !openings.has(o.id));
  for (const o of project.objects) if (o.parentId && openings.has(o.parentId)) o.parentId = undefined;
  project.barriers = project.barriers.filter(b => b.id !== barrierId);
  project.junctions = project.junctions.filter(j =>
    boundaryEdges(project).some(b => b.startId === j.id || b.endId === j.id),
  );
  if (project.navNodes?.length) {
    const alive = new Set(project.objects.map(o => o.id));
    project.navNodes = project.navNodes.filter(n => n.objectId === undefined || alive.has(n.objectId));
    const nodes = new Set(project.navNodes.map(n => n.id));
    project.navEdges = (project.navEdges ?? []).filter(
      e => nodes.has(e.aId) && nodes.has(e.bId) && (e.objectId === undefined || alive.has(e.objectId)),
    );
  }
}

export function addBarrier(
  project: ProjectDocument,
  a: Point,
  b: Point,
  floorId: string | null,
  kind: 'wall' | 'fence',
) {
  if (distance(a, b) < MIN_SEGMENT - 1e-6) throw new Error(`A segment must be at least ${MIN_SEGMENT} m long.`);
  a = barrierJoinPoint(project, a, floorId);
  b = barrierJoinPoint(project, b, floorId);
  // Snapping can collapse a stroke back onto its start. Repeated clicks are harmless.
  if (distance(a, b) < MIN_SEGMENT - 1e-6) return;
  const startId = joinAt(project, a, floorId),
    endId = joinAt(project, b, floorId);
  if (
    startId === endId ||
    project.barriers.some(
      w =>
        w.floorId === floorId &&
        w.kind === kind &&
        ((w.startId === startId && w.endId === endId) || (w.startId === endId && w.endId === startId)),
    )
  )
    return;
  const barrier: Barrier = {
    id: uid(),
    floorId,
    startId,
    endId,
    kind,
    name: kind === 'wall' ? 'Wall' : 'Site fence',
    thickness: kind === 'wall' ? 0.3 : 0.1,
    height: kind === 'wall' ? 3.5 : 2,
  };
  project.barriers.push(barrier);
  return barrier;
}
// Splits a room/zone along the infinite line drawn through `pa`→`pb`. Because the line is treated as
// unbounded, the stroke may start and end well past the walls — the room is divided wherever the line
// actually crosses it, so precise clicks on the walls are not required. Holes are supported: each half
// keeps the portion of any hole on its side (a hole straddling the cut merges into that half's
// boundary), and the partition wall is built only across solid spans, skipping courtyards. By
// convention the original keeps the right-hand side of the pa→pb direction and the twin takes the left
// (the twin is what the editor selects after the cut).
export function splitRoom(
  project: ProjectDocument,
  roomId: string,
  pa: Point,
  pb: Point,
  /** Build the partition wall along the cut. False when a wall already exists there — splitting a
   *  space *because* someone drew a wall must not draw a second one on top of it. */
  wall = true,
): string {
  const o = project.objects.find(x => x.id === roomId);
  if (!o?.rings?.length) throw new Error('Pick a room or zone to split.');
  if (o.geometry?.mode === 'boundaries') return splitBoundarySpace(project, o, pa, pb, wall);
  const len = distance(pa, pb);
  if (len < 1e-6) throw new Error('Draw a line across the room to split it.');
  const dir: Point = [(pb[0] - pa[0]) / len, (pb[1] - pa[1]) / len];
  const normal: Point = [dir[1], -dir[0]]; // unit normal pointing to the right-hand side of travel

  // A cut long enough to reach past the whole room, so overshooting the walls is harmless.
  const poly = o.rings.map(closeRing);
  const reach = Math.max(len, ...poly.flat().map(p => distance(pa, p))) * 4 + 10;
  const c0: Point = [pa[0] - dir[0] * reach, pa[1] - dir[1] * reach];
  const c1: Point = [pa[0] + dir[0] * reach, pa[1] + dir[1] * reach];
  const halfPlane = (side: 1 | -1): Ring =>
    closeRing([
      c0,
      c1,
      [c1[0] + normal[0] * reach * side, c1[1] + normal[1] * reach * side],
      [c0[0] + normal[0] * reach * side, c0[1] + normal[1] * reach * side],
    ]);
  // Intersect the room (outer + holes) with a half-plane; keep the largest resulting polygon.
  const clip = (side: 1 | -1): Ring[] => {
    const pieces = polygonClipping.intersection(poly as Ring[], [halfPlane(side)]) as unknown as Ring[][];
    if (!pieces.length) throw new Error('The cut must cross the room from one wall to the opposite wall.');
    const netArea = (pg: Ring[]) => ringArea(pg[0]) - pg.slice(1).reduce((sum, r) => sum + ringArea(r), 0);
    const usable = pieces.filter(pg => netArea(pg) >= MIN_SPACE_AREA).sort((a, b) => netArea(b) - netArea(a));
    if (!usable.length) throw new Error(`Each split space needs at least ${MIN_SPACE_AREA} m² of usable area.`);
    if (usable.length > 1)
      throw new Error('That cut would leave disconnected pieces — draw a single straight line across the room.');
    return usable[0].map(closeRing);
  };
  // Only weld numerical duplicates. Removing a real cut vertex changes the boundary and can
  // lose floor area or erase a small notch; the wall minimum and drawing grid do not govern rings.
  const drawnKey = (p: Point) => `${p[0].toFixed(4)},${p[1].toFixed(4)}`;
  const drawn = new Set(poly.flat().map(drawnKey));
  const weld = (rings: Ring[]): Ring[] =>
    rings.map(closed => {
      const r = openRing(closed);
      const kept = r.filter((p, i) => {
        if (drawn.has(drawnKey(p))) return true;
        const prev = r[(i + r.length - 1) % r.length],
          next = r[(i + 1) % r.length];
        if (drawn.has(drawnKey(prev)) && distance(p, prev) < JOIN_EPS) return false;
        if (drawn.has(drawnKey(next)) && distance(p, next) < JOIN_EPS) return false;
        return true;
      });
      // Removing a cut vertex can connect across a concave notch or reverse a boundary edge.
      // Keep the clipper's valid boundary if that shortcut would cross another edge.
      const crossing = kept.some((p, i) =>
        kept.some(
          (q, j) =>
            j > i + 1 &&
            !(i === 0 && j === kept.length - 1) &&
            intersects(p, kept[(i + 1) % kept.length], q, kept[(j + 1) % kept.length]),
        ),
      );
      return kept.length >= 3 && ringArea(kept) >= 0.01 && !crossing ? closeRing(kept) : closed;
    });
  const right = weld(clip(1)); // original keeps the right-hand side …
  const left = weld(clip(-1)); // … the twin takes the left

  const apply = (target: SiteObject, rings: Ring[]) => {
    target.rings = rings;
    target.position = centroid(rings[0]);
    const outer = openRing(rings[0]);
    const xs = outer.map(p => p[0]),
      ys = outer.map(p => p[1]);
    target.width = Math.max(...xs) - Math.min(...xs);
    target.depth = Math.max(...ys) - Math.min(...ys);
  };
  const twin = structuredClone(o);
  twin.id = uid();
  twin.name = `${o.name} 2`;
  twin.feedId = undefined;
  apply(o, right);
  apply(twin, left);
  project.objects.push(twin);

  if (!wall) return twin.id;
  // Partition wall: collect every crossing of the cut line with every ring (outer + holes) as a signed
  // distance along `dir` from `pa`, order them, and wall each solid interval (crossings 0-1, 2-3, …).
  // This skips holes and handles concave rooms the line enters and leaves more than once.
  const crossings: number[] = [];
  for (const ring of poly) {
    const r = openRing(ring);
    for (let i = 0; i < r.length; i++) {
      const a = r[i],
        b = r[(i + 1) % r.length];
      const e: Point = [b[0] - a[0], b[1] - a[1]];
      const denom = dir[0] * e[1] - dir[1] * e[0];
      if (Math.abs(denom) < 1e-12) continue; // edge parallel to the cut
      const qp: Point = [a[0] - pa[0], a[1] - pa[1]];
      const u = (qp[0] * dir[1] - qp[1] * dir[0]) / denom; // param along the edge
      if (u < -1e-9 || u > 1 + 1e-9) continue;
      crossings.push((qp[0] * e[1] - qp[1] * e[0]) / denom); // distance along the cut
    }
  }
  crossings.sort((x, y) => x - y);
  const deduped = crossings.filter((t, i) => i === 0 || t - crossings[i - 1] > 1e-4);
  const from = project.barriers.length;
  for (let i = 0; i + 1 < deduped.length; i += 2) {
    const s: Point = [pa[0] + dir[0] * deduped[i], pa[1] + dir[1] * deduped[i]];
    const e: Point = [pa[0] + dir[0] * deduped[i + 1], pa[1] + dir[1] * deduped[i + 1]];
    if (distance(s, e) >= MIN_SEGMENT - 1e-6) addBarrier(project, s, e, o.floorId, 'wall');
  }
  project.barriers.slice(from).forEach(b => {
    b.name = 'Partition';
    b.thickness = 0.18;
  });
  return twin.id;
}
// Clones a floor with everything on it, including its slice of the nav graph: node/edge ids are
// remapped (bindings follow cloned objects), and cross-floor edges (vertical rides, exits) are
// dropped — re-run chainVertical on the copy to rejoin it to the shafts.
/** Delete a floor and everything anchored to it. The cascade is the whole job: a floor owns junctions,
 *  barriers, objects and drawings, and those are in turn referenced from elsewhere — openings hang off
 *  barriers, cameras watch objects, lifts serve floors, nested zones name a parent, the nav graph binds
 *  both, a building may roof this level, and the document may open on it. Anything missed here surfaces
 *  later as a validation failure on load, so it is all handled up front.
 *  Refuses to remove the last floor: a project must always have one. Returns the ids that were removed. */
export function removeFloor(project: ProjectDocument, floorId: string): string[] {
  const floor = project.floors.find(f => f.id === floorId);
  if (!floor) throw new Error('That floor is not part of this project.');
  if (project.floors.length <= 1) throw new Error('A project needs at least one floor.');

  const goneObjects = new Set(project.objects.filter(o => o.floorId === floorId).map(o => o.id));
  const goneBarriers = new Set(project.barriers.filter(b => b.floorId === floorId).map(b => b.id));
  const removed = [floorId, ...goneObjects, ...goneBarriers];

  project.floors = project.floors.filter(f => f.id !== floorId);
  project.junctions = project.junctions.filter(j => j.floorId !== floorId);
  project.barriers = project.barriers.filter(b => b.floorId !== floorId);
  if (project.virtualBoundaries)
    project.virtualBoundaries = project.virtualBoundaries.filter(b => b.floorId !== floorId);
  project.objects = project.objects.filter(o => o.floorId !== floorId);
  project.drawings = project.drawings.filter(d => d.floorId !== floorId);

  for (const o of project.objects) {
    // An opening whose wall is gone would float; a nested zone whose parent is gone becomes its own.
    if (o.barrierId && goneBarriers.has(o.barrierId)) {
      o.barrierId = undefined;
      o.offset = undefined;
    }
    if (o.parentId && goneObjects.has(o.parentId)) o.parentId = undefined;
    if (o.watchedIds) {
      o.watchedIds = o.watchedIds.filter(id => !goneObjects.has(id));
      if (!o.watchedIds.length) o.watchedIds = undefined;
    }
    if (o.servedFloorIds) {
      o.servedFloorIds = o.servedFloorIds.filter(id => id !== floorId);
      if (!o.servedFloorIds.length) o.servedFloorIds = undefined;
    }
  }
  // Nav nodes on the floor go, as do nodes bound to a deleted object; then any edge missing an end.
  if (project.navNodes) {
    const goneNodes = new Set(
      project.navNodes.filter(n => n.floorId === floorId || (n.objectId && goneObjects.has(n.objectId))).map(n => n.id),
    );
    project.navNodes = project.navNodes.filter(n => !goneNodes.has(n.id));
    project.navEdges = (project.navEdges ?? []).filter(
      e => !goneNodes.has(e.aId) && !goneNodes.has(e.bId) && !(e.objectId && goneObjects.has(e.objectId)),
    );
  }
  // The ontology references those objects too. Kept inline rather than calling model/topology's
  // pruneOntology, because topology imports this module and the cycle is not worth the reuse.
  if (project.portals)
    project.portals = project.portals.filter(
      p => !goneObjects.has(p.a) && !goneObjects.has(p.b) && !(p.openingId && goneObjects.has(p.openingId)),
    );
  const livePortals = new Set((project.portals ?? []).map(p => p.id));
  for (const zone of project.zones ?? []) zone.spaceIds = zone.spaceIds.filter(id => !goneObjects.has(id));
  for (const group of project.portalGroups ?? []) group.portalIds = group.portalIds.filter(id => livePortals.has(id));
  for (const b of project.buildings) if (b.roof?.floorId === floorId) b.roof = undefined;
  if (project.initialFloorId === floorId) project.initialFloorId = undefined;
  return removed;
}
export function duplicateFloor(project: ProjectDocument, floorId: string): string {
  const floor = project.floors.find(f => f.id === floorId)!;
  const newId = uid();
  const map = new Map<string, string>();
  const cloneId = (id: string) => {
    if (!map.has(id)) map.set(id, uid());
    return map.get(id)!;
  };
  project.floors.push({
    ...floor,
    id: newId,
    name: `${floor.name} copy`,
    elevation: Math.max(
      ...project.floors.filter(f => f.buildingId === floor.buildingId).map(f => f.elevation + f.height),
    ),
  });
  project.junctions
    .filter(j => j.floorId === floorId)
    .forEach(j => project.junctions.push({ ...structuredClone(j), id: cloneId(j.id), floorId: newId }));
  project.barriers
    .filter(b => b.floorId === floorId)
    .forEach(b =>
      project.barriers.push({
        ...b,
        id: cloneId(b.id),
        floorId: newId,
        startId: cloneId(b.startId),
        endId: cloneId(b.endId),
      }),
    );
  project.objects
    .filter(o => o.floorId === floorId)
    .forEach(o =>
      project.objects.push({
        ...structuredClone(o),
        id: cloneId(o.id),
        floorId: newId,
        feedId: undefined,
        parentId: o.parentId ? cloneId(o.parentId) : undefined,
        barrierId: o.barrierId ? cloneId(o.barrierId) : undefined,
        servedFloorIds: o.servedFloorIds?.map(id => (id === floorId ? newId : id)),
        geometry:
          o.geometry?.mode === 'boundaries'
            ? {
                mode: 'boundaries',
                loops: o.geometry.loops.map(l => l.map(u => ({ ...u, edgeId: cloneId(u.edgeId) }))),
              }
            : o.geometry,
      }),
    );
  project.virtualBoundaries
    ?.filter(b => b.floorId === floorId)
    .forEach(b =>
      project.virtualBoundaries!.push({
        ...b,
        id: cloneId(b.id),
        floorId: newId,
        startId: cloneId(b.startId),
        endId: cloneId(b.endId),
      }),
    );
  project.drawings
    .filter(d => d.floorId === floorId)
    .forEach(d => project.drawings.push({ ...d, id: uid(), floorId: newId }));
  project.navNodes
    ?.filter(n => n.floorId === floorId)
    .forEach(n =>
      project.navNodes!.push({
        ...structuredClone(n),
        id: cloneId(n.id),
        floorId: newId,
        objectId: n.objectId && map.has(n.objectId) ? map.get(n.objectId)! : undefined,
      }),
    );
  project.navEdges
    ?.filter(e => map.has(e.aId) && map.has(e.bId))
    .forEach(e =>
      project.navEdges!.push({
        ...e,
        id: cloneId(e.id),
        aId: map.get(e.aId)!,
        bId: map.get(e.bId)!,
        objectId: e.objectId && map.has(e.objectId) ? map.get(e.objectId)! : undefined,
      }),
    );
  return newId;
}
export function alignDrawing(
  imagePoints: [Point, Point],
  mapPoints: [Point, Point],
): Pick<Drawing, 'origin' | 'scale' | 'rotation'> {
  const flipped: [Point, Point] = imagePoints.map(p => [p[0], -p[1]] as Point) as [Point, Point];
  const dl = distance(...flipped),
    ml = distance(...mapPoints);
  if (dl < 1 || ml < 0.01) throw new Error('Choose two distinct points.');
  const rotation =
    ((Math.atan2(mapPoints[1][1] - mapPoints[0][1], mapPoints[1][0] - mapPoints[0][0]) -
      Math.atan2(flipped[1][1] - flipped[0][1], flipped[1][0] - flipped[0][0])) *
      180) /
    Math.PI;
  const scale = ml / dl;
  const offset = rotate([flipped[0][0] * scale, flipped[0][1] * scale], rotation);
  return { origin: [mapPoints[0][0] - offset[0], mapPoints[0][1] - offset[1]], scale, rotation };
}
export const drawingCorners = (d: Drawing): Point[] =>
  (
    [
      [0, 0],
      [d.width, 0],
      [d.width, -d.height],
      [0, -d.height],
    ] as Point[]
  ).map(p => add(d.origin, rotate([p[0] * d.scale, p[1] * d.scale], d.rotation)));
