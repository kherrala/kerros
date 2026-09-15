import { describe, expect, it } from 'vitest';
import { appendAreaPoint, dragGeometry, drawBarrier, encloseRoom, endsBoundaryStroke } from './authoring';
import { addVirtualBoundary } from './boundaries';
import { createObject } from './factory';
import {
  addBarrier,
  barrierEnds,
  distance,
  holdAngle,
  objectArea,
  rectangle,
  rotate,
  snapPoint,
  splitRoom,
  MIN_SEGMENT,
} from './geometry';
import { newProject } from './testFixtures';
import type { Point, ProjectDocument } from './types';
import { transact, validateProject, validateRings } from './validate';
import { axisDelta, axisOf, fitOpening, mainAxis, proposeWall } from './walls';

const floor = 'floor-ground';
function doorOn(project: ProjectDocument, offset: number, width = 1) {
  const door = createObject('door', [offset, 0], floor);
  Object.assign(door, { barrierId: project.barriers[0].id, offset, width });
  project.objects.push(door);
  return door;
}

describe('boundary stroke completion', () => {
  it.each(['wall', 'fence', 'boundary'] as const)('ends a stroke at a receiving %s', receiving => {
    const p = newProject();
    if (receiving === 'boundary') addVirtualBoundary(p, floor, [0, 6], [8, 6]);
    else addBarrier(p, [0, 6], [8, 6], floor, receiving);
    for (const kind of ['wall', 'fence', 'boundary'] as const) {
      expect(endsBoundaryStroke(p, floor, [4, 0], [4, 6], kind)).toBe(true);
      expect(endsBoundaryStroke(p, floor, [4, 0], [8, 6], kind)).toBe(true);
      expect(endsBoundaryStroke(p, floor, [0, 6], [0, 0], kind)).toBe(false);
      expect(endsBoundaryStroke(p, floor, [4, 0], [4, 8], kind)).toBe(false);
      expect(endsBoundaryStroke(p, floor, [4, 0], [4, 5.98], kind)).toBe(false);
      expect(endsBoundaryStroke(p, 'another-floor', [4, 0], [4, 6], kind)).toBe(false);
      expect(endsBoundaryStroke(p, floor, [8, 6], [8, 6], kind)).toBe(false);
    }
  });

  it('recognizes the closing segment of an outline', () => {
    const p = newProject();
    drawBarrier(p, floor, [0, 0], [8, 0]);
    drawBarrier(p, floor, [8, 0], [8, 6]);
    drawBarrier(p, floor, [8, 6], [0, 6]);
    expect(endsBoundaryStroke(p, floor, [0, 6], [0, 0])).toBe(true);
  });

  it('matches physical welding without treating a near miss on a virtual edge as connected', () => {
    const p = newProject();
    addBarrier(p, [0, 6], [8, 6], floor, 'wall');
    expect(endsBoundaryStroke(p, floor, [4, 0], [4, 6.0005])).toBe(true);
    expect(endsBoundaryStroke(p, floor, [4, 0], [0.005, 6])).toBe(true);
    expect(endsBoundaryStroke(p, floor, [4, 0], [4, 6.0005], 'boundary')).toBe(false);
    expect(endsBoundaryStroke(p, floor, [0, 6], [0.005, 6])).toBe(false);
    const virtual = newProject();
    addVirtualBoundary(virtual, floor, [0, 6], [8, 6]);
    expect(endsBoundaryStroke(virtual, floor, [4, 0], [4, 6.0005])).toBe(false);
  });
});

describe('authoring regressions', () => {
  it('holds all 15 degree increments relative to the main axis of a rotated floor', () => {
    const p = newProject();
    const plate = createObject('zone', [0, 0], floor);
    plate.rings = [rectangle([0, 0], 30, 12, 23)];
    p.objects.push(plate);
    expect(mainAxis(p, floor)).toBeCloseTo(23);
    for (let turn = 0; turn < 360; turn += 15) {
      const target = rotate([8, 0.1], 23 + turn);
      const snapped = snapPoint(p, floor, target, 0.3, [0, 0], false, mainAxis(p, floor));
      expect(Math.abs(axisDelta(axisOf([0, 0], snapped.point), 23 + turn))).toBeLessThan(1e-8);
      expect(holdAngle([0, 0], target, 23, 0.3)).not.toBeNull();
    }
  });

  it('keeps the angle when snapping onto the receiving wall', () => {
    const p = newProject();
    addBarrier(p, [0, 8], [12, 8], floor, 'wall');
    const square = snapPoint(p, floor, [4.2, 8.1], 0.5, [4, 0], false);
    expect(square.point[0]).toBeCloseTo(4);
    expect(square.point[1]).toBeCloseTo(8);
    const diagonal = snapPoint(p, floor, [7.7, 8.05], 0.5, [1, 1], false);
    expect(diagonal.point[0]).toBeCloseTo(8);
    expect(diagonal.point[1]).toBeCloseTo(8);
    expect(diagonal.label).toBe('45°');
  });

  it('snaps the fourth branch to the common T junction instead of making another nearby T', () => {
    const p = newProject();
    addBarrier(p, [0, 0], [10, 0], floor, 'wall');
    addBarrier(p, [5, 0], [5, -6], floor, 'wall');
    const junction = p.junctions.find(j => distance(j.position, [5, 0]) < 1e-8)!;
    const snapped = snapPoint(p, floor, [5.6, 0.05], 0.5, [5, 8], false);
    expect(snapped).toEqual({ point: [5, 0], label: 'Junction' });
    drawBarrier(p, floor, [5, 8], snapped.point);
    expect(p.barriers.filter(b => b.startId === junction.id || b.endId === junction.id)).toHaveLength(4);
    expect(p.junctions).toHaveLength(5);
    expect(() => validateProject(p)).not.toThrow();
  });

  it('welds a sub-minimum connection, and previews the welded position even at close zoom', () => {
    const p = newProject();
    addBarrier(p, [0, 0], [10, 0], floor, 'wall');
    expect(snapPoint(p, floor, [0.005, 0.0001], 0.0003).point).toEqual([0, 0]);
    drawBarrier(p, floor, [0.005, 0], [0.005, 5]);
    expect(p.barriers).toHaveLength(2);
    expect(p.barriers[1].startId).toBe(p.barriers[0].startId);
    expect(() => validateProject(p)).not.toThrow();
  });

  it('ignores repeated wall clicks and a wall drawn backwards over itself', () => {
    const p = newProject();
    drawBarrier(p, floor, [0, 0], [10, 0]);
    const before = structuredClone(p);
    drawBarrier(p, floor, [10, 0], [10, 0]);
    drawBarrier(p, floor, [10, 0], [0, 0]);
    expect(p).toEqual(before);
  });

  it('splits a room when the stroke lands exactly on its two boundaries', () => {
    const p = newProject();
    const room = createObject('room', [0, 0], floor);
    room.rings = [rectangle([0, 0], 10, 10)];
    p.objects.push(room);
    drawBarrier(p, floor, [0, -5], [0, 5]);
    expect(p.objects).toHaveLength(2);
    expect(p.objects.map(objectArea)).toEqual([50, 50]);
    expect(() => validateProject(p)).not.toThrow();
  });

  it('divides a nested room without cutting away its parent area', () => {
    const p = newProject();
    const parent = createObject('zone', [0, 0], floor);
    parent.rings = [rectangle([0, 0], 20, 20)];
    const room = createObject('room', [0, 0], floor);
    room.rings = [rectangle([0, 0], 10, 10)];
    room.parentId = parent.id;
    p.objects.push(parent, room);
    const result = transact(p, draft => drawBarrier(draft, floor, [0, -12], [0, 12]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.project.objects.filter(o => o.parentId === parent.id)).toHaveLength(2);
    expect(result.project.objects.find(o => o.id === parent.id)?.rings).toEqual(parent.rings);
  });

  it('offers only free wall space for an opening, including when sliding an existing leaf', () => {
    const p = newProject();
    addBarrier(p, [0, 0], [5, 0], floor, 'wall');
    const first = doorOn(p, 2, 1);
    const second = doorOn(p, 3, 1);
    const fit = fitOpening(p, floor, 'door', [2.5, 0], 1, 3)!;
    expect(fit).not.toBeNull();
    expect(Math.min(Math.abs(fit.offset - 2), Math.abs(fit.offset - 3))).toBeGreaterThanOrEqual(1);
    const slide = fitOpening(p, floor, 'door', [3, 0], 1, Infinity, first.id)!;
    expect(Math.abs(slide.offset - second.offset!)).toBeGreaterThanOrEqual(1);
    expect(fitOpening(p, floor, 'door', [2.5, 0], 2, 3)).toBeNull();
  });

  it('does not suggest a partition through a door', () => {
    const p = newProject();
    addBarrier(p, [0, 0], [10, 0], floor, 'wall');
    addBarrier(p, [0, 8], [10, 8], floor, 'wall');
    doorOn(p, 5, 1);
    expect(proposeWall(p, floor, [5, 2])).toBeNull();
    expect(proposeWall(p, floor, [3, 2])).not.toBeNull();
  });

  it('shortens a wall with multiple doors by moving the leaves to fit', () => {
    const p = newProject();
    addBarrier(p, [0, 0], [10, 0], floor, 'wall');
    doorOn(p, 7, 1);
    doorOn(p, 9, 1);
    const moved = dragGeometry(p, floor, { kind: 'junction', id: p.barriers[0].endId, point: [4, 0] });
    expect(distance(...barrierEnds(moved, moved.barriers[0]))).toBeCloseTo(4);
    expect(moved.objects.map(o => o.offset)).toEqual([2.5, 3.5]);
    expect(() => validateProject(moved)).not.toThrow();
    expect(p.objects.map(o => o.offset)).toEqual([7, 9]);
  });

  it('limits a drag before connected walls or attached openings become too short', () => {
    for (const withDoor of [false, true]) {
      const p = newProject();
      addBarrier(p, [0, 0], [10, 0], floor, 'wall');
      if (withDoor) doorOn(p, 5, 1.2);
      const next = dragGeometry(p, floor, { kind: 'junction', id: p.barriers[0].endId, point: [0, 0] });
      const length = distance(...barrierEnds(next, next.barriers[0]));
      const limit = withDoor ? 1.2 : MIN_SEGMENT;
      expect(length).toBeGreaterThanOrEqual(limit - (withDoor ? 0.001 : 1e-6));
      expect(length).toBeLessThan(limit + 0.0001);
      expect(() => validateProject(next)).not.toThrow();
      const continued = dragGeometry(next, floor, { kind: 'junction', id: p.barriers[0].endId, point: [6, 0] });
      expect(distance(...barrierEnds(continued, continued.barriers[0]))).toBeCloseTo(6);
    }
  });

  it('limits a corner drag that would cross the room and lets the next drag continue', () => {
    const p = newProject();
    const room = createObject('room', [0, 0], floor);
    room.rings = [rectangle([0, 0], 10, 10)];
    p.objects.push(room);
    const move = { kind: 'ring' as const, id: room.id, ringIndex: 0, index: 1 };
    const next = dragGeometry(p, floor, { ...move, point: [-8, 2] });
    expect(validateRings(next.objects[0].rings!)).toBeNull();
    expect(next.objects[0].rings![0][1]).not.toEqual(room.rings[0][1]);
    const continued = dragGeometry(next, floor, { ...move, point: [4, -4] });
    expect(continued.objects[0].rings![0][1]).toEqual([4, -4]);
  });

  it('retains a usable polygon draft after a duplicate or crossing click', () => {
    const draft: Point[] = [
      [0, 0],
      [5, 0],
      [5, 5],
    ];
    expect(appendAreaPoint(draft, [5, 5]).points).toBe(draft);
    const bad = appendAreaPoint(draft, [3, -1]);
    expect(bad.error).toMatch(/crosses/);
    expect(bad.points).toBe(draft);
    const next = appendAreaPoint(bad.points, [0, 5]);
    expect(next.error).toBeUndefined();
    expect(validateRings([next.points])).toBeNull();
  });

  it('rolls back an impossible junction and accepts the next ordinary edit', () => {
    const p = newProject();
    addBarrier(p, [0, 0], [10, 0], floor, 'wall');
    doorOn(p, 5);
    const before = structuredClone(p);
    const bad = transact(p, draft => drawBarrier(draft, floor, [5, 0], [5, 6]));
    expect(bad.ok).toBe(false);
    expect(p).toEqual(before);
    const good = transact(p, draft => drawBarrier(draft, floor, [3, 0], [3, 6]));
    expect(good.ok).toBe(true);
  });

  it('re-encloses an existing room without duplicating its identity', () => {
    const p = newProject();
    const ring = rectangle([0, 0], 10, 10);
    for (let i = 1; i < ring.length; i++) drawBarrier(p, floor, ring[i - 1], ring[i]);
    const first = encloseRoom(p, floor, [0, 0])!;
    const again = encloseRoom(p, floor, [0, 0])!;
    expect(first.existing).toBe(false);
    expect(again.existing).toBe(true);
    expect(first.room.id).toBe(again.room.id);
    expect(p.objects).toHaveLength(1);
  });
});

describe('small architectural details', () => {
  it('preserves a valid diagonal detail whose two endpoints would round to the same centimetre cell', () => {
    const p = newProject();
    drawBarrier(p, floor, [-0.004, -0.004], [0.004, 0.004]);
    expect(p.barriers).toHaveLength(1);
    expect(distance(...barrierEnds(p, p.barriers[0]))).toBeCloseTo(Math.sqrt(2) * 0.008, 8);
    expect(() => validateProject(p)).not.toThrow();
  });

  it.each([0.01, 0.015, 0.02, 0.05, 0.1, 0.3, 0.499])(
    'draws a %i m return without losing it to a neighbouring endpoint',
    length => {
      const p = newProject();
      drawBarrier(p, floor, [0, 0], [5, 0]);
      const returnWall = drawBarrier(p, floor, [5, 0], [5, length]);
      expect(returnWall, 'a valid short stroke must create a wall').toBeDefined();
      expect(p.barriers).toHaveLength(2);
      expect(distance(...barrierEnds(p, returnWall!))).toBeCloseTo(length, 8);
      expect(() => validateProject(JSON.parse(JSON.stringify(p)))).not.toThrow();
    },
  );

  it.each([0.01, 0.02, 0.05, 0.2])('keeps a T junction %i m from a corner, even on a long wall', setback => {
    const p = newProject();
    addBarrier(p, [0, 0], [100, 0], floor, 'wall');
    drawBarrier(p, floor, [setback, 0], [setback, 3]);
    expect(p.barriers).toHaveLength(3);
    const junction = p.junctions.find(j => distance(j.position, [setback, 0]) < 1e-8)!;
    expect(p.barriers.filter(b => b.startId === junction.id || b.endId === junction.id)).toHaveLength(3);
    expect(p.barriers.some(b => Math.abs(distance(...barrierEnds(p, b)) - setback) < 1e-8)).toBe(true);
    expect(() => validateProject(p)).not.toThrow();
  });

  it('preserves two staggered T junctions with a 2 cm wall between them', () => {
    const p = newProject();
    drawBarrier(p, floor, [0, 0], [10, 0]);
    drawBarrier(p, floor, [5, 0], [5, -3]);
    drawBarrier(p, floor, [5.02, 0], [5.02, 3]);
    expect(p.barriers).toHaveLength(5);
    const short = p.barriers.find(b => distance(...barrierEnds(p, b)) < 0.03)!;
    expect(distance(...barrierEnds(p, short))).toBeCloseTo(0.02, 8);
    expect(() => validateProject(p)).not.toThrow();
  });

  it('keeps a fine wall connection at close zoom while still supporting endpoint snapping', () => {
    const p = newProject();
    drawBarrier(p, floor, [0, 0], [10, 0]);
    const precise = snapPoint(p, floor, [0.12, 0.002], 0.01, undefined, false);
    expect(precise.point).toEqual([0.12, 0]);
    expect(snapPoint(p, floor, [0.002, 0.002], 0.01, undefined, false).point).toEqual([0, 0]);
  });

  it('accepts narrow openings on short walls when they actually fit', () => {
    for (const [length, width, kind] of [
      [0.8, 0.7, 'door'],
      [0.4, 0.25, 'window'],
    ] as const) {
      const p = newProject();
      addBarrier(p, [0, 0], [length, 0], floor, 'wall');
      const fit = fitOpening(p, floor, kind, [length / 2, 0], width, 1);
      expect(fit).not.toBeNull();
      const opening = createObject(kind, fit!.position, floor);
      Object.assign(opening, { width, barrierId: fit!.barrierId, offset: fit!.offset });
      p.objects.push(opening);
      expect(() => validateProject(p)).not.toThrow();
      expect(fitOpening(p, floor, kind, [length / 2, 0], length + 0.1, 1)).toBeNull();
    }
  });

  it('keeps a short jamb when splitting beside a door and remaps the door offset', () => {
    const p = newProject();
    addBarrier(p, [0, 0], [1, 0], floor, 'wall');
    const door = doorOn(p, 0.5, 0.7);
    drawBarrier(p, floor, [0.1, 0], [0.1, 2]);
    expect(p.barriers).toHaveLength(3);
    expect(door.offset).toBeCloseTo(0.4);
    expect(distance(...barrierEnds(p, p.barriers.find(b => b.id === door.barrierId)!))).toBeCloseTo(0.9);
    expect(() => validateProject(p)).not.toThrow();
  });

  it('does not change room area when a split passes 12 cm from a notch corner', () => {
    const p = newProject();
    const room = createObject('room', [0, 0], floor);
    room.rings = [
      [
        [-5, -5],
        [5, -5],
        [5, 5],
        [0.12, 5],
        [0.12, 7],
        [-5, 7],
      ],
    ];
    p.objects.push(room);
    const area = objectArea(room);
    splitRoom(p, room.id, [0, -8], [0, 9]);
    expect(p.objects.reduce((sum, o) => sum + objectArea(o), 0)).toBeCloseTo(area, 8);
    expect(() => validateProject(p)).not.toThrow();
  });

  it('still refuses numerical debris and accepts a subsequent real return', () => {
    const p = newProject();
    const bad = transact(p, draft => addBarrier(draft, [0, 0], [0.00001, 0], floor, 'wall'));
    expect(bad.ok).toBe(false);
    expect(p.barriers).toHaveLength(0);
    drawBarrier(p, floor, [0, 0], [0.1, 0]);
    expect(p.barriers).toHaveLength(1);
  });
});
