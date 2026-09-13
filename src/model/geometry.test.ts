import { describe, expect, it } from 'vitest';
import {
  addBarrier,
  alignDrawing,
  barrierEnds,
  distance,
  duplicateFloor,
  joinAt,
  objectArea,
  removeFloor,
  slopeElevation,
  snapPoint,
  splitRoom,
  toLngLat,
  toLocal,
} from './geometry';
import { createObject } from './factory';
import { validateProject, validateRelationships, validateRings } from './validate';
import { newProject, sampleProject } from './testFixtures';
import type { Point } from './types';

const square: Point[] = [
  [0, 0],
  [10, 0],
  [10, 10],
  [0, 10],
  [0, 0],
];

describe('metric transformations', () => {
  it('round-trips local coordinates through WGS84', () => {
    const origin = newProject().origin;
    const point: Point = [123.45, -67.89];
    const back = toLocal(toLngLat(point, origin), origin);
    expect(distance(point, back)).toBeLessThan(0.001);
  });
});

describe('snapping', () => {
  it('prefers junction endpoints within tolerance', () => {
    const p = newProject();
    addBarrier(p, [0, 0], [10, 0], 'floor-ground', 'wall');
    const snap = snapPoint(p, 'floor-ground', [0.3, 0.2], 0.7);
    expect(snap.label).toBe('Endpoint');
    expect(snap.point).toEqual([0, 0]);
  });
  it('falls back to the 0.5 m grid', () => {
    const snap = snapPoint(newProject(), 'floor-ground', [3.2, 4.8], 0.7);
    expect(snap.point).toEqual([3, 5]);
    expect(snap.label).toBe('0.5 m grid');
  });
});

describe('connected barriers', () => {
  it('resolves endpoints after transaction-style mutations of an indexed junction array', () => {
    const p = newProject();
    const wall = addBarrier(p, [0, 0], [10, 0], 'floor-ground', 'wall')!;
    expect(barrierEnds(p, wall)).toEqual([
      [0, 0],
      [10, 0],
    ]);
    p.junctions[0].position = [1, 2];
    expect(barrierEnds(p, wall)[0]).toEqual([1, 2]);
    p.junctions.reverse();
    expect(barrierEnds(p, wall)).toEqual([
      [1, 2],
      [10, 0],
    ]);
    p.junctions[0] = { ...p.junctions[0], position: [8, 3] };
    expect(barrierEnds(p, wall)[1]).toEqual([8, 3]);
    p.junctions.splice(1, 1, { id: 'replacement', floorId: 'floor-ground', position: [4, 5] });
    wall.startId = 'replacement';
    expect(barrierEnds(p, wall)[0]).toEqual([4, 5]);
    p.junctions.push({ id: 'new', floorId: 'floor-ground', position: [7, 6] });
    wall.endId = 'new';
    expect(barrierEnds(p, wall)[1]).toEqual([7, 6]);
  });
  it('looks up a large floor in linear work rather than scanning every junction per wall', () => {
    const p = newProject();
    let reads = 0;
    p.junctions = Array.from({ length: 2000 }, (_, i) => ({
      get id() {
        reads++;
        return `j${i}`;
      },
      floorId: 'floor-ground',
      position: [i, 0] as Point,
    }));
    const wall = { ...sampleProject().barriers[0], startId: '', endId: '' };
    for (let i = 0; i < 1999; i++) {
      wall.startId = `j${i}`;
      wall.endId = `j${i + 1}`;
      expect(barrierEnds(p, wall)).toEqual([
        [i, 0],
        [i + 1, 0],
      ]);
    }
    expect(reads).toBeLessThan(20_000);
  });
  it('splits an existing wall when a new junction lands on it', () => {
    const p = newProject();
    addBarrier(p, [0, 0], [10, 0], 'floor-ground', 'wall');
    addBarrier(p, [5, 0], [5, 8], 'floor-ground', 'wall');
    expect(p.barriers).toHaveLength(3);
    expect(p.junctions).toHaveLength(4);
  });
  it('refuses to split a wall through an attached opening', () => {
    const p = newProject();
    addBarrier(p, [0, 0], [10, 0], 'floor-ground', 'wall');
    const door = createObject('door', [5, 0], 'floor-ground');
    door.barrierId = p.barriers[0].id;
    door.offset = 5;
    p.objects.push(door);
    expect(() => joinAt(p, [5, 0], 'floor-ground')).toThrow(/split an opening/);
  });
  it('reassigns openings past the cut to the new segment', () => {
    const p = newProject();
    addBarrier(p, [0, 0], [10, 0], 'floor-ground', 'wall');
    const door = createObject('door', [8, 0], 'floor-ground');
    door.barrierId = p.barriers[0].id;
    door.offset = 8;
    p.objects.push(door);
    joinAt(p, [4, 0], 'floor-ground');
    const barrier = p.barriers.find(b => b.id === door.barrierId)!;
    expect(door.offset).toBe(4);
    expect(distance(...barrierEnds(p, barrier))).toBeCloseTo(6);
  });
});

describe('area validation', () => {
  it('rejects self-intersecting rings', () => {
    expect(
      validateRings([
        [
          [0, 0],
          [4, 0],
          [4, 4],
          [2, 4],
          [2, -1],
          [0, 0],
        ],
      ]),
    ).toMatch(/cross/);
    expect(validateRings([square])).toBeNull();
  });
  it('requires holes inside the outer boundary', () => {
    expect(
      validateRings([
        square,
        [
          [20, 20],
          [22, 20],
          [22, 22],
          [20, 22],
          [20, 20],
        ],
      ]),
    ).toMatch(/inside/);
    expect(
      validateRings([
        square,
        [
          [2, 2],
          [4, 2],
          [4, 4],
          [2, 4],
          [2, 2],
        ],
      ]),
    ).toBeNull();
  });
});

describe('relationship validation', () => {
  it('rejects overlapping openings on one barrier', () => {
    const p = newProject();
    addBarrier(p, [0, 0], [10, 0], 'floor-ground', 'wall');
    for (const offset of [5, 5.4]) {
      const door = createObject('door', [offset, 0], 'floor-ground');
      door.barrierId = p.barriers[0].id;
      door.offset = offset;
      p.objects.push(door);
    }
    expect(validateRelationships(p)).toMatch(/overlap/);
  });
  it('rejects openings wider than their barrier allows', () => {
    const p = newProject();
    addBarrier(p, [0, 0], [2, 0], 'floor-ground', 'wall');
    const gate = createObject('gate', [1, 0], 'floor-ground');
    gate.barrierId = p.barriers[0].id;
    gate.offset = 1;
    gate.width = 4;
    p.objects.push(gate);
    expect(validateRelationships(p)).toMatch(/too short/);
  });
});

describe('floor duplication', () => {
  it('creates fresh IDs, stacks the copy on top and clears feed bindings', () => {
    const p = sampleProject();
    const before = structuredClone(p);
    const newId = duplicateFloor(p, 'floor-ground');
    const copy = p.floors.find(f => f.id === newId)!;
    expect(copy.elevation).toBe(Math.max(...before.floors.map(f => f.elevation + f.height)));
    const copied = p.objects.filter(o => o.floorId === newId);
    expect(copied.length).toBe(before.objects.filter(o => o.floorId === 'floor-ground').length);
    expect(copied.every(o => o.feedId === undefined)).toBe(true);
    const originalIds = new Set(before.objects.map(o => o.id));
    expect(copied.some(o => originalIds.has(o.id))).toBe(false);
    expect(validateRelationships(p)).toBeNull();
  });
});

describe('drawing alignment', () => {
  it('derives scale, rotation and origin from two point pairs', () => {
    // 100 px apart on the image, 10 m apart on the map, rotated 90°.
    const result = alignDrawing(
      [
        [0, 0],
        [100, 0],
      ],
      [
        [0, 0],
        [0, 10],
      ],
    );
    expect(result.scale).toBeCloseTo(0.1);
    expect(((result.rotation % 360) + 360) % 360).toBeCloseTo(90);
    expect(result.origin[0]).toBeCloseTo(0);
    expect(result.origin[1]).toBeCloseTo(0);
  });
  it('rejects degenerate point pairs', () => {
    expect(() =>
      alignDrawing(
        [
          [0, 0],
          [0, 0],
        ],
        [
          [0, 0],
          [5, 5],
        ],
      ),
    ).toThrow(/distinct/);
  });
});

describe('room splitting', () => {
  it('cuts a room into two along a chord, builds a partition and keeps areas', () => {
    const p = newProject();
    const room = createObject('room', [5, 5], 'floor-ground', 'Hall');
    room.rings = [square.map(pt => [...pt] as Point)];
    room.width = 10;
    room.depth = 10;
    p.objects.push(room);
    const twinId = splitRoom(p, room.id, [4, 0], [4, 10]);
    const twin = p.objects.find(o => o.id === twinId)!;
    expect(Math.round(objectArea(room) + objectArea(twin))).toBe(100);
    expect(Math.round(objectArea(room))).toBe(60);
    expect(p.barriers.filter(b => b.name === 'Partition')).toHaveLength(1);
    expect(validateRelationships(p)).toBeNull();
  });
  it('accepts a stroke drawn well past both walls (overshoot) and still cuts the room', () => {
    const p = newProject();
    const room = createObject('room', [5, 5], 'floor-ground', 'Hall');
    room.rings = [square.map(pt => [...pt] as Point)];
    p.objects.push(room);
    // Start 3 m below the bottom wall, end 3 m above the top wall.
    const twinId = splitRoom(p, room.id, [5, -3], [5, 13]);
    const twin = p.objects.find(o => o.id === twinId)!;
    expect(Math.round(objectArea(room))).toBe(50);
    expect(Math.round(objectArea(twin))).toBe(50);
    // The partition spans only the room interior (10 m), not the overshoot.
    const partition = p.barriers.find(b => b.name === 'Partition')!;
    const [a, b] = barrierEnds(p, partition);
    expect(Math.round(distance(a, b))).toBe(10);
    expect(validateRelationships(p)).toBeNull();
  });
  it('rejects a line that never crosses the room', () => {
    const p = newProject();
    const room = createObject('room', [5, 5], 'floor-ground', 'Hall');
    room.rings = [square.map(pt => [...pt] as Point)];
    p.objects.push(room);
    expect(() => splitRoom(p, room.id, [20, 0], [20, 10])).toThrow(/cross the room/);
  });
  it('splits a room with a hole: both halves stay valid and the partition skips the courtyard', () => {
    const p = newProject();
    const room = createObject('room', [5, 5], 'floor-ground', 'Hall');
    room.rings = [
      square.map(pt => [...pt] as Point),
      [
        [4, 4],
        [6, 4],
        [6, 6],
        [4, 6],
        [4, 4],
      ],
    ];
    p.objects.push(room);
    const twinId = splitRoom(p, room.id, [5, -1], [5, 11]);
    const twin = p.objects.find(o => o.id === twinId)!;
    // Outer 100 − hole 4 = 96, shared evenly (the cut halves the courtyard too).
    expect(Math.round(objectArea(room) + objectArea(twin))).toBe(96);
    // The cut through the 2×2 courtyard leaves two solid spans (below and above it), so two partitions.
    expect(p.barriers.filter(b => b.name === 'Partition')).toHaveLength(2);
    expect(validateRelationships(p)).toBeNull();
  });
});

describe('sloped areas', () => {
  const slope = {
    axis: [
      [0, 0],
      [10, 0],
    ] as [Point, Point],
    high: 0,
    low: -5,
  };
  it('lerps elevation along the axis and clamps past both ends', () => {
    expect(slopeElevation(slope, [0, 0])).toBeCloseTo(0);
    expect(slopeElevation(slope, [5, 0])).toBeCloseTo(-2.5);
    expect(slopeElevation(slope, [10, 0])).toBeCloseTo(-5);
    // Off-axis points project onto the axis; points beyond an end keep that end's elevation (flat apron).
    expect(slopeElevation(slope, [5, 8])).toBeCloseTo(-2.5);
    expect(slopeElevation(slope, [-4, 0])).toBeCloseTo(0);
    expect(slopeElevation(slope, [18, 0])).toBeCloseTo(-5);
  });
});

describe('removing a floor', () => {
  it('takes its contents and every dangling reference with it', () => {
    const p = sampleProject();
    const doomed = duplicateFloor(p, 'floor-ground');
    const survivor = 'floor-ground';
    // Wire the doomed floor into everything that can point at it.
    addBarrier(p, [0, 0], [8, 0], doomed, 'wall');
    const wall = p.barriers.find(b => b.floorId === doomed)!;
    const door = createObject('door', [4, 0], doomed, 'Doomed door');
    door.barrierId = wall.id;
    door.offset = 4;
    p.objects.push(door);
    const room = createObject('room', [2, 2], doomed, 'Doomed room');
    p.objects.push(room);
    const lift = createObject('elevator', [1, 1], survivor, 'Lift');
    lift.servedFloorIds = [survivor, doomed];
    p.objects.push(lift);
    const camera = createObject('camera', [3, 3], survivor, 'Camera');
    camera.watchedIds = [room.id];
    p.objects.push(camera);
    const child = createObject('zone', [2, 2], survivor, 'Child');
    child.parentId = room.id;
    p.objects.push(child);
    p.initialFloorId = doomed;
    p.buildings[0].roof = { floorId: doomed, color: '#888', sections: [] };

    const removed = removeFloor(p, doomed);

    expect(p.floors.some(f => f.id === doomed)).toBe(false);
    expect(removed).toContain(doomed);
    for (const list of [p.objects, p.barriers, p.junctions, p.drawings])
      expect((list as { floorId: string | null }[]).some(x => x.floorId === doomed)).toBe(false);
    // References that would otherwise dangle are cleared, not left pointing at nothing.
    expect(p.objects.find(o => o.id === lift.id)!.servedFloorIds).toEqual([survivor]);
    expect(p.objects.find(o => o.id === camera.id)!.watchedIds).toBeUndefined();
    expect(p.objects.find(o => o.id === child.id)!.parentId).toBeUndefined();
    expect(p.initialFloorId).toBeUndefined();
    expect(p.buildings[0].roof).toBeUndefined();
    // The strongest check: the document is still loadable.
    expect(validateRelationships(p)).toBeNull();
    expect(() => validateProject(JSON.parse(JSON.stringify(p)))).not.toThrow();
  });

  it('refuses to remove the last floor, and an unknown one', () => {
    const p = newProject();
    expect(() => removeFloor(p, p.floors[0].id)).toThrow(/at least one floor/);
    expect(() => removeFloor(p, 'nope')).toThrow(/not part of this project/);
  });
});
