import { describe, expect, it } from 'vitest';
import { addFloor, newProject } from '../model/testFixtures';
import { createObject } from '../model/factory';
import { addBarrier, pointInRing, rectangle, rotate } from '../model/geometry';
import { floorDropAt, floorSupport, supportedStep, tallSpaceContext, walkingWallRings } from './walkSurfaces';
import { StairWalker } from './stairSurfaces';

function levels() {
  const p = newProject(),
    top = p.floors[0];
  top.elevation = 4;
  const bottom = addFloor(p, 'lower', 0);
  const upper = createObject('room', [0, 0], top.id, 'Gallery');
  upper.rings = [rectangle([0, 0], 12, 12), rectangle([0, 0], 4, 6).reverse()];
  const lower = createObject('room', [0, 0], bottom, 'Double-height hall');
  lower.rings = [rectangle([0, 0], 12, 12)];
  lower.ceilingHeight = 7;
  p.objects.push(upper, lower);
  return { p, top, bottom, upper, lower };
}

describe('floor openings in POV', () => {
  it('drops through a rectangular hole to the nearest supporting floor, preserving plan coordinates', () => {
    const { p, top, bottom } = levels();
    expect(floorDropAt(p, top.id, [0.4, 1])).toEqual({ floorId: bottom, distance: 4 });
    expect(floorDropAt(p, top.id, [4, 1])).toBeUndefined();
    expect(floorDropAt(p, top.id, [20, 20])).toBeUndefined();
    expect(floorDropAt(p, bottom, [0.4, 1])).toBeUndefined();
  });
  it('does not fall through a hole covered by another real slab', () => {
    const { p, top } = levels();
    const cover = createObject('zone', [0, 0], top.id, 'Bridge');
    cover.rings = [rectangle([0, 0], 2, 8)];
    p.objects.push(cover);
    expect(floorDropAt(p, top.id, [0, 0])).toBeUndefined();
    expect(floorDropAt(p, top.id, [1.5, 0])?.distance).toBe(4);
  });
  it('skips another hole below and refuses an unsupported or unrelated building landing', () => {
    const { p, top, lower } = levels();
    lower.rings!.push(rectangle([0, 0], 4, 4).reverse());
    expect(floorDropAt(p, top.id, [0, 0])).toBeUndefined();
    const bottom = addFloor(p, 'lowest', -4);
    const room = createObject('room', [0, 0], bottom, 'Lowest hall');
    room.rings = [rectangle([0, 0], 12, 12)];
    p.objects.push(room);
    expect(floorDropAt(p, top.id, [0, 0])).toEqual({ floorId: bottom, distance: 8 });
    p.floors.find(f => f.id === bottom)!.buildingId = 'elsewhere';
    expect(floorDropAt(p, top.id, [0, 0])).toBeUndefined();
  });
  it('shows the lower hall through the upper hole and the upper gallery from below', () => {
    const { p, top, bottom, upper, lower } = levels();
    expect(tallSpaceContext(p, top.id)).toContain(lower);
    expect(tallSpaceContext(p, bottom)).toContain(upper);
  });
});

describe('walking support at floor edges', () => {
  it('stops at a rotated outer edge without snapping onto a lower plate', () => {
    const { p, top, upper } = levels();
    upper.rings = [rectangle([0, 0], 12, 12, 37)];
    const support = floorSupport(p);
    const from = rotate([5.9, 0], 37),
      to = rotate([6.1, 0], 37);
    expect(support.supports(to, top.id)).toBe(false);
    const at = supportedStep(from, to, at => support.supports(at, top.id));
    expect(rotate(at, -37)[0]).toBeCloseTo(6, 4);
    expect(support.supports(at, top.id)).toBe(true);
    expect(support.dropAt(to, top.id)).toBeUndefined();
  });

  it('allows a gallery drop with a landing and blocks an unsupported hole', () => {
    const { p, top, lower } = levels();
    expect(floorSupport(p).supports([0, 0], top.id)).toBe(true);
    lower.rings!.push(rectangle([0, 0], 4, 6).reverse());
    const support = floorSupport(p);
    expect(support.supports([0, 0], top.id)).toBe(false);
    expect(support.supports([4, 0], top.id)).toBe(true);
    expect(support.dropAt([0, 0], top.id)).toBeUndefined();
  });

  it('uses overlapping slabs and wall thresholds without filling uncovered holes', () => {
    const { p, top } = levels();
    const bridge = createObject('room', [0, 0], top.id, 'Bridge');
    bridge.rings = [rectangle([0, 0], 1, 8)];
    p.objects.push(bridge);
    const room = createObject('room', [8, 0], top.id, 'Adjacent room');
    room.rings = [rectangle([8.1, 0], 4, 4)];
    p.objects.push(room);
    addBarrier(p, [6.05, -2], [6.05, 2], top.id, 'wall');
    const support = floorSupport(p);
    expect(support.supports([0, 0], top.id)).toBe(true);
    expect(support.dropAt([0, 0], top.id)).toBeUndefined();
    expect(support.supports([6.05, 0], top.id)).toBe(true);
    expect(support.dropAt([1.5, 0], top.id)?.distance).toBe(4);
  });

  it('keeps grade, outdoors and unmodelled floors traversable but constrains buried edges', () => {
    const { p, bottom } = levels();
    const empty = addFloor(p, 'empty', 12);
    let support = floorSupport(p);
    expect(support.supports([20, 20], bottom)).toBe(true);
    expect(support.supports([20, 20], null)).toBe(true);
    expect(support.supports([20, 20], empty)).toBe(true);
    p.floors.find(f => f.id === bottom)!.elevation = -4;
    support = floorSupport(p);
    expect(support.supports([20, 20], bottom)).toBe(false);
  });

  it('applies plate support to walking but accepts reachable stair treads over a void', () => {
    const walker = new StairWalker();
    walker.sync('upper', 4);
    const supports = (at: number[]) => at[0] < 1;
    const edge = walker.step([0.9, 0], [1.1, 0], [], 'upper', 4, supports);
    expect(edge[0]).toBeCloseTo(1, 4);
    expect(edge[0]).toBeLessThan(1);
    const tread = {
      flightId: 'stairs',
      fromFloor: 'upper',
      toFloor: 'roof',
      low: 4,
      high: 8,
      ring: rectangle([1, 0], 1, 1),
      height: () => 4.1,
    };
    expect(walker.step([0.9, 0], [1.1, 0], [tread], 'upper', 4, supports)).toEqual([1.1, 0]);
    expect(walker.height).toBe(4.1);
  });
});

describe('host-storey wall collision', () => {
  it('blocks a host wall at mezzanine height, including the lintel above a lower-floor door', () => {
    const { p, top, bottom } = levels();
    top.mezzanine = true;
    const id = addBarrier(p, [-6, 0], [6, 0], bottom, 'wall')!.id;
    p.barriers.find(b => b.id === id)!.height = 7;
    const door = createObject('door', [0, 0], bottom, 'Lower doorway');
    Object.assign(door, { barrierId: id, offset: 6, width: 1.2, height: 2.1 });
    p.objects.push(door);
    const hits = (floor: string, x: number) => walkingWallRings(p, floor).some(r => pointInRing([x, 0], r));
    expect(hits(bottom, 0)).toBe(false);
    expect(hits(bottom, 3)).toBe(true);
    expect(hits(top.id, 0)).toBe(true);
    expect(hits(top.id, 3)).toBe(true);
    p.barriers.find(b => b.id === id)!.height = 3;
    expect(hits(top.id, 3)).toBe(false);
  });

  it('ignores other buildings and higher storeys and retains an active-floor doorway', () => {
    const { p, top, bottom } = levels();
    const id = addBarrier(p, [-6, 0], [6, 0], top.id, 'wall')!.id;
    const door = createObject('door', [0, 0], top.id, 'Gallery doorway');
    Object.assign(door, { barrierId: id, offset: 6, width: 1.2, height: 2.1 });
    p.objects.push(door);
    expect(walkingWallRings(p, top.id).some(r => pointInRing([0, 0], r))).toBe(false);
    expect(walkingWallRings(p, bottom).length).toBe(0);
    const lowerWall = addBarrier(p, [-6, 1], [6, 1], bottom, 'wall')!.id;
    p.barriers.find(b => b.id === lowerWall)!.height = 8;
    p.floors.find(f => f.id === bottom)!.buildingId = 'other-building';
    expect(walkingWallRings(p, top.id).some(r => pointInRing([0, 1], r))).toBe(false);
  });
});
