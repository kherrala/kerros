import { distance, footprint, openRing, pointInRing, segmentProjection } from './geometry';
import { createRouteClearance, routeBounds, ROUTE_CLEARANCE } from './routeClearance';
import type { NavEdge, NavNode, Point, ProjectDocument, Ring } from './types';

/** Bind a graph node to the room whose walkable floor it can enter. Use separate nodes on the
 * sides of a controlled portal and join those with a directed/door edge in `graph`. */
export interface RoomAccess {
  spaceId: string;
  nodeId: string;
}
export interface RoomNavigationGraph {
  nodes: NavNode[];
  edges: NavEdge[];
}
const GENERATED = '@room-nav:';
const winding = (ring: Ring) =>
  Math.sign(
    ring.reduce((sum, p, i) => {
      const q = ring[(i + 1) % ring.length];
      return sum + p[0] * q[1] - q[0] * p[1];
    }, 0),
  ) || 1;

/** Build the geometric walking graph inside rooms. Explicit access points describe connectivity;
 * room outlines, holes, pools and wall thickness describe where a person can walk. The input
 * document/graph are not mutated. Supplied door/vertical/directed edges are kept verbatim. */
export function buildRoomNavigation(
  project: ProjectDocument,
  access: readonly RoomAccess[],
  graph: RoomNavigationGraph = { nodes: [], edges: [] },
): RoomNavigationGraph {
  const rooms = project.objects.filter(o => o.kind === 'room' && footprint(o)[0]?.length);
  const nodes: NavNode[] = graph.nodes
    .filter(n => !n.id.startsWith(GENERATED))
    .map(n => ({ ...n, position: [...n.position] }));
  const edges = graph.edges.filter(e => !e.id.startsWith(GENERATED));
  const byId = new Map(nodes.map(n => [n.id, n]));
  const members = new Map(rooms.map(room => [room.id, [] as NavNode[]]));
  const floors = new Map(rooms.map(room => [room.id, room.floorId]));
  for (const node of nodes)
    if (node.objectId && floors.get(node.objectId) === node.floorId) members.get(node.objectId)?.push(node);
  for (const { spaceId, nodeId } of access) {
    const node = byId.get(nodeId),
      room = members.get(spaceId);
    if (node && room && floors.get(spaceId) === node.floorId && !room.includes(node)) room.push(node);
  }
  const pools = new Map<string, Ring[]>();
  for (const o of project.objects)
    if (o.water && o.parentId) {
      const rings = pools.get(o.parentId) ?? [];
      rings.push(...footprint(o).slice(0, 1));
      pools.set(o.parentId, rings);
    }
  const clearance = createRouteClearance(project);
  for (const room of rooms) {
    const prefix = `${GENERATED}${encodeURIComponent(room.id)}:`;
    const candidates = members.get(room.id)!;
    const [outline, ...holes] = footprint(room);
    const visible = clearance(room.floorId, routeBounds(outline));
    const clear = (a: Point, b: Point) => segmentInRoom(a, b, outline) && visible(a, b);
    const obstacles = [...holes, ...(pools.get(room.id) ?? [])];
    const add = (position: Point) => {
      if (!clear(position, position)) return;
      if (candidates.some(n => distance(n.position, position) < 0.01)) return;
      const node: NavNode = { id: `${prefix}point:${candidates.length}`, floorId: room.floorId, position };
      nodes.push(node);
      candidates.push(node);
    };
    // Polygon offset corners handle concave rooms as well as rectangular halls. Each candidate is
    // still checked against the real geometry; no bounding-box shortcut can cross a notch or hole.
    const corners = (ring: Ring, inset: number) => {
      const points = openRing(ring),
        sign = winding(ring);
      const normal = (a: Point, b: Point): Point => {
        const d = distance(a, b) || 1;
        return [(sign * (a[1] - b[1])) / d, (sign * (b[0] - a[0])) / d];
      };
      for (let i = 0; i < points.length; i++) {
        const at = points[i],
          before = points[(i + points.length - 1) % points.length],
          next = points[(i + 1) % points.length];
        const a = normal(before, at),
          b = normal(at, next),
          divisor = 1 + a[0] * b[0] + a[1] * b[1];
        const turn = sign * ((at[0] - before[0]) * (next[1] - at[1]) - (at[1] - before[1]) * (next[0] - at[0]));
        if (inset > 0 && turn >= 0) continue; // only concave outer corners need waypoints
        if (divisor > 0.05) add([at[0] + (inset * (a[0] + b[0])) / divisor, at[1] + (inset * (a[1] + b[1])) / divisor]);
        if (inset < 0) add([(at[0] + next[0]) / 2 + inset * b[0], (at[1] + next[1]) / 2 + inset * b[1]]);
      }
    };
    corners(outline, ROUTE_CLEARANCE + 0.2);
    for (const obstacle of obstacles) corners(obstacle, -ROUTE_CLEARANCE - 0.1);
    // Optional perpendicular approaches avoid grazing a jamb on an oblique crossing. Aligned
    // access points can still connect directly, without a detour through either approach.
    const ring = openRing(outline),
      sign = winding(outline);
    for (const node of [...candidates])
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i],
          b = ring[(i + 1) % ring.length],
          length = distance(a, b);
        if (length && segmentProjection(node.position, a, b).distance < 0.01)
          add([
            node.position[0] + ((sign * (a[1] - b[1])) / length) * 0.9,
            node.position[1] + ((sign * (b[0] - a[0])) / length) * 0.9,
          ]);
      }
    let anchor = candidates.find(n => n.objectId === room.id);
    if (!anchor) {
      anchor = { id: `${prefix}anchor`, floorId: room.floorId, position: [...room.position], objectId: room.id };
      nodes.push(anchor);
      candidates.push(anchor);
    }
    if (!clear(anchor.position, anchor.position)) {
      const dry = candidates
        .filter(n => clear(n.position, n.position))
        .sort((a, b) => distance(a.position, room.position) - distance(b.position, room.position))[0];
      if (dry) anchor.position = [...dry.position];
    }
    for (let i = 0; i < candidates.length; i++)
      for (let j = i + 1; j < candidates.length; j++) {
        const a = candidates[i],
          b = candidates[j];
        if (clear(a.position, b.position))
          edges.push({ id: `${prefix}edge:${i}:${j}`, kind: 'walk', aId: a.id, bId: b.id });
      }
  }
  return { nodes, edges };
}

/** Every interval of the segment must stay inside the room, including when it passes exactly
 * through a concave vertex. Testing only the midpoint misses paths that leave and re-enter. */
function segmentInRoom(a: Point, b: Point, outline: Ring): boolean {
  const ring = openRing(outline);
  const inside = (p: Point) =>
    pointInRing(p, ring) || ring.some((q, i) => segmentProjection(p, q, ring[(i + 1) % ring.length]).distance < 1e-7);
  if (!inside(a) || !inside(b)) return false;
  const dx = b[0] - a[0],
    dy = b[1] - a[1],
    length = distance(a, b);
  if (length < 1e-8) return true;
  const cuts = [0, 1];
  for (let i = 0; i < ring.length; i++) {
    const c = ring[i],
      d = ring[(i + 1) % ring.length],
      ex = d[0] - c[0],
      ey = d[1] - c[1],
      cross = dx * ey - dy * ex;
    if (Math.abs(cross) < 1e-9) {
      for (const p of [c, d]) if (segmentProjection(p, a, b).distance < 1e-7) cuts.push(segmentProjection(p, a, b).t);
    } else {
      const t = ((c[0] - a[0]) * ey - (c[1] - a[1]) * ex) / cross;
      const u = ((c[0] - a[0]) * dy - (c[1] - a[1]) * dx) / cross;
      if (t > 0 && t < 1 && u >= 0 && u <= 1) cuts.push(t);
    }
  }
  cuts.sort((a, b) => a - b);
  return cuts.slice(1).every((t, i) => inside([a[0] + (dx * (t + cuts[i])) / 2, a[1] + (dy * (t + cuts[i])) / 2]));
}
