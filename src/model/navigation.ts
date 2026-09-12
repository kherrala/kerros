// Indoor-navigation graph: authoring helpers, A-to-B routing (Dijkstra) and human step
// instructions (graph validation lives in validate.ts). Pure model code — no React, no MapLibre; all geometry stays in the
// local metric frame, and floor elevations are the real model values (presentation compression of
// buried floors is a map concern, see src/map/underground.ts).
import type { Floor, NavEdge, NavEdgeKind, NavNode, Point, ProjectDocument, SiteObject } from './types';
import { uid } from './types';
import { distance, objectPosition, pointInRing } from './geometry';
import { topology } from './topology';

// Cost model in metres-equivalent, exported so editors and play mode price edges identically: a
// lift ride costs a flat call-and-wait plus a little per metre of rise, stairs cost their run plus
// a climb penalty — so one storey favours the stairs and a tower ride favours the lift.
export const ELEVATOR_BASE = 25,
  ELEVATOR_PER_METRE = 1,
  STAIR_CLIMB_FACTOR = 5,
  DOOR_COST = 1.5;
/** addNavNode welds onto any existing node within this range (mirrors joinAt's junction reuse). */
export const NAV_WELD = 0.25;

// Authored graph wins where a document has one; otherwise the graph is derived from spaces and
// portals. Routing, the journey player and the route overlay all read through these two accessors,
// so they need no knowledge of which kind of document they are looking at.
export const navNodes = (p: ProjectDocument): NavNode[] => p.navNodes ?? topology(p).nodes;
export const navEdges = (p: ProjectDocument): NavEdge[] => p.navEdges ?? topology(p).edges;
const floorOf = (p: ProjectDocument, id: string | null): Floor | null =>
  id === null ? null : (p.floors.find(f => f.id === id) ?? null);
const elevation = (p: ProjectDocument, id: string | null) => floorOf(p, id)?.elevation ?? 0;
// Graph validation moved to validate.ts — the validity layer stands on its own.

// ——— Authoring helpers (used by the editor tool and the demo generators).
/** Find-or-create a route node at a point on a floor, welding onto any node within NAV_WELD. */
export function addNavNode(p: ProjectDocument, floorId: string | null, position: Point, objectId?: string): NavNode {
  p.navNodes ??= [];
  const existing = p.navNodes.find(n => n.floorId === floorId && distance(n.position, position) < NAV_WELD);
  if (existing) {
    if (objectId && !existing.objectId) existing.objectId = objectId;
    return existing;
  }
  const node: NavNode = { id: uid(), floorId, position: [position[0], position[1]] };
  if (objectId) node.objectId = objectId;
  p.navNodes.push(node);
  return node;
}
/** Connect two nodes, reusing an existing edge of the same kind between the same pair. */
export function addNavEdge(p: ProjectDocument, kind: NavEdgeKind, a: NavNode, b: NavNode, objectId?: string): NavEdge {
  p.navEdges ??= [];
  const existing = p.navEdges.find(
    e => e.kind === kind && ((e.aId === a.id && e.bId === b.id) || (e.aId === b.id && e.bId === a.id)),
  );
  if (existing) {
    if (objectId && !existing.objectId) existing.objectId = objectId;
    return existing;
  }
  const edge: NavEdge = { id: uid(), kind, aId: a.id, bId: b.id };
  if (objectId) edge.objectId = objectId;
  p.navEdges.push(edge);
  return edge;
}
/** Draw a chain of walk edges through the given points, welding onto existing nodes en route. */
export function navPath(p: ProjectDocument, floorId: string | null, points: Point[]): NavNode[] {
  const out = points.map(pt => addNavNode(p, floorId, pt));
  for (let i = 1; i < out.length; i++) if (out[i - 1].id !== out[i].id) addNavEdge(p, 'walk', out[i - 1], out[i]);
  return out;
}
/** Thread a vertical connection through an elevator/stairs object: one node per served floor at the object's position. Stairs chain adjacent served floors (you pass every level); an elevator gets an edge per floor pair (a ride is direct, so ELEVATOR_BASE is paid once). Per-floor twin objects share a name (see the demo lifts); pass any one of them and each edge binds the twin on its upper floor. */
export function chainVertical(p: ProjectDocument, object: SiteObject): NavNode[] {
  const kind: NavEdgeKind = object.kind === 'elevator' ? 'elevator' : 'stairs';
  // An escalator carries you one way, so the edges it threads are one-way: a route may ride it in
  // the direction it runs and must walk round to come back. A stair has no direction to run in.
  const travel = object.stairModel === 'escalator' ? (object.travel ?? 'up') : null;
  const floors = [...new Set(object.servedFloorIds ?? [])]
    .map(id => p.floors.find(f => f.id === id))
    .filter((f): f is Floor => !!f)
    .sort((a, b) => a.elevation - b.elevation);
  const twin = (floorId: string) =>
    p.objects.find(o => o.kind === object.kind && o.name === object.name && o.floorId === floorId) ?? object;
  const out = floors.map(f => {
    const t = twin(f.id);
    return addNavNode(p, f.id, objectPosition(p, t), t.id);
  });
  for (let i = 1; i < out.length; i++)
    for (let j = kind === 'elevator' ? 0 : i - 1; j < i; j++) {
      if (out[j].id === out[i].id) continue;
      // Nodes come sorted upwards, so `out[j]` is the lower landing. An escalator running down is
      // the same pair the other way about.
      const [from, to] = travel === 'down' ? [out[i], out[j]] : [out[j], out[i]];
      const edge = addNavEdge(p, kind, from, to, twin(out[i].floorId!).id);
      if (travel) edge.directed = true;
    }
  return out;
}

// ——— Routing.
export interface RouteLeg {
  edge: NavEdge;
  from: NavNode;
  to: NavNode;
  cost: number;
}
export interface RouteStep {
  kind: 'depart' | 'walk' | 'door' | 'stairs' | 'elevator' | 'arrive';
  text: string;
  floorId: string | null;
  nodeIds: string[];
  objectId?: string;
  distance?: number;
}
export interface Route {
  from: SiteObject;
  to: SiteObject;
  nodes: NavNode[];
  legs: RouteLeg[];
  steps: RouteStep[];
  distance: number;
  cost: number;
}

/** Metres-equivalent cost of traversing an edge; authored weight wins over the derived cost. */
export function edgeCost(p: ProjectDocument, edge: NavEdge, a: NavNode, b: NavNode): number {
  if (edge.weight !== undefined) return edge.weight;
  const run = distance(a.position, b.position),
    rise = Math.abs(elevation(p, a.floorId) - elevation(p, b.floorId));
  if (edge.kind === 'elevator') return ELEVATOR_BASE + rise * ELEVATOR_PER_METRE;
  if (edge.kind === 'stairs') return run + rise * STAIR_CLIMB_FACTOR;
  return run + (edge.kind === 'door' ? DOOR_COST : 0);
}
/** Walking metres of an edge (horizontal run, plus the rise on vertical edges) — for display, not costing. */
export function edgeLength(p: ProjectDocument, edge: NavEdge, a: NavNode, b: NavNode): number {
  const rise =
    edge.kind === 'stairs' || edge.kind === 'elevator'
      ? Math.abs(elevation(p, a.floorId) - elevation(p, b.floorId))
      : 0;
  return distance(a.position, b.position) + rise;
}

/** Candidate graph entry points for a room/door/poi: nodes bound to the object at cost 0, else nodes inside an area's outer ring, else the nearest node on the object's floor. Cost is the straight-line approach in metres. */
export function routeAnchors(p: ProjectDocument, object: SiteObject): { node: NavNode; cost: number }[] {
  const bound = navNodes(p).filter(n => n.objectId === object.id);
  if (bound.length) return bound.map(node => ({ node, cost: 0 }));
  const anchor = objectPosition(p, object);
  const sameFloor = navNodes(p).filter(n => n.floorId === object.floorId);
  const inside = object.rings
    ? sameFloor.filter(
        n => pointInRing(n.position, object.rings![0]) && !object.rings!.slice(1).some(h => pointInRing(n.position, h)),
      )
    : [];
  if (inside.length) return inside.map(node => ({ node, cost: distance(anchor, node.position) }));
  const nearest = sameFloor
    .map(node => ({ node, cost: distance(anchor, node.position) }))
    .sort((a, b) => a.cost - b.cost)[0];
  return nearest ? [nearest] : [];
}

/** Shortest route between two objects (rooms, doors, POIs, …) over the authored graph, with human step instructions. Returns null when either end has no anchor or no path exists. */
export function findRoute(p: ProjectDocument, fromId: string, toId: string): Route | null {
  const from = p.objects.find(o => o.id === fromId),
    to = p.objects.find(o => o.id === toId);
  if (!from || !to) return null;
  const starts = routeAnchors(p, from),
    goals = routeAnchors(p, to);
  if (!starts.length || !goals.length) return null;
  const nodes = navNodes(p),
    byId = new Map(nodes.map(n => [n.id, n]));
  const adjacency = new Map<string, { edge: NavEdge; other: NavNode }[]>();
  for (const e of navEdges(p)) {
    const a = byId.get(e.aId),
      b = byId.get(e.bId);
    if (!a || !b) continue;
    (adjacency.get(a.id) ?? adjacency.set(a.id, []).get(a.id)!).push({ edge: e, other: b });
    // A directed edge is passable one way only — an escalator, or a door you cannot come back
    // through. Adding the return leg anyway is how a one-way route quietly becomes a round trip.
    if (!e.directed) (adjacency.get(b.id) ?? adjacency.set(b.id, []).get(b.id)!).push({ edge: e, other: a });
  }
  const dist = new Map<string, number>(),
    prev = new Map<string, { node: NavNode; edge: NavEdge }>(),
    done = new Set<string>();
  for (const s of starts) if (s.cost < (dist.get(s.node.id) ?? Infinity)) dist.set(s.node.id, s.cost);
  for (;;) {
    // Plain scan Dijkstra — authored graphs stay small (hundreds of nodes).
    let current: string | null = null,
      best = Infinity;
    for (const [id, d] of dist)
      if (!done.has(id) && d < best) {
        best = d;
        current = id;
      }
    if (current === null) break;
    done.add(current);
    const node = byId.get(current)!;
    for (const { edge, other } of adjacency.get(current) ?? []) {
      const next = best + edgeCost(p, edge, node, other);
      if (next < (dist.get(other.id) ?? Infinity)) {
        dist.set(other.id, next);
        prev.set(other.id, { node, edge });
      }
    }
  }
  const goal = goals
    .map(g => ({ ...g, total: (dist.get(g.node.id) ?? Infinity) + g.cost }))
    .sort((a, b) => a.total - b.total)[0];
  if (!goal || !Number.isFinite(goal.total)) return null;
  const legs: RouteLeg[] = [];
  for (let at = goal.node; ; ) {
    const back = prev.get(at.id);
    if (!back) break;
    legs.unshift({ edge: back.edge, from: back.node, to: at, cost: edgeCost(p, back.edge, back.node, at) });
    at = back.node;
  }
  const path = [legs.length ? legs[0].from : goal.node, ...legs.map(l => l.to)];
  const walked = legs.reduce((sum, l) => sum + edgeLength(p, l.edge, l.from, l.to), 0);
  return {
    from,
    to,
    nodes: path,
    legs,
    steps: routeSteps(p, from, to, path, legs),
    distance: walked,
    cost: goal.total,
  };
}

// ——— Step instructions.
/** Human name of a level: "Menswear & denim (level 3)" via Floor.code, "outside" for the site level. */
export function floorPhrase(p: ProjectDocument, floorId: string | null): string {
  const floor = floorOf(p, floorId);
  return !floor ? 'outside' : floor.code ? `${floor.name} (level ${floor.code})` : floor.name;
}
const legName = (p: ProjectDocument, leg: RouteLeg, fallback: string) =>
  p.objects.find(o => o.id === leg.edge.objectId)?.name ?? fallback;
/** Build the human step list: walking grouped per floor, vertical rides merged per lift/stair name, doors called out — "Exit through Aleksanterinkatu entrance", "Take Lift A to Offices · buying & admin (level 8)". */
export function routeSteps(
  p: ProjectDocument,
  from: SiteObject,
  to: SiteObject,
  path: NavNode[],
  legs: RouteLeg[],
): RouteStep[] {
  const steps: RouteStep[] = [
    {
      kind: 'depart',
      text: `Start at ${from.name}${from.floorId !== null ? ` on ${floorPhrase(p, from.floorId)}` : ''}`,
      floorId: from.floorId,
      nodeIds: path.length ? [path[0].id] : [],
    },
  ];
  for (let i = 0; i < legs.length; i++) {
    const leg = legs[i];
    if (leg.edge.kind === 'walk') {
      // Fold consecutive walk legs on one floor into a single stride.
      let d = edgeLength(p, leg.edge, leg.from, leg.to);
      const nodeIds = [leg.from.id, leg.to.id];
      while (i + 1 < legs.length && legs[i + 1].edge.kind === 'walk') {
        i++;
        d += edgeLength(p, legs[i].edge, legs[i].from, legs[i].to);
        nodeIds.push(legs[i].to.id);
      }
      steps.push({
        kind: 'walk',
        text: `Walk ${Math.max(1, Math.round(d))} m ${legs[i].to.floorId === null ? 'outside' : `along ${floorPhrase(p, leg.from.floorId)}`}`,
        floorId: leg.from.floorId,
        nodeIds,
        distance: d,
      });
    } else if (leg.edge.kind === 'door') {
      const name = legName(p, leg, 'the door');
      const text =
        leg.to.floorId === null && leg.from.floorId !== null
          ? `Exit through ${name}`
          : leg.from.floorId === null && leg.to.floorId !== null
            ? `Enter through ${name}`
            : `Go through ${name}`;
      steps.push({
        kind: 'door',
        text,
        floorId: leg.to.floorId,
        nodeIds: [leg.from.id, leg.to.id],
        objectId: leg.edge.objectId,
        distance: edgeLength(p, leg.edge, leg.from, leg.to),
      });
    } else {
      // Merge a consecutive vertical ride on the same lift/stair name into one instruction.
      const kind = leg.edge.kind,
        name = legName(p, leg, kind === 'elevator' ? 'the lift' : 'the stairs');
      const nodeIds = [leg.from.id, leg.to.id];
      const start = leg.from;
      let end = leg.to;
      let objectId = leg.edge.objectId;
      while (i + 1 < legs.length && legs[i + 1].edge.kind === kind && legName(p, legs[i + 1], name) === name) {
        i++;
        end = legs[i].to;
        nodeIds.push(end.id);
        objectId = legs[i].edge.objectId ?? objectId;
      }
      const rise = elevation(p, end.floorId) - elevation(p, start.floorId);
      const direction = kind === 'stairs' && !/\b(up|down)\b/i.test(name) ? `${rise > 0 ? 'up ' : 'down '}` : '';
      steps.push({
        kind,
        text: `Take ${name} ${direction}to ${floorPhrase(p, end.floorId)}`,
        floorId: end.floorId,
        nodeIds,
        objectId,
      });
    }
  }
  steps.push({
    kind: 'arrive',
    text: `Arrive at ${to.name}`,
    floorId: to.floorId,
    nodeIds: path.length ? [path[path.length - 1].id] : [],
  });
  return steps;
}
