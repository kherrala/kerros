import { describe, expect, it } from 'vitest';
import { addBarrier, barrierEnds, distance, rotate, type Point } from '../schema';
import { newProject } from './testFixtures';
import { snapDragPoint } from './walls';
import { dragGeometry } from './authoring';

const at = (x: number, y: number, angle = 17): Point => rotate([x + 0.13, y + 0.27], angle);

describe('snapping connected geometry while dragging', () => {
  it('keeps a junction on its original oblique centreline instead of rounding its x/y', () => {
    const p = newProject();
    addBarrier(p, at(0, 0), at(4, 0), 'floor-ground', 'wall');
    addBarrier(p, at(4, 0), at(8, 0), 'floor-ground', 'wall');
    const id = p.barriers[0].endId;
    const point = snapDragPoint(p, 'floor-ground', 'junction', id, at(5.1, 0.03), true, 0.15);
    expect(distance(point, at(5.1, 0))).toBeLessThan(1e-8);
    const next = dragGeometry(p, 'floor-ground', { kind: 'junction', id, point });
    expect(distance(next.junctions.find(j => j.id === id)!.position, point)).toBeLessThan(1e-8);
  });
  it('snaps a free endpoint to the half-metre grid and honours Shift/no snapping', () => {
    const p = newProject();
    const b = addBarrier(p, [0, 0], [3, 0], 'floor-ground', 'wall')!;
    const raw: Point = [4.12, 1.34];
    expect(snapDragPoint(p, 'floor-ground', 'junction', b.endId, raw, true, 0.001)).toEqual([4, 1.5]);
    expect(snapDragPoint(p, 'floor-ground', 'junction', b.endId, raw, false, 0.2)).toEqual(raw);
  });
  it.each([0, 17, 41])('slides a wall into line with its neighbour in a floor rotated %i degrees', angle => {
    const p = newProject();
    const selected = addBarrier(p, at(0, 0, angle), at(4, 0, angle), 'floor-ground', 'wall')!;
    addBarrier(p, at(4, 0, angle), at(8, 1.23, angle), 'floor-ground', 'wall');
    const raw = at(2, 1.2, angle);
    const point = snapDragPoint(p, 'floor-ground', 'barrier', selected.id, raw, true, 0.1);
    expect(distance(point, at(2, 1.23, angle))).toBeLessThan(1e-8);
    const next = dragGeometry(p, 'floor-ground', { kind: 'barrier', id: selected.id, point });
    const [a, b] = barrierEnds(next, next.barriers.find(b => b.id === selected.id)!);
    expect(distance(a, at(0, 1.23, angle))).toBeLessThan(1e-8);
    expect(distance(b, at(4, 1.23, angle))).toBeLessThan(1e-8);
  });
});

it.each([15, 30, 45, 60, 75])('snaps an adjacent wall to a nearby %i° floor direction', angle => {
  const p = newProject();
  const selected = addBarrier(p, [0, 0], [20, 0], 'floor-ground', 'wall')!;
  addBarrier(p, [20, 0], [24, 10], 'floor-ground', 'wall');
  const y = 10 - 4 * Math.tan((angle * Math.PI) / 180);
  const point = snapDragPoint(p, 'floor-ground', 'barrier', selected.id, [10, y + 0.015], true, 0.1);
  expect(point[1]).toBeCloseTo(y, 8);
});
