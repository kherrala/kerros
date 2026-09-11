import { describe, expect, it } from 'vitest';
import { excavationRings } from './underground';
import { createObject } from '../model/factory';
import { newProject } from '../model/testFixtures';
import { addBarrier, closeRing, ringArea } from '../model/geometry';
import type { Point, ProjectDocument } from '../model/types';

const rect = (x0: number, y0: number, x1: number, y1: number): Point[] => [
  [x0, y0],
  [x1, y0],
  [x1, y1],
  [x0, y1],
];
function plate(p: ProjectDocument, floorId: string, ring: Point[], name = 'Deck') {
  const o = createObject('zone', [0, 0], floorId, name);
  o.rings = [closeRing(ring.map(pt => [...pt] as Point))];
  p.objects.push(o);
  return o;
}
function belowGradeProject() {
  const p = newProject();
  p.floors.push(
    { id: 'p1', buildingId: 'building-main', name: 'P1', elevation: -8, height: 3 },
    { id: 'p2', buildingId: 'building-main', name: 'P2', elevation: -12, height: 3 },
  );
  return p;
}

describe('excavation outline', () => {
  it('is empty when nothing is below ground', () => {
    const p = newProject();
    plate(p, 'floor-ground', rect(0, 0, 10, 10));
    expect(excavationRings(p, p.floors)).toEqual([]);
  });

  it('spans every below-grade deck, not just the active one', () => {
    const p = belowGradeProject();
    plate(p, 'p1', rect(0, 0, 20, 20));
    plate(p, 'p2', rect(-30, 0, 0, 20)); // a deeper deck offset to the side
    const rings = excavationRings(p, p.floors);
    expect(rings).toHaveLength(1); // the two plates touch, so they merge into one excavation
    // 20×20 + 30×20 = 1000 m², versus 400 for the top plate alone.
    expect(Math.round(ringArea(closeRing(rings[0])))).toBe(1000);
  });

  it('includes ramps, which are what reach out past the building to the street', () => {
    const p = belowGradeProject();
    plate(p, 'p1', rect(0, 0, 20, 20));
    const ramp = plate(p, 'p1', rect(20, 5, 60, 11), 'Entry ramp');
    ramp.slope = {
      axis: [
        [60, 8],
        [20, 8],
      ],
      high: 0,
      low: -8,
    };
    const [ring] = excavationRings(p, p.floors);
    // The excavation must reach the ramp's far end (x = 60), not stop at the deck edge (x = 20).
    expect(Math.max(...ring.map(pt => pt[0]))).toBeCloseTo(60);
  });

  it('keeps disjoint excavations separate', () => {
    const p = belowGradeProject();
    plate(p, 'p1', rect(0, 0, 10, 10));
    plate(p, 'p2', rect(100, 100, 110, 110));
    expect(excavationRings(p, p.floors)).toHaveLength(2);
  });
});

describe('a basement drawn as rooms rather than one plate', () => {
  it('is excavated under all of it, not under its largest room', () => {
    // What an import produces: no zone plate, just the rooms the walls enclose. Digging under the
    // biggest of them leaves the rest of the storey hanging over open air with a cut edge running
    // through the middle of the building.
    const p = belowGradeProject();
    const west = createObject('room', [-5, 5], 'p1', 'West');
    west.rings = [closeRing(rect(-10, 0, 0, 10))];
    const east = createObject('room', [5, 5], 'p1', 'East');
    east.rings = [closeRing(rect(0.3, 0, 6, 10))]; // smaller, and the wall's width away
    p.objects.push(west, east);
    for (const [a, b] of [
      [
        [0.15, 0],
        [0.15, 10],
      ],
      [
        [-10, 0],
        [6, 0],
      ],
      [
        [-10, 10],
        [6, 10],
      ],
      [
        [-10, 0],
        [-10, 10],
      ],
      [
        [6, 0],
        [6, 10],
      ],
    ] as [Point, Point][])
      addBarrier(p, a, b, 'p1', 'wall');
    const [dug] = excavationRings(p, p.floors);
    expect(dug).toBeTruthy();
    const xs = dug.map(q => q[0]);
    // Reaches the east room, not just the west one.
    expect(Math.max(...xs)).toBeGreaterThan(5);
    expect(Math.min(...xs)).toBeLessThan(-9);
    expect(Math.abs(ringArea(dug))).toBeGreaterThan(150);
  });
});
