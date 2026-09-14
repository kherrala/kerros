import { describe, expect, it } from 'vitest';
import { drawBarrier, encloseRoom } from './authoring';
import { addVirtualBoundary } from './boundaries';
import { addBarrier, rectangle } from './geometry';
import { inferOpenBoundaries, refreshPortals } from './inference';
import { findRoute } from './navigation';
import { addPortalGroup, perimeter } from './ontology';
import { effectivePortals, sharedBoundaryPortals } from './portals';
import { newProject } from './testFixtures';
import { transact, validateProject } from './validate';

const floor = 'floor-ground';
function narrowOpening() {
  const result = transact(
    newProject(),
    p => {
      const ring = rectangle([0, 0], 8, 6);
      for (let i = 1; i < ring.length; i++) addBarrier(p, ring[i - 1], ring[i], floor, 'wall');
      drawBarrier(p, floor, [0, -3], [0, -0.4]);
      drawBarrier(p, floor, [0, 0.4], [0, 3]);
      addVirtualBoundary(p, floor, [0, -0.4], [0, 0.4]);
      encloseRoom(p, floor, [-2, 0])!.room.id = 'TK';
      encloseRoom(p, floor, [2, 0])!.room.id = 'VH';
    },
    { freeze: false },
  );
  if (!result.ok) throw new Error(result.error);
  // A fresh read of the exported document, without graph caches created during validation.
  return structuredClone(result.project);
}

describe('explicit open space boundaries', () => {
  it('routes through an 80 cm opening in an existing plan without a stored portal or door', () => {
    const p = narrowOpening();
    expect(p.portals ?? []).toEqual([]);
    const before = JSON.stringify(p);
    const portal = { id: 'open:TK:VH', a: 'TK', b: 'VH', attests: 'none' };
    expect(sharedBoundaryPortals(p)).toEqual([portal]);
    expect(inferOpenBoundaries(p)).toEqual([portal]);
    expect(effectivePortals(p)).toEqual([portal]);
    expect(findRoute(p, 'TK', 'VH')?.legs).toHaveLength(1);
    expect(perimeter(p, { id: 'closet', name: 'Closet', spaceIds: ['VH'] })).toEqual([portal]);
    expect(JSON.stringify(p)).toBe(before);
    // Reproduces why probing cached inside-face outlines missed this real opening.
    const legacy = structuredClone(p);
    for (const room of legacy.objects) room.geometry = { mode: 'independent' };
    expect(inferOpenBoundaries(legacy)).toEqual([]);
  });

  it.each(['none', 'a-to-b', 'b-to-a'] as const)('preserves a manually set %s passage on re-read', passage => {
    const p = narrowOpening();
    p.portals = [{ id: 'manual', a: 'TK', b: 'VH', passage }];
    refreshPortals(p);
    expect(effectivePortals(p)).toEqual(p.portals);
    expect(p.portals).toHaveLength(1);
    expect(!!findRoute(p, 'TK', 'VH')).toBe(passage === 'a-to-b');
    expect(!!findRoute(p, 'VH', 'TK')).toBe(passage === 'b-to-a');
  });

  it('removes an inferred crossing when the open boundary becomes a physical wall', () => {
    const p = narrowOpening();
    refreshPortals(p);
    expect(p.portals).toHaveLength(1);
    const next = transact(p, draft => drawBarrier(draft, floor, [0, -0.4], [0, 0.4]));
    if (!next.ok) throw new Error(next.error);
    expect(sharedBoundaryPortals(next.project)).toEqual([]);
    expect(inferOpenBoundaries(next.project)).toEqual([]);
    expect(effectivePortals(next.project)).toEqual([]);
    expect(findRoute(next.project, 'TK', 'VH')).toBeNull();
  });

  it('does not bypass a sealed portal through an older duplicate inferred opening', () => {
    const p = narrowOpening();
    p.portals = [...sharedBoundaryPortals(p), { id: 'sealed', a: 'TK', b: 'VH', passage: 'none' }];
    expect(effectivePortals(p).map(portal => portal.id)).toEqual(['sealed']);
    expect(findRoute(p, 'TK', 'VH')).toBeNull();
  });

  it('can add a derived opening to a persisted portal group', () => {
    const p = narrowOpening();
    const group = addPortalGroup(p, 'Open rooms', ['open:TK:VH']);
    expect(group.portalIds).toEqual(['open:TK:VH']);
    validateProject(p);
  });

  it('does not connect spaces that only share a junction, or the same side of an edge', () => {
    const p = narrowOpening();
    const vh = p.objects.find(o => o.id === 'VH')!;
    if (vh.geometry?.mode !== 'boundaries') throw new Error('Expected shared geometry');
    const edge = p.virtualBoundaries![0].id;
    const use = vh.geometry.loops.flat().find(u => u.edgeId === edge)!;
    use.reversed = !use.reversed;
    expect(sharedBoundaryPortals(p)).toEqual([]);
    vh.geometry.loops = vh.geometry.loops.map(loop => loop.filter(u => u.edgeId !== edge));
    expect(sharedBoundaryPortals(p)).toEqual([]);
  });
});
