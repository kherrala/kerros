import { isSpace, type Portal, type ProjectDocument } from './types';

const pairKey = (a: string, b: string) => JSON.stringify([a, b].sort());

/** A shared virtual edge explicitly declares an unwalled connection. Read its two sides directly;
 * sampling inset room outlines loses narrow openings near the ends of adjoining walls. */
export function sharedBoundaryPortals(project: ProjectDocument): Portal[] {
  const edges = new Map((project.virtualBoundaries ?? []).map(edge => [edge.id, edge]));
  if (!edges.size) return [];
  const sides = new Map<string, { id: string; reversed: boolean }[]>();
  for (const space of project.objects) {
    if (!isSpace(space.kind) || space.geometry?.mode !== 'boundaries') continue;
    for (const loop of space.geometry.loops)
      for (const use of loop) {
        const edge = edges.get(use.edgeId);
        if (!edge || edge.floorId !== space.floorId) continue;
        const owners = sides.get(edge.id) ?? [];
        if (!owners.some(owner => owner.id === space.id)) owners.push({ id: space.id, reversed: !!use.reversed });
        sides.set(edge.id, owners);
      }
  }
  const out = new Map<string, Portal>();
  for (const owners of sides.values())
    for (let i = 0; i < owners.length; i++)
      for (let j = i + 1; j < owners.length; j++) {
        if (owners[i].reversed === owners[j].reversed) continue;
        const [a, b] = [owners[i].id, owners[j].id].sort();
        out.set(pairKey(a, b), { id: `open:${a}:${b}`, a, b, attests: 'none' });
      }
  return [...out.values()];
}

/** The readable portal layer, including explicit shared openings in older saved plans. A stored
 * portal takes precedence, including sealed and one-way passage. No document mutation is needed.
 * Once both spaces use shared boundaries, an inferred open connection also disappears when its
 * virtual edge is replaced by a wall. Legacy independent outlines retain their inferred portals. */
export function effectivePortals(project: ProjectDocument): Portal[] {
  const shared = sharedBoundaryPortals(project);
  const pairs = new Set(shared.map(p => pairKey(p.a, p.b)));
  const bound = new Set(project.objects.filter(o => o.geometry?.mode === 'boundaries').map(o => o.id));
  const stored = (project.portals ?? []).filter(
    p => !p.id.startsWith('open:') || !bound.has(p.a) || !bound.has(p.b) || pairs.has(pairKey(p.a, p.b)),
  );
  const authoredPairs = new Set(
    stored.filter(p => !p.id.startsWith('open:') && !p.id.startsWith('inferred:')).map(p => pairKey(p.a, p.b)),
  );
  const retained = stored.filter(p => !p.id.startsWith('open:') || !authoredPairs.has(pairKey(p.a, p.b)));
  const held = new Set(retained.map(p => pairKey(p.a, p.b)));
  return [...retained, ...shared.filter(p => !held.has(pairKey(p.a, p.b)))];
}
