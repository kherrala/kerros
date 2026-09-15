import { describe, expect, it } from 'vitest';
import { addBarrier, barrierEnds, createObject, distance, openRing, rectangle, rotate, type Point } from '../schema';
import { newProject } from './testFixtures';
import { snapDragPoint } from './walls';
import { applyGeometryDrag, dragGeometry, encloseRoom } from './authoring';
import { transact, validateProject } from './validate';

const at = (x: number, y: number, angle = 17): Point => rotate([x + 0.13, y + 0.27], angle);

describe('snapping connected geometry while dragging', () => {
  it('rejects an invalid released drop atomically, then accepts the next drop', () => {
    const p = newProject();
    const wall = addBarrier(p, [0, 0], [3, 0], 'floor-ground', 'wall')!;
    const original = structuredClone(p);
    // Snapping deliberately permits the invalid preview. Only release enters the transaction.
    const point = snapDragPoint(p, 'floor-ground', 'junction', wall.endId, [0.001, 0], true, 0.1);
    expect(point).toEqual([0, 0]);
    const rejected = transact(p, draft => applyGeometryDrag(draft, { kind: 'junction', id: wall.endId, point }));
    expect(rejected.ok).toBe(false);
    expect(p).toEqual(original);
    const accepted = transact(p, draft =>
      applyGeometryDrag(draft, { kind: 'junction', id: wall.endId, point: [4, 0] }),
    );
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) throw new Error(accepted.error);
    expect(barrierEnds(accepted.project, accepted.project.barriers[0])).toEqual([
      [0, 0],
      [4, 0],
    ]);
    expect(() => validateProject(accepted.project)).not.toThrow();
  });
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
  it.each([0, 17, 41])('restores a distorted rectangle corner rotated %i degrees', angle => {
    const p = newProject();
    const corners = [at(0, 0, angle), at(6.37, 0, angle), at(6.37, 4.82, angle), at(0, 4.82, angle)];
    for (let i = 0; i < 4; i++) addBarrier(p, corners[i], corners[(i + 1) % 4], 'floor-ground', 'wall');
    encloseRoom(p, 'floor-ground', at(3, 2, angle));
    // A local rectangle may not follow the overall floor's axis or its half-metre grid.
    const plate = createObject('zone', [0, 0], 'floor-ground');
    plate.rings = [rectangle([0, 0], 30, 20, 11)];
    p.objects.push(plate);
    const id = p.barriers[1].endId;
    const distorted = transact(p, draft =>
      applyGeometryDrag(draft, { kind: 'junction', id, point: at(7.1, 3.9, angle) }),
    );
    if (!distorted.ok) throw new Error(distorted.error);
    const before = structuredClone(distorted.project);
    const raw = at(6.4, 4.86, angle);
    const preview = snapDragPoint(distorted.project, 'floor-ground', 'junction', id, raw, true, 0.15);
    expect(distance(preview, corners[2])).toBeLessThan(1e-8);
    expect(distorted.project).toEqual(before);
    const restored = transact(distorted.project, draft =>
      applyGeometryDrag(draft, { kind: 'junction', id, point: preview }),
    );
    if (!restored.ok) throw new Error(restored.error);
    for (let i = 0; i < 4; i++) {
      const ends = barrierEnds(restored.project, restored.project.barriers[i]);
      expect(distance(ends[0], corners[i])).toBeLessThan(1e-8);
      expect(distance(ends[1], corners[(i + 1) % 4])).toBeLessThan(1e-8);
    }
    expect(() => validateProject(restored.project)).not.toThrow();
    expect(snapDragPoint(distorted.project, 'floor-ground', 'junction', id, raw, false, 0.15)).toEqual(raw);
  });
  it.each([
    { ringIndex: 0, index: 0 },
    { ringIndex: 0, index: 3 },
    { ringIndex: 1, index: 0 },
    { ringIndex: 1, index: 3 },
  ])('restores independent ring $ringIndex vertex $index', ({ ringIndex, index }) => {
    const p = newProject();
    const room = createObject('room', [0, 0], 'floor-ground');
    room.rings = [rectangle(at(0, 0), 20, 20, 17), rectangle(at(3, 3), 4.37, 3.82, 17)];
    p.objects.push(room);
    const target = openRing(room.rings[ringIndex])[index];
    const distorted = transact(p, draft =>
      applyGeometryDrag(draft, {
        kind: 'ring',
        id: room.id,
        ringIndex,
        index,
        point: [target[0] + 0.7, target[1] - 0.6],
      }),
    );
    if (!distorted.ok) throw new Error(distorted.error);
    const raw: Point = [target[0] + 0.035, target[1] - 0.025];
    const preview = snapDragPoint(
      distorted.project,
      'floor-ground',
      'ring',
      room.id,
      raw,
      true,
      0.15,
      ringIndex,
      index,
    );
    expect(distance(preview, target)).toBeLessThan(1e-8);
    const restored = transact(distorted.project, draft =>
      applyGeometryDrag(draft, {
        kind: 'ring',
        id: room.id,
        ringIndex,
        index,
        point: preview,
      }),
    );
    if (!restored.ok) throw new Error(restored.error);
    expect(restored.project.objects[0].rings![1 - ringIndex]).toEqual(room.rings[1 - ringIndex]);
    expect(distance(openRing(restored.project.objects[0].rings![ringIndex])[index], target)).toBeLessThan(1e-8);
    expect(
      snapDragPoint(distorted.project, 'floor-ground', 'ring', room.id, raw, false, 0.15, ringIndex, index),
    ).toEqual(raw);
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
  it('bounds corner alignment by the snap reach and keeps receiving junctions first', () => {
    const p = newProject();
    const points = [at(0, 0), at(6.37, 0), at(7.1, 3.9), at(0, 4.82)];
    for (let i = 0; i < 4; i++) addBarrier(p, points[i], points[(i + 1) % 4], 'floor-ground', 'wall');
    const id = p.barriers[1].endId;
    const target = at(6.37, 4.82);
    const far = snapDragPoint(p, 'floor-ground', 'junction', id, at(6.57, 5.07), true, 0.05);
    expect(distance(far, target)).toBeGreaterThan(0.05);
    const receiving = at(6.41, 4.86);
    const next = transact(p, draft => {
      draft.junctions.push({ id: 'receiving', floorId: 'floor-ground', position: receiving });
    });
    if (!next.ok) throw new Error(next.error);
    const snapped = snapDragPoint(next.project, 'floor-ground', 'junction', id, at(6.39, 4.85), true, 0.15);
    expect(snapped).toEqual(receiving);
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
