// The navigation graph as a *derived dual* of the plan: spaces are nodes, portals are edges, and a
// zone's `connects` supplies the vertical ones. This is IndoorGML's Poincaré duality — a k-dimensional
// object in primal space maps to an (N−k)-dimensional one in dual space, so rooms become points and
// the surfaces between them become lines.
//
// Nothing here is authored or stored. It is recomputed from the geometry, which is the whole point: a
// hand-kept graph is a second description of what connects to what, and two descriptions drift.
import { distance } from './geometry';
import { isSpace, type NavEdge, type NavEdgeKind, type NavNode } from './types';
import type { Floor, ProjectDocument, SiteObject } from './types';
import { spacePoint } from './spaces';
import { zoneSpaces } from './ontology';
import { TRAVERSABLE } from './passages';
import { effectivePortals } from './portals';

/** Node id for a space. Prefixed so a derived graph can never collide with an authored entity id. */
export const spaceNodeId = (spaceId: string) => `space:${spaceId}`;

/** A portal's edge kind.
 *
 *  Two different floors is a vertical move. Outdoors is *not* a floor, though — it is `null` — so a
 *  front door joins two different `floorId`s while being the least vertical thing in the building.
 *  Missing that turns every entrance into a flight of stairs. */
function portalKind(a: SiteObject, b: SiteObject, opening?: SiteObject): NavEdgeKind {
  const sameFloor = a.floorId === b.floorId;
  if (!sameFloor && a.floorId !== null && b.floorId !== null)
    return a.kind === 'elevator' || b.kind === 'elevator' ? 'elevator' : 'stairs';
  // Stepping outside: a threshold, which is what door edges are allowed to be even without a leaf.
  if (!sameFloor) return 'door';
  return opening && TRAVERSABLE.has(opening.kind) ? 'door' : 'walk';
}

export function derivedGraph(project: ProjectDocument): { nodes: NavNode[]; edges: NavEdge[] } {
  const objects = new Map(project.objects.map(o => [o.id, o]));
  const floors = new Map<string, Floor>(project.floors.map(f => [f.id, f]));
  const nodes = new Map<string, NavNode>();
  const node = (space: SiteObject): NavNode => {
    const id = spaceNodeId(space.id);
    const existing = nodes.get(id);
    if (existing) return existing;
    const made: NavNode = { id, floorId: space.floorId, position: spacePoint(project, space), objectId: space.id };
    nodes.set(id, made);
    return made;
  };
  // Every space gets a node, whether or not anything connects to it. Creating them only as edges
  // demand them makes an unconnected space vanish from the graph entirely — and routing anchors an
  // object with no footprint (a POI, a door) to the *nearest node*, so a missing node is not merely a
  // gap in the graph, it is an entrance that can never be departed from.
  for (const space of project.objects) if (isSpace(space.kind)) node(space);
  const edges: NavEdge[] = [];
  const join = (id: string, kind: NavEdgeKind, a: SiteObject, b: SiteObject, objectId?: string, directed = false) => {
    if (a.id === b.id) return;
    const edge: NavEdge = { id, kind, aId: node(a).id, bId: node(b).id };
    if (objectId) edge.objectId = objectId;
    if (directed) edge.directed = true;
    edges.push(edge);
  };

  for (const portal of effectivePortals(project)) {
    if ((portal.passage ?? 'both') === 'none') continue;
    const a = objects.get(portal.a),
      b = objects.get(portal.b);
    if (!a || !b) continue;
    const opening = portal.openingId ? objects.get(portal.openingId) : undefined;
    const kind = portalKind(a, b, opening);
    // The edge names the opening it crosses only when the two agree: a door on a door edge, a lift
    // on a lift edge. A cross-floor portal may still carry a door — a landing door at a half level —
    // but a vertical edge claiming a door as its stairs would make the document invalid, so a
    // mismatched opening is simply not named and the edge stands on its own.
    const bindable =
      opening && (kind === 'door' ? TRAVERSABLE.has(opening.kind) : kind === 'walk' ? false : opening.kind === kind);
    // A one-way portal becomes a one-way edge. Emitting it undirected would let a route come back
    // through a fire exit, which is the whole thing `passage` exists to forbid.
    const passage = portal.passage ?? 'both';
    const [from, to] = passage === 'b-to-a' ? [b, a] : [a, b];
    join(`portal:${portal.id}`, kind, from, to, bindable ? opening.id : undefined, passage !== 'both');
  }

  // A zone that declares its own internal connectivity generates the edges its members imply — which
  // is how a 17-storey lift is one line of authoring rather than 136 portals.
  for (const zone of project.zones ?? []) {
    if (!zone.connects) continue;
    const members = zoneSpaces(project, zone)
      .map(id => objects.get(id))
      .filter((o): o is SiteObject => !!o && o.floorId !== null)
      .sort((x, y) => (floors.get(x.floorId!)?.elevation ?? 0) - (floors.get(y.floorId!)?.elevation ?? 0));
    const kind: NavEdgeKind = members.some(m => m.kind === 'elevator') ? 'elevator' : 'stairs';
    // An escalator carries you one way. Members are sorted upwards, so 'up' runs lower → higher and
    // 'down' is the same pairs reversed; both are directed, which is what makes them escalators
    // rather than stairs that happen to be named after a direction.
    const oneWay = zone.connects === 'up' || zone.connects === 'down';
    for (let i = 1; i < members.length; i++)
      for (let j = zone.connects === 'all' ? 0 : i - 1; j < i; j++)
        if (members[j].floorId !== members[i].floorId)
          // The edge only names the object it rides when that object really is the lift or stair.
          // A zone may connect plain rooms — a split-level atrium, a ramp between decks — and
          // claiming a room is an elevator would make the document invalid, not merely untidy.
          join(
            `zone:${zone.id}:${j}:${i}`,
            kind,
            zone.connects === 'down' ? members[i] : members[j],
            zone.connects === 'down' ? members[j] : members[i],
            members[i].kind === kind ? members[i].id : undefined,
            oneWay,
          );
  }
  return { nodes: [...nodes.values()], edges };
}

// Recomputed on every routing query otherwise, and routing runs per keystroke in the navigate panel.
// Documents are replaced rather than mutated, so a WeakMap entry retires with the document it
// describes — the same bargain exteriorWalls strikes.
const cache = new WeakMap<ProjectDocument, { nodes: NavNode[]; edges: NavEdge[] }>();
export function topology(project: ProjectDocument): { nodes: NavNode[]; edges: NavEdge[] } {
  const hit = cache.get(project);
  if (hit) return hit;
  const built = derivedGraph(project);
  cache.set(project, built);
  return built;
}

/** Straight-line length of a derived edge, for cost comparisons against an authored graph. */
export const edgeSpan = (nodes: Map<string, NavNode>, edge: NavEdge): number => {
  const a = nodes.get(edge.aId),
    b = nodes.get(edge.bId);
  return a && b ? distance(a.position, b.position) : 0;
};
