import { describe, expect, it } from 'vitest';
import { derivedGraph, spaceNodeId } from './topology';
import { perimeter } from './ontology';
import { findRoute } from './navigation';
import { validateProject } from './validate';
import { addFloor, addPortal as portal, addSpace as space, addTestZone as zone, newProject } from './testFixtures';
import type { ObjectKind } from './types';

describe('the derived graph', () => {
  it('makes spaces into nodes and portals into edges', () => {
    const p = newProject();
    space(p, 'lobby', 'floor-ground', [0, 0]);
    space(p, 'office', 'floor-ground', [8, 0]);
    portal(p, 'lobby', 'office');
    const { nodes, edges } = derivedGraph(p);
    expect(nodes.map(n => n.id).sort()).toEqual([spaceNodeId('lobby'), spaceNodeId('office')]);
    expect(edges).toHaveLength(1);
    expect(edges[0].kind).toBe('walk'); // no opening object → an open boundary you walk across
  });
  it('names the door it crosses, so instructions can too', () => {
    const p = newProject();
    space(p, 'lobby', 'floor-ground', [0, 0]);
    space(p, 'office', 'floor-ground', [8, 0]);
    const door = space(p, 'door-1', 'floor-ground', [4, 0], 'door');
    portal(p, 'lobby', 'office', { openingId: door });
    const [edge] = derivedGraph(p).edges;
    expect(edge.kind).toBe('door');
    expect(edge.objectId).toBe(door);
  });
  it('does not mistake the front door for a staircase', () => {
    // Outdoors is floorId null, not a floor. Comparing floorIds naively makes every entrance a
    // vertical move — and then a turnstile fails validation for not being a flight of stairs.
    const p = newProject();
    space(p, 'street', null as unknown as string, [0, -10]);
    space(p, 'lobby', 'floor-ground', [0, 0]);
    const gate = space(p, 'turnstile-1', 'floor-ground', [0, -5], 'turnstile');
    portal(p, 'street', 'lobby', { openingId: gate });
    expect(derivedGraph(p).edges[0].kind).toBe('door');
    expect(() => validateProject(p)).not.toThrow();
  });
  it('treats a turnstile as a way through, not an open boundary', () => {
    const p = newProject();
    space(p, 'a', 'floor-ground', [0, 0]);
    space(p, 'b', 'floor-ground', [8, 0]);
    const gate = space(p, 'gate-1', 'floor-ground', [4, 0], 'turnstile');
    portal(p, 'a', 'b', { openingId: gate });
    expect(derivedGraph(p).edges[0].kind).toBe('door');
  });
  it('omits a sealed portal entirely', () => {
    const p = newProject();
    space(p, 'a', 'floor-ground', [0, 0]);
    space(p, 'b', 'floor-ground', [8, 0]);
    portal(p, 'a', 'b', { passage: 'none' });
    expect(derivedGraph(p).edges).toEqual([]);
  });
  it('does not claim a door as the stairs of a cross-floor portal', () => {
    // A portal may legitimately join spaces on different floors through a door — a landing door at
    // a half level. The edge is vertical, but binding the door to it would claim the door *is* the
    // stairs, and the whole document would be refused for it.
    const p = newProject();
    const upper = addFloor(p, 'floor-1', 4);
    space(p, 'lower-hall', 'floor-ground', [0, 0]);
    space(p, 'upper-hall', upper, [0, 8]);
    const door = space(p, 'door-1', upper, [0, 4], 'door');
    portal(p, 'lower-hall', 'upper-hall', { openingId: door });
    const [edge] = derivedGraph(p).edges;
    expect(edge.kind).toBe('stairs');
    expect(edge.objectId, 'the mismatched opening is not named').toBeUndefined();
    expect(() => validateProject(p), 'and the document stays valid').not.toThrow();
  });
});

describe('vertical connectivity comes from the zone', () => {
  /** Four levels of lift landings, with nothing authored to link them but the zone itself. */
  const tower = (connects: 'all' | 'adjacent', kind: ObjectKind = 'elevator') => {
    const p = newProject();
    const ids = [0, 1, 2, 3].map(i => {
      const floorId = i === 0 ? 'floor-ground' : addFloor(p, `floor-${i}`, i * 3.5);
      return space(p, `car-${i}`, floorId, [0, 0], kind);
    });
    zone(p, 'Lift A', ids, { connects });
    return { p, ids };
  };
  it("'all' gives a direct ride between any two landings", () => {
    const { p } = tower('all');
    const edges = derivedGraph(p).edges;
    expect(edges).toHaveLength(6); // every pair of 4 landings
    expect(new Set(edges.map(e => e.kind))).toEqual(new Set(['elevator']));
    // Ground to top is one hop: a ride is direct, so the call-and-wait is paid once.
    const route = findRoute(p, 'car-0', 'car-3');
    expect(route?.legs).toHaveLength(1);
  });
  it("'adjacent' makes you pass every level in turn", () => {
    const { p } = tower('adjacent', 'stairs');
    expect(derivedGraph(p).edges).toHaveLength(3);
    expect(findRoute(p, 'car-0', 'car-3')?.legs).toHaveLength(3);
  });
  it('replaces 136 authored portals with one line for a 17-storey lift', () => {
    const p = newProject();
    const ids = Array.from({ length: 17 }, (_, i) => {
      const floorId = i === 0 ? 'floor-ground' : addFloor(p, `floor-${i}`, i * 3.5);
      return space(p, `car-${i}`, floorId, [0, 0], 'elevator');
    });
    zone(p, 'Lift', ids, { connects: 'all' });
    expect(derivedGraph(p).edges).toHaveLength((17 * 16) / 2);
    expect(p.portals ?? []).toEqual([]); // none authored
  });
});

describe('one-way things stay one-way', () => {
  const twoRooms = () => {
    const p = newProject();
    space(p, 'inside', 'floor-ground', [0, 0]);
    space(p, 'outside', 'floor-ground', [8, 0]);
    return p;
  };
  it('turns a one-way portal into a one-way edge', () => {
    const p = twoRooms();
    portal(p, 'inside', 'outside', { passage: 'a-to-b' });
    const [edge] = derivedGraph(p).edges;
    expect(edge.directed).toBe(true);
    expect(edge.aId).toBe(spaceNodeId('inside'));
  });
  it('will not route back through a fire exit', () => {
    const p = twoRooms();
    portal(p, 'inside', 'outside', { passage: 'a-to-b' });
    expect(findRoute(p, 'inside', 'outside'), 'out is fine').not.toBeNull();
    expect(findRoute(p, 'outside', 'inside'), 'back in is not').toBeNull();
  });
  it('reverses the edge for a b-to-a portal rather than dropping it', () => {
    const p = twoRooms();
    portal(p, 'inside', 'outside', { passage: 'b-to-a' });
    const [edge] = derivedGraph(p).edges;
    expect(edge.aId).toBe(spaceNodeId('outside'));
    expect(edge.directed).toBe(true);
  });
  it('carries you up an escalator and not back down it', () => {
    const p = newProject();
    const ids = [0, 1, 2].map(i => {
      const floorId = i === 0 ? 'floor-ground' : addFloor(p, `floor-${i}`, i * 4);
      return space(p, `step-${i}`, floorId, [0, 0], 'stairs');
    });
    zone(p, 'Escalator up', ids, { connects: 'up' });
    const edges = derivedGraph(p).edges;
    expect(edges).toHaveLength(2); // adjacent pairs only
    expect(edges.every(e => e.directed)).toBe(true);
    expect(findRoute(p, 'step-0', 'step-2')).not.toBeNull();
    expect(findRoute(p, 'step-2', 'step-0'), 'an up escalator is not a way down').toBeNull();
  });
  it("runs a 'down' escalator the other way", () => {
    const p = newProject();
    const ids = [0, 1].map(i => {
      const floorId = i === 0 ? 'floor-ground' : addFloor(p, `floor-${i}`, 4);
      return space(p, `step-${i}`, floorId, [0, 0], 'stairs');
    });
    zone(p, 'Escalator down', ids, { connects: 'down' });
    expect(findRoute(p, 'step-1', 'step-0')).not.toBeNull();
    expect(findRoute(p, 'step-0', 'step-1')).toBeNull();
  });
});

describe('a through car with front and rear doors', () => {
  // The case the old schema could not express at all: one car, one level, two openings onto two
  // lobbies that belong to different security zones.
  const throughCar = () => {
    const p = newProject();
    const upper = addFloor(p, 'floor-3', 10.5);
    space(p, 'car-g', 'floor-ground', [0, 0], 'elevator');
    space(p, 'car-3', upper, [0, 0], 'elevator');
    space(p, 'lobby-front', upper, [-8, 0]);
    space(p, 'lobby-rear', upper, [8, 0]);
    const front = space(p, 'door-front', upper, [-3, 0], 'door');
    const rear = space(p, 'door-rear', upper, [3, 0], 'door');
    zone(p, 'Lift B', ['car-g', 'car-3'], { connects: 'all' });
    // Two portals from the SAME car space on the SAME floor. No 'side: front|rear' enum needed.
    const a = portal(p, 'car-3', 'lobby-front', { openingId: front, attests: 'none' });
    const b = portal(p, 'car-3', 'lobby-rear', { openingId: rear, attests: 'none' });
    const tenantA = zone(p, 'Tenant A', ['lobby-front']);
    const tenantB = zone(p, 'Tenant B', ['lobby-rear']);
    return { p, a, b, tenantA, tenantB };
  };
  it('reaches both lobbies from one car', () => {
    const { p } = throughCar();
    expect(findRoute(p, 'car-g', 'lobby-front')).not.toBeNull();
    expect(findRoute(p, 'car-g', 'lobby-rear')).not.toBeNull();
  });
  it('puts the two openings on different security boundaries', () => {
    const { p, a, b, tenantA, tenantB } = throughCar();
    expect(perimeter(p, tenantA).map(x => x.id)).toEqual([a.id]);
    expect(perimeter(p, tenantB).map(x => x.id)).toEqual([b.id]);
  });
  it('marks a landing as unattestable, so occupancy must ignore it', () => {
    // A floor press is a request, not an observation: the passenger may go anywhere.
    const { p } = throughCar();
    expect((p.portals ?? []).every(x => x.attests === 'none')).toBe(true);
  });
  it('still validates as a whole document', () => {
    expect(() => validateProject(throughCar().p)).not.toThrow();
  });
});
