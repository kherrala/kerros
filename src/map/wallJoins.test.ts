import { describe, expect, it } from 'vitest';
import polygonClipping from 'polygon-clipping';
import { addBarrier, closeRing, createObject, distance, ringArea, rotate, validateRings, type Point } from '../schema';
import { newProject } from '../model/testFixtures';
import { wallPieces } from './features';
import { wallFootprints } from './wallJoins';

const junction = (angles: number[], thickness = 0.2, length = 4) => {
  const p = newProject();
  for (const angle of angles) {
    const wall = addBarrier(p, [0, 0], rotate([length, 0], angle), 'floor-ground', 'wall')!;
    wall.thickness = thickness;
  }
  return p;
};

describe('joined wall surfaces', () => {
  // Each case is ONE argument — the list of angles meeting at the junction. it.each spreads an inner
  // array across parameters, so the list has to be wrapped or the test receives its first angle alone.
  it.each([[[0, 90]], [[17, 133]], [[0, 180, 65]], [[15, 105, 195, 285]]])(
    'closes mitred joins at %j without overlapping end caps',
    angles => {
      const p = junction(angles);
      const rings = [...wallFootprints(p).values()];
      for (const ring of rings) expect(validateRings([closeRing(ring)])).toBeNull();
      const combined = polygonClipping.union(...(rings.map(r => [closeRing(r)]) as [Point[][], ...Point[][][]]));
      const area = combined.reduce((sum, pg) => sum + ringArea(pg[0] as Point[]), 0);
      expect(rings.reduce((sum, r) => sum + ringArea(r), 0)).toBeCloseTo(area, 8);
      // Every joined end is shared exactly by the wall on the other side of that wedge.
      for (const ring of rings)
        for (const corner of [ring[0], ring[3]])
          expect(rings.some(other => other !== ring && other.some(q => distance(corner, q) < 1e-9))).toBe(true);
    },
  );
  it('keeps straight joins flush when the wall thickness changes', () => {
    const p = junction([21, 201]);
    p.barriers[1].thickness = 0.4;
    const [a, b] = [...wallFootprints(p).values()];
    expect(a[0]).toEqual(b[3]);
    expect(a[3]).toEqual(b[0]);
  });
  it('bounds nearly parallel mitres and keeps a 1 cm return finite', () => {
    for (const angles of [
      [0, 0.5],
      [0, 90],
    ]) {
      const p = junction(angles, 0.2, angles[1] === 90 ? 0.01 : 4);
      for (const ring of wallFootprints(p).values()) {
        expect(ring.flat().every(Number.isFinite)).toBe(true);
        expect(Math.max(...[ring[0], ring[3]].map(q => Math.hypot(...q)))).toBeLessThan(0.4);
      }
    }
  });
  it('cuts doors at their offsets and retains the outside mitres', () => {
    const p = junction([0, 90]);
    const wall = p.barriers[0];
    const door = createObject('door', [2, 0], 'floor-ground', 'Door');
    Object.assign(door, { barrierId: wall.id, offset: 2, width: 1 });
    p.objects.push(door);
    const pieces = wallPieces(p, 'floor-ground').filter(x => x.id === wall.id);
    const ground = pieces.filter(x => x.base === 0);
    expect(ground).toHaveLength(2);
    expect(Math.max(...ground[0].ring.map(q => q[0]))).toBeCloseTo(1.5);
    expect(Math.min(...ground[1].ring.map(q => q[0]))).toBeCloseTo(2.5);
    expect(Math.min(...ground[0].ring.map(q => q[0]))).toBeCloseTo(-0.1);
    expect(pieces.some(x => x.base === door.height)).toBe(true);
  });
});
