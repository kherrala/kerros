import { addNavNode } from '../../src/model/navigation';
import { buildRoomNavigation, type RoomAccess } from '../../src/model/roomNavigation';
import { createRouteClearance } from '../../src/model/routeClearance';
import { distance, objectPosition, openRing, pointInRing, segmentProjection } from '../../src/model/geometry';
import { uid, type NavNode, type Point, type ProjectDocument, type SiteObject } from '../../src/model/types';

/** Keep the sample's vertical rides and street links, then derive indoor walks from the fit-out.
 * Shared open frontages and real doors connect departments; visibility inside each room bends
 * paths around its corners. No hand-drawn shortcut may cross a newly added partition. */
export function stockmannNavigation(p: ProjectDocument) {
  const clearance = createRouteClearance(p);
  const visible = new Map(p.floors.map(f => [f.id, clearance(f.id)]));
  const initial = new Map(p.navNodes!.map(n => [n.id, n]));
  p.navEdges = p.navEdges!.filter(e => {
    if (e.kind !== 'walk') return true;
    const a = initial.get(e.aId)!,
      b = initial.get(e.bId)!;
    return a.floorId === null || (a.floorId === b.floorId && visible.get(a.floorId)!(a.position, b.position));
  });
  const access: RoomAccess[] = [];
  const contains = (room: SiteObject, at: Point) =>
    room.rings!.every((r, i) =>
      i
        ? !pointInRing(at, r)
        : pointInRing(at, r) ||
          openRing(r).some((a, j, pts) => segmentProjection(at, a, pts[(j + 1) % pts.length]).distance < 1e-4),
    );
  for (const floor of p.floors) {
    const rooms = p.objects.filter(o => o.floorId === floor.id && o.kind === 'room' && o.rings);
    const clear = visible.get(floor.id)!;
    const bind = (node: NavNode) => {
      for (const room of rooms) if (contains(room, node.position)) access.push({ nodeId: node.id, spaceId: room.id });
    };
    for (const door of p.objects.filter(o => o.floorId === floor.id && o.kind === 'door'))
      bind(addNavNode(p, floor.id, objectPosition(p, door), door.id));
    for (let i = 0; i < rooms.length; i++)
      for (let j = i + 1; j < rooms.length; j++) {
        const a = openRing(rooms[i].rings![0]),
          b = openRing(rooms[j].rings![0]);
        for (let k = 0; k < a.length; k++)
          for (let l = 0; l < b.length; l++) {
            const start = a[k],
              end = a[(k + 1) % a.length],
              length = distance(start, end);
            if (length < 1.2) continue;
            const dx = (end[0] - start[0]) / length,
              dy = (end[1] - start[1]) / length;
            const other = [b[l], b[(l + 1) % b.length]];
            if (other.some(q => Math.abs((q[0] - start[0]) * dy - (q[1] - start[1]) * dx) > 1e-4)) continue;
            const projections = other.map(q => (q[0] - start[0]) * dx + (q[1] - start[1]) * dy);
            const low = Math.max(0, Math.min(...projections)),
              high = Math.min(length, Math.max(...projections));
            if (high - low < 1.2) continue;
            const at: Point = [start[0] + (dx * (low + high)) / 2, start[1] + (dy * (low + high)) / 2];
            if (!clear(at, at)) continue;
            const node = addNavNode(p, floor.id, at);
            access.push({ nodeId: node.id, spaceId: rooms[i].id }, { nodeId: node.id, spaceId: rooms[j].id });
          }
      }
    for (const node of p.navNodes!.filter(n => n.floorId === floor.id)) bind(node);
  }
  const graph = buildRoomNavigation(p, access, { nodes: p.navNodes!, edges: p.navEdges! });
  p.navNodes = graph.nodes;
  p.navEdges = graph.edges;
  // Adjacent semantic faces may meet through a clipped corner or an unlabelled sliver. Connect
  // nearby visible waypoints too; the physical floor/wall clearance remains authoritative.
  for (const floor of p.floors) {
    const nodes = p.navNodes.filter(n => n.floorId === floor.id);
    const clear = visible.get(floor.id)!;
    const linked = new Set(p.navEdges.flatMap(e => [`${e.aId}:${e.bId}`, `${e.bId}:${e.aId}`]));
    for (let i = 0; i < nodes.length; i++)
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i],
          b = nodes[j];
        if (linked.has(`${a.id}:${b.id}`) || distance(a.position, b.position) > 8 || !clear(a.position, b.position))
          continue;
        p.navEdges.push({ id: uid(), kind: 'walk', aId: a.id, bId: b.id });
      }
  }
  // A visibility graph contains many equivalent walks. Keep a spanning forest (connectivity)
  // and the nearest visible neighbour in each bearing sector (useful route alternatives),
  // instead of serialising every pairwise shortcut into the editable demo document.
  const byId = new Map(p.navNodes.map(n => [n.id, n]));
  const parent = new Map(p.navNodes.map(n => [n.id, n.id]));
  const root = (id: string): string => {
    let top = id;
    while (parent.get(top)! !== top) top = parent.get(top)!;
    while (id !== top) {
      const next = parent.get(id)!;
      parent.set(id, top);
      id = next;
    }
    return top;
  };
  const walks = p.navEdges
    .filter(e => e.kind === 'walk')
    .map(edge => ({
      edge,
      length: distance(byId.get(edge.aId)!.position, byId.get(edge.bId)!.position),
    }))
    .sort((a, b) => a.length - b.length);
  const keep = new Set<string>();
  const sectors = new Set<string>();
  for (const { edge } of walks) {
    const ra = root(edge.aId),
      rb = root(edge.bId);
    if (ra !== rb) {
      parent.set(ra, rb);
      keep.add(edge.id);
    }
    for (const [from, to] of [
      [edge.aId, edge.bId],
      [edge.bId, edge.aId],
    ]) {
      const a = byId.get(from)!.position,
        b = byId.get(to)!.position;
      const sector = Math.round(Math.atan2(b[1] - a[1], b[0] - a[0]) / (Math.PI / 4));
      const key = `${from}:${sector}`;
      if (!sectors.has(key)) {
        sectors.add(key);
        keep.add(edge.id);
      }
    }
  }
  p.navEdges = p.navEdges.filter(e => e.kind !== 'walk' || keep.has(e.id));
}
