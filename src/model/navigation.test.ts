import { describe, expect, it } from 'vitest';
import {
  addNavEdge,
  addNavNode,
  chainVertical,
  edgeCost,
  findRoute,
  navPath,
  routeAnchors,
  ELEVATOR_BASE,
  STAIR_CLIMB_FACTOR,
} from './navigation';
import { validateNavigation } from './validate';
import { createObject } from './factory';
import { newProject } from './testFixtures';
import { rectangle } from './geometry';
import type { Point, ProjectDocument, SiteObject } from './types';

/** A tower: ground + N upper floors 3.5 m apart, with a room on each requested floor. */
function tower(upper = 1): ProjectDocument {
  const p = newProject();
  for (let i = 1; i <= upper; i++)
    p.floors.push({
      id: `floor-${i}`,
      buildingId: 'building-main',
      name: `Level ${i}`,
      elevation: 3.5 * i,
      height: 3.5,
      code: String(i + 1),
    });
  return p;
}
function room(p: ProjectDocument, floorId: string | null, name: string, center: Point, size = 6): SiteObject {
  const o = createObject('room', center, floorId, name);
  o.width = o.depth = size;
  o.rings = [rectangle(center, size, size)];
  p.objects.push(o);
  return o;
}
function lift(p: ProjectDocument, name: string, position: Point, served: string[]): SiteObject[] {
  return served.map(f => {
    const l = createObject('elevator', position, f, name);
    l.servedFloorIds = served;
    p.objects.push(l);
    return l;
  });
}

describe('validateNavigation', () => {
  it('accepts a well-formed graph and empty documents', () => {
    const p = tower(1);
    const a = addNavNode(p, 'floor-ground', [0, 0]),
      b = addNavNode(p, 'floor-1', [0, 0]);
    const [l] = lift(p, 'Lift A', [0, 0], ['floor-ground', 'floor-1']);
    addNavEdge(p, 'elevator', a, b, l.id);
    expect(validateNavigation(p)).toBeNull();
    expect(validateNavigation(newProject())).toBeNull();
  });
  it('rejects walk edges that change floors and vertical edges that do not', () => {
    const p = tower(1);
    const a = addNavNode(p, 'floor-ground', [0, 0]),
      b = addNavNode(p, 'floor-1', [0, 0]),
      c = addNavNode(p, 'floor-ground', [5, 0]);
    addNavEdge(p, 'walk', a, b);
    expect(validateNavigation(p)).toMatch(/Walk edges/);
    p.navEdges = [];
    addNavEdge(p, 'stairs', a, c);
    expect(validateNavigation(p)).toMatch(/different floors/);
  });
  it('allows door edges to step outside but not to jump between floors', () => {
    const p = tower(1);
    const inside = addNavNode(p, 'floor-ground', [0, 0]),
      outside = addNavNode(p, null, [0, -5]),
      up = addNavNode(p, 'floor-1', [0, 0]);
    addNavEdge(p, 'door', inside, outside);
    expect(validateNavigation(p)).toBeNull();
    addNavEdge(p, 'door', inside, up);
    expect(validateNavigation(p)).toMatch(/Door edges/);
  });
  it('rejects broken references, bad bindings and unserved floors', () => {
    const p = tower(2);
    const a = addNavNode(p, 'floor-ground', [0, 0]),
      b = addNavNode(p, 'floor-2', [0, 0]);
    const [l] = lift(p, 'Lift A', [0, 0], ['floor-ground', 'floor-1']);
    const edge = addNavEdge(p, 'elevator', a, b, l.id);
    expect(validateNavigation(p)).toMatch(/does not serve/);
    edge.objectId = 'missing';
    expect(validateNavigation(p)).toMatch(/missing object/);
    const hall = room(p, 'floor-ground', 'Hall', [0, 0]);
    edge.objectId = hall.id;
    expect(validateNavigation(p)).toMatch(/matching stairs or elevator/);
    edge.objectId = undefined;
    edge.weight = 0;
    expect(validateNavigation(p)).toMatch(/positive number/);
    edge.weight = undefined;
    p.navNodes!.push({ id: 'nav-x', floorId: 'nowhere', position: [0, 0] });
    expect(validateNavigation(p)).toMatch(/unknown floor/);
  });
});

describe('authoring helpers', () => {
  it('welds nodes, deduplicates edges and chains paths', () => {
    const p = tower(0);
    const path = navPath(p, 'floor-ground', [
      [0, 0],
      [10, 0],
      [10, 8],
    ]);
    expect(path).toHaveLength(3);
    expect(p.navEdges).toHaveLength(2);
    const again = addNavNode(p, 'floor-ground', [10.1, 0.1]);
    expect(again.id).toBe(path[1].id);
    addNavEdge(p, 'walk', path[0], path[1]);
    expect(p.navEdges).toHaveLength(2);
    expect(validateNavigation(p)).toBeNull();
  });
  it('threads a vertical chain through per-floor lift twins', () => {
    const p = tower(2);
    const served = ['floor-ground', 'floor-1', 'floor-2'];
    const twins = lift(p, 'Lift A', [3, 3], served);
    const nodes = chainVertical(p, twins[0]);
    expect(nodes.map(n => n.floorId)).toEqual(served);
    expect(p.navEdges).toHaveLength(3); // a ride is direct: one edge per served floor pair
    expect(p.navEdges!.every(e => e.kind === 'elevator')).toBe(true);
    expect(nodes.map(n => n.objectId)).toEqual(twins.map(t => t.id));
    expect(validateNavigation(p)).toBeNull();
  });
});

describe('routing', () => {
  it('routes between rooms across floors and narrates the stairs', () => {
    const p = tower(1);
    const a = room(p, 'floor-ground', 'Lobby', [0, 0]),
      b = room(p, 'floor-1', 'Studio', [20, 0]);
    const s = createObject('stairs', [10, 0], 'floor-ground', 'Stair West');
    s.servedFloorIds = ['floor-ground', 'floor-1'];
    p.objects.push(s);
    navPath(p, 'floor-ground', [
      [0, 0],
      [10, 0],
    ]);
    navPath(p, 'floor-1', [
      [10, 0],
      [20, 0],
    ]);
    chainVertical(p, s);
    const route = findRoute(p, a.id, b.id)!;
    expect(route).not.toBeNull();
    expect(route.legs.map(l => l.edge.kind)).toEqual(['walk', 'stairs', 'walk']);
    expect(route.steps.map(st => st.kind)).toEqual(['depart', 'walk', 'stairs', 'walk', 'arrive']);
    expect(route.steps[0].text).toBe('Start at Lobby on Ground floor');
    expect(route.steps[2].text).toBe('Take Stair West up to Level 1 (level 2)');
    expect(route.steps[4].text).toBe('Arrive at Studio');
    expect(route.distance).toBeCloseTo(10 + 10 + 3.5, 5);
  });
  it('prefers the stairs for one storey and the lift for many, merging the ride into one step', () => {
    const p = tower(6);
    const floors = p.floors.map(f => f.id);
    const start = room(p, 'floor-ground', 'Lobby', [0, 0]);
    const s = createObject('stairs', [0, 2], 'floor-ground', 'Stairs');
    s.servedFloorIds = floors;
    p.objects.push(s);
    const twins = lift(p, 'Lift A', [0, -2], floors);
    for (const f of floors)
      navPath(p, f, [
        [0, 0],
        [0, 2],
        [0, -2],
      ]);
    chainVertical(p, s);
    chainVertical(p, twins[0]);
    const one = findRoute(p, start.id, room(p, 'floor-1', 'Near', [0, 0]).id)!;
    expect(one.steps.some(st => st.kind === 'stairs')).toBe(true);
    const six = findRoute(p, start.id, room(p, 'floor-6', 'Far', [0, 0]).id)!;
    const rides = six.steps.filter(st => st.kind === 'elevator');
    expect(rides).toHaveLength(1);
    expect(rides[0].text).toBe('Take Lift A to Level 6 (level 7)');
    expect(rides[0].nodeIds).toHaveLength(2); // a direct ride, not a per-floor crawl
  });
  it('narrates exits through bound doors to outdoor targets', () => {
    const p = tower(0);
    const hall = room(p, 'floor-ground', 'Exhibition hall', [0, 0]);
    const door = createObject('door', [0, -3], 'floor-ground', 'Aleksanterinkatu entrance');
    p.objects.push(door);
    const assembly = createObject('poi', [0, -20], null, 'Assembly point');
    assembly.symbol = 'assembly';
    p.objects.push(assembly);
    const inside = addNavNode(p, 'floor-ground', [0, 0]);
    const stoop = addNavNode(p, null, [0, -4]);
    addNavEdge(p, 'door', inside, stoop, door.id);
    navPath(p, null, [
      [0, -4],
      [0, -20],
    ]);
    const route = findRoute(p, hall.id, assembly.id)!;
    expect(route.steps.map(st => st.text)).toEqual([
      'Start at Exhibition hall on Ground floor',
      'Exit through Aleksanterinkatu entrance',
      'Walk 16 m outside',
      'Arrive at Assembly point',
    ]);
  });
  it('anchors rooms at contained nodes, bound nodes at zero cost', () => {
    const p = tower(0);
    const hall = room(p, 'floor-ground', 'Hall', [0, 0], 8);
    const inside = addNavNode(p, 'floor-ground', [1, 1]);
    addNavNode(p, 'floor-ground', [30, 0]);
    expect(routeAnchors(p, hall).map(a => a.node.id)).toEqual([inside.id]);
    const bound = addNavNode(p, 'floor-ground', [3, 3], hall.id);
    expect(routeAnchors(p, hall)).toEqual([{ node: bound, cost: 0 }]);
  });
  it('handles degenerate and impossible journeys', () => {
    const p = tower(1);
    const a = room(p, 'floor-ground', 'A', [0, 0]),
      b = room(p, 'floor-ground', 'B', [2, 0]);
    expect(findRoute(p, a.id, b.id)).toBeNull(); // no graph at all
    const shared = addNavNode(p, 'floor-ground', [1, 0]);
    const same = findRoute(p, a.id, b.id)!; // both ends resolve to the same node
    expect(same.legs).toHaveLength(0);
    expect(same.steps.map(st => st.kind)).toEqual(['depart', 'arrive']);
    expect(same.nodes).toEqual([shared]);
    addNavNode(p, 'floor-1', [0, 0]); // disconnected island
    const marooned = room(p, 'floor-1', 'Marooned', [0, 0]);
    expect(findRoute(p, a.id, marooned.id)).toBeNull();
  });
  it('honours authored weights over derived costs', () => {
    const p = tower(1);
    const a = addNavNode(p, 'floor-ground', [0, 0]),
      b = addNavNode(p, 'floor-1', [0, 0]);
    const ride = addNavEdge(p, 'elevator', a, b);
    expect(edgeCost(p, ride, a, b)).toBeCloseTo(ELEVATOR_BASE + 3.5, 5);
    const climb = addNavEdge(p, 'stairs', a, b);
    expect(edgeCost(p, climb, a, b)).toBeCloseTo(3.5 * STAIR_CLIMB_FACTOR, 5);
    ride.weight = 2;
    expect(edgeCost(p, ride, a, b)).toBe(2);
  });
});

describe('routing from where you stand', () => {
  it('uses a live escalator direction and permits walking a stopped machine', () => {
    const p = tower(1);
    const stair = createObject('stairs', [0, 0], 'floor-ground', 'Escalator');
    Object.assign(stair, {
      stairModel: 'escalator',
      travel: 'up',
      feedId: 'escalator',
      servedFloorIds: ['floor-ground', 'floor-1'],
    });
    p.objects.push(stair);
    const [a, b] = chainVertical(p, stair);
    const from = { floorId: a.floorId, position: a.position },
      to = { floorId: b.floorId, position: b.position };
    expect(findRoute(p, from, to)).not.toBeNull();
    expect(findRoute(p, to, from)).toBeNull();
    const statuses = new Map([
      [
        'escalator',
        { feedId: 'escalator', tone: 'normal' as const, label: 'Down', travel: 'down' as const, running: true },
      ],
    ]);
    expect(findRoute(p, from, to, { statuses })).toBeNull();
    expect(findRoute(p, to, from, { statuses })).not.toBeNull();
    statuses.get('escalator')!.running = false;
    expect(findRoute(p, from, to, { statuses })).not.toBeNull();
    expect(findRoute(p, to, from, { statuses })).not.toBeNull();
  });
  it('starts at the point, joins the drawn network inside the room, and names the start', () => {
    const p = tower(0);
    const hall = room(p, 'floor-ground', 'Hall', [0, 0], 10);
    const office = room(p, 'floor-ground', 'Office', [20, 0], 6);
    const a = addNavNode(p, 'floor-ground', [3, 0]),
      b = addNavNode(p, 'floor-ground', [10, 0]),
      c = addNavNode(p, 'floor-ground', [20, 0], office.id);
    addNavEdge(p, 'walk', a, b);
    addNavEdge(p, 'walk', b, c);
    const route = findRoute(p, { floorId: 'floor-ground', position: [-2, 1] }, office.id)!;
    expect(route).not.toBeNull();
    expect(route.from.name).toBe('Where you are');
    expect(route.from.floorId).toBe('floor-ground');
    // The path begins where the person is, not at the nearest drawn node.
    expect(route.nodes[0].position).toEqual([-2, 1]);
    expect(route.nodes[1].id).toBe(a.id); // joined at the node inside the hall
    expect(route.steps[0].text).toMatch(/^Start at Where you are/);
    // And the first walk covers the approach to the network as well as the network.
    expect(route.distance).toBeCloseTo(Math.hypot(5, 1) + 7 + 10, 5);
    expect(hall.id).toBeTruthy();
  });

  it('works as a destination too, and routes object to point', () => {
    const p = tower(0);
    const office = room(p, 'floor-ground', 'Office', [20, 0], 6);
    const a = addNavNode(p, 'floor-ground', [0, 0]),
      c = addNavNode(p, 'floor-ground', [20, 0], office.id);
    addNavEdge(p, 'walk', a, c);
    const route = findRoute(p, office.id, { name: 'The lift lobby', floorId: 'floor-ground', position: [0, 3] })!;
    expect(route.to.name).toBe('The lift lobby');
    expect(route.nodes[route.nodes.length - 1].position).toEqual([0, 3]);
    expect(route.steps[route.steps.length - 1].text).toMatch(/The lift lobby/);
  });

  it('is unreachable from a floor with no network', () => {
    const p = tower(1);
    const office = room(p, 'floor-ground', 'Office', [20, 0], 6);
    const c = addNavNode(p, 'floor-ground', [20, 0], office.id);
    addNavEdge(p, 'walk', addNavNode(p, 'floor-ground', [0, 0]), c);
    expect(findRoute(p, { floorId: 'floor-1', position: [0, 0] }, office.id)).toBeNull();
  });
});
