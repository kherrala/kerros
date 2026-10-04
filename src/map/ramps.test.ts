import { describe, expect, it } from 'vitest';
import { createDemo } from '../../app/demo/demo';
import { distance, footprint, pointInRing, ringArea, slopeElevation } from '../model/geometry';
import { rampFloors } from '../model/ramps';
import { rampSections, rampVoids } from './rampGeometry';
import { StairWalker, stairSurfaces } from './stairSurfaces';
import { floorSupport } from './walkSurfaces';
import { walkConnectionContext } from './walkContext';
import { shellPlate } from './SceneLayer';
import type { Point } from '../model/types';
import polygonClipping from 'polygon-clipping';

const p = createDemo();
const ramps = p.objects.filter(o => o.slope && o.slope.high < 0);
const surfaces = stairSurfaces(p),
  support = floorSupport(p);
const inPlate = (at: Point, plates: Point[][][]) =>
  plates.some(pg => pointInRing(at, pg[0]) && !pg.slice(1).some(h => pointInRing(at, h)));

describe('garage ramp geometry and walking share the same profile', () => {
  it('splits the flat aprons at both slope endpoints without losing area', () => {
    for (const o of ramps) {
      const parts = rampSections(o.rings!, o.slope!);
      expect(parts).toHaveLength(3);
      expect(parts.reduce((a, pg) => a + Math.abs(ringArea(pg[0])), 0)).toBeCloseTo(Math.abs(ringArea(o.rings![0])), 5);
      const heights = parts.map(pg => pg[0].map(at => slopeElevation(o.slope!, at)));
      expect(Math.max(...heights[0]) - Math.min(...heights[0])).toBeLessThan(1e-6);
      expect(Math.max(...heights[2]) - Math.min(...heights[2])).toBeLessThan(1e-6);
      expect(Math.max(...heights[1]) - Math.min(...heights[1])).toBeCloseTo(4.2);
    }
  });

  it.each([false, true])('walks every inter-deck ramp continuously with descent=%s', down => {
    for (const o of ramps) {
      const { low, high } = rampFloors(p, o);
      let floor = down ? high! : low!;
      const [a, b] = down ? o.slope!.axis : [...o.slope!.axis].reverse();
      const length = distance(a, b),
        direction = [(b[0] - a[0]) / length, (b[1] - a[1]) / length];
      const at = (d: number): Point => [a[0] + direction[0] * d, a[1] + direction[1] * d];
      const walker = new StairWalker();
      walker.sync(floor.id, floor.elevation);
      let position = at(-4),
        previous = floor.elevation;
      for (let d = -3.96; d <= length + 4; d += 0.04) {
        const requested = at(d);
        position = walker.step(position, requested, surfaces, floor.id, floor.elevation, support.supports);
        expect(distance(position, requested), `${o.name} at ${d}`).toBeLessThan(0.001);
        expect(Math.abs(walker.height - previous)).toBeLessThan(0.02);
        previous = walker.height;
        if (walker.pending) {
          floor = p.floors.find(f => f.id === walker.pending)!;
          walker.sync(floor.id, floor.elevation);
          walker.refresh(surfaces, position);
        }
      }
      expect(floor.id).toBe(down ? low!.id : high!.id);
      expect(walker.height).toBeCloseTo(floor.elevation);
    }
  });

  it('cuts all upper plates and the ceiling below, but retains the lower deck', () => {
    for (const o of ramps) {
      const { low, high } = rampFloors(p, o);
      const [a, b] = o.slope!.axis,
        mid: Point = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      expect(rampVoids(p, high!.id).some(r => pointInRing(mid, r))).toBe(true);
      expect(rampVoids(p, low!.id, 'ceiling').some(r => pointInRing(mid, r))).toBe(true);
      expect(inPlate(mid, shellPlate(p, high!.id))).toBe(false);
      expect(inPlate(mid, shellPlate(p, low!.id))).toBe(true);
      expect(support.supports(mid, high!.id)).toBe(false);
      expect(support.supports(mid, low!.id)).toBe(true);
      const context = walkConnectionContext(p, low!);
      expect(context.map(f => f.id)).toContain(high!.id);
    }
  });

  it('keeps vehicles and columns clear of both the arriving and departing lanes', () => {
    for (const o of ramps) {
      const { low, high } = rampFloors(p, o);
      const fixtures = p.objects.filter(
        f =>
          [low!.id, high!.id].includes(f.floorId!) &&
          f.kind === 'fixture' &&
          (f.model === 'car' || f.name === 'Column'),
      );
      for (const f of fixtures) {
        const overlap = polygonClipping.intersection(o.rings!, footprint(f));
        expect(
          overlap.flat().reduce((a, r) => a + Math.abs(ringArea(r as Point[])), 0),
          f.name,
        ).toBeLessThan(0.001);
      }
    }
  });
});
