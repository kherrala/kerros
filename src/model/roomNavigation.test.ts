import { describe, expect, it } from 'vitest';
import { buildRoomNavigation, type RoomNavigationGraph } from '../schema';
import { createObject } from './factory';
import { distance, pointInRing, rectangle, rotate, segmentProjection } from './geometry';
import { findRoute } from './navigation';
import { createRouteClearance } from './routeClearance';
import { newProject } from './testFixtures';
import type { Point, Ring } from './types';

function fixture(
  ring = rectangle([0, 0], 12, 8),
  ends: Point[] = [
    [-6, 0],
    [6, 0],
  ],
) {
  const project = newProject();
  const room = createObject('room', [0, 0], 'floor-ground', 'Hall');
  room.id = 'hall';
  room.rings = [ring];
  project.objects.push(room);
  const graph: RoomNavigationGraph = { nodes: [], edges: [] };
  for (const [i, at] of ends.entries()) {
    const id = i ? 'exit' : 'entry';
    const poi = createObject('poi', at, 'floor-ground', id);
    poi.id = id;
    project.objects.push(poi);
    graph.nodes.push({ id, floorId: room.floorId, position: at, objectId: id });
  }
  const access = graph.nodes.map(n => ({ spaceId: room.id, nodeId: n.id }));
  const build = () => {
    const built = buildRoomNavigation(project, access, graph);
    return { ...project, navNodes: built.nodes, navEdges: built.edges };
  };
  return { project, room, graph, access, build };
}

describe('core room navigation', () => {
  it('connects aligned doors directly without visiting a room centre or corner', () => {
    const f = fixture(rectangle([0, 0], 12, 8), [
      [-6, 2],
      [6, 2],
    ]);
    const original = JSON.stringify([f.project, f.graph]);
    const route = findRoute(f.build(), 'entry', 'exit')!;
    expect(route.nodes.map(n => n.position)).toEqual([
      [-6, 2],
      [6, 2],
    ]);
    expect(route.distance).toBe(12);
    expect(JSON.stringify([f.project, f.graph])).toBe(original);
    const first = buildRoomNavigation(f.project, f.access, f.graph);
    expect(buildRoomNavigation(f.project, f.access, first)).toEqual(first);
  });

  it.each(['hole', 'pool', 'clockwise hole', 'clockwise pool'] as const)(
    'goes around a %s, including when routing from a point',
    kind => {
      const f = fixture();
      const obstacle = rectangle([0, 0], 4, 4);
      if (kind.startsWith('clockwise')) {
        obstacle.reverse();
        f.room.rings![0].reverse();
      }
      if (kind.endsWith('hole')) f.room.rings!.push(obstacle);
      else {
        const pool = createObject('zone', [0, 0], 'floor-ground', 'Pool');
        pool.rings = [obstacle];
        pool.parentId = f.room.id;
        pool.water = { depth: 1.5 };
        f.project.objects.push(pool);
      }
      const project = f.build();
      const route = findRoute(project, { floorId: 'floor-ground', position: [-5, 0] }, 'exit')!;
      expect(route.distance).toBeGreaterThan(11);
      expect(route.distance).toBeLessThan(15);
      expect(route.nodes[0].position).toEqual([-5, 0]);
      for (const leg of route.legs)
        for (let t = 0; t <= 1; t += 0.02) {
          const at: Point = [
            leg.from.position[0] * (1 - t) + leg.to.position[0] * t,
            leg.from.position[1] * (1 - t) + leg.to.position[1] * t,
          ];
          expect(pointInRing(at, obstacle)).toBe(false);
          expect(
            Math.min(...obstacle.map((a, i) => segmentProjection(at, a, obstacle[(i + 1) % obstacle.length]).distance)),
          ).toBeGreaterThanOrEqual(0.399);
        }
      expect(findRoute(project, { floorId: 'floor-ground', position: [0, 0] }, 'exit')).toBeNull();
    },
  );

  it.each([0, 37, 90, -37])('keeps a path inside a concave room rotated by %s degrees', angle => {
    const ring: Ring = [
      [0, 0],
      [8, 0],
      [8, 3],
      [3, 3],
      [3, 8],
      [0, 8],
    ];
    const rotated = ring.map(p => rotate(p, angle));
    if (angle < 0) rotated.reverse();
    const f = fixture(
      rotated,
      [
        [7, 1.5],
        [1.5, 7],
      ].map(p => rotate(p as Point, angle)),
    );
    f.room.position = rotate([1.5, 1.5], angle);
    const route = findRoute(f.build(), 'entry', 'exit')!;
    expect(route).not.toBeNull();
    expect(route.distance).toBeGreaterThan(distance(route.nodes[0].position, route.nodes.at(-1)!.position));
    for (const leg of route.legs)
      for (let t = 0.01; t < 1; t += 0.03)
        expect(
          pointInRing(
            [
              leg.from.position[0] * (1 - t) + leg.to.position[0] * t,
              leg.from.position[1] * (1 - t) + leg.to.position[1] * t,
            ],
            rotated,
          ),
        ).toBe(true);
  });

  it('preserves controlled one-way crossings between separate room access nodes', () => {
    const f = fixture(rectangle([-3, 0], 6, 8), [
      [-5, 0],
      [5, 0],
    ]);
    f.room.position = [-3, 0];
    const other = createObject('room', [3, 0], 'floor-ground', 'Office');
    other.id = 'office';
    other.rings = [rectangle([3, 0], 6, 8)];
    f.project.objects.push(other);
    f.graph.nodes.push(
      { id: 'side-a', floorId: 'floor-ground', position: [0, 0] },
      { id: 'side-b', floorId: 'floor-ground', position: [0, 0] },
    );
    f.graph.edges.push({ id: 'controlled', kind: 'door', aId: 'side-a', bId: 'side-b', directed: true, weight: 2 });
    const graph = buildRoomNavigation(
      f.project,
      [
        { spaceId: 'hall', nodeId: 'entry' },
        { spaceId: 'hall', nodeId: 'side-a' },
        { spaceId: 'office', nodeId: 'exit' },
        { spaceId: 'office', nodeId: 'side-b' },
      ],
      f.graph,
    );
    const p = { ...f.project, navNodes: graph.nodes, navEdges: graph.edges };
    expect(findRoute(p, 'entry', 'exit')?.legs.some(l => l.edge.id === 'controlled')).toBe(true);
    expect(findRoute(p, 'exit', 'entry')).toBeNull();
    expect(graph.edges.find(e => e.id === 'controlled')).toEqual(f.graph.edges[0]);
  });

  it('accounts for wall thickness, a 90 cm door, and sealed walls', () => {
    const f = fixture();
    f.project.junctions.push(
      { id: 'a', floorId: 'floor-ground', position: [0, -4] },
      { id: 'b', floorId: 'floor-ground', position: [0, 4] },
    );
    f.project.barriers.push({
      id: 'wall',
      floorId: 'floor-ground',
      kind: 'wall',
      name: 'Partition',
      startId: 'a',
      endId: 'b',
      thickness: 0.2,
      height: 3,
    });
    expect(findRoute(f.build(), 'entry', 'exit')).toBeNull();
    const door = createObject('door', [0, 0], 'floor-ground', 'Door');
    door.barrierId = 'wall';
    door.offset = 4;
    door.width = 0.9;
    f.project.objects.push(door);
    const clear = createRouteClearance(f.project)('floor-ground');
    expect(clear([-3, 0], [3, 0])).toBe(true);
    expect(clear([-3, 1], [3, 1])).toBe(false);
    expect(clear([-0.3, 1], [-0.3, 3])).toBe(false);
    expect(findRoute(f.build(), 'entry', 'exit')?.distance).toBe(12);
  });
});
