import { describe, expect, it } from 'vitest';
import { newProject, addFloor } from './testFixtures';
import { createObject } from './factory';
import { ringArea } from './geometry';
import type { ProjectDocument, SiteObject } from './types';
import {
  arrivesAt,
  departsFrom,
  flightRun,
  flights,
  MAX_GOING,
  passesThrough,
  PITCH,
  pitchOf,
  runFor,
  shaftVoids,
  stairModel,
  treads,
} from './vertical';

/** Four storeys of 4.2 m with a shaft standing in the middle of them, which is the shape every
 *  question below is about: what the bottom of a run needs, what the top of one needs, and what a
 *  level in the middle needs that neither end does. */
function tower(kind: 'stairs' | 'elevator' = 'stairs', shape?: Partial<SiteObject>) {
  const p = newProject();
  const ground = p.floors[0].id;
  const ids = [ground, addFloor(p, 'l1', 4.2), addFloor(p, 'l2', 8.4), addFloor(p, 'l3', 12.6)];
  const shaft = createObject(kind, [0, 0], ground, 'Stair');
  Object.assign(shaft, { rotation: 0, width: 2.5, depth: 9, ...shape });
  shaft.servedFloorIds = ids;
  p.objects.push(shaft);
  return { p, shaft, ids };
}
const area = (p: ProjectDocument, floorId: string, o?: SiteObject) =>
  shaftVoids(p, floorId, o && new Set([o.id])).reduce((sum, r) => sum + Math.abs(ringArea(r)), 0);

describe('what a plate and a lid each have to be open for', () => {
  it('opens the floor a run arrives at, even when nothing carries on above it', () => {
    const { p, shaft, ids } = tower();
    // The top of the run: a flight lands here and there is no level above. The old predicate wanted
    // one at both ends, so the last flight of every stair in the building was under an uncut slab.
    expect(arrivesAt(p, shaft, ids[3])).toBe(true);
    expect(departsFrom(p, shaft, ids[3])).toBe(false);
    expect(passesThrough(p, shaft, ids[3])).toBe(false);
    expect(area(p, ids[3], shaft)).toBeGreaterThan(0);
  });

  it('opens the lid a run sets off through, even at the bottom of it', () => {
    const { p, shaft, ids } = tower();
    expect(departsFrom(p, shaft, ids[0])).toBe(true);
    expect(arrivesAt(p, shaft, ids[0])).toBe(false);
    // Nothing comes up through the ground floor's plate, so it keeps its floor…
    expect(area(p, ids[0], shaft)).toBe(0);
    // …and the ceiling over it is open, or the flight climbs into a lid.
    expect(shaftVoids(p, ids[0], new Set([shaft.id]), { through: 'ceiling' }).length).toBe(1);
  });

  it('answers both in the middle of a run, which is what passing through means', () => {
    const { p, shaft, ids } = tower();
    expect(arrivesAt(p, shaft, ids[1])).toBe(true);
    expect(departsFrom(p, shaft, ids[1])).toBe(true);
    expect(passesThrough(p, shaft, ids[1])).toBe(true);
  });

  it('leaves a level the shaft never reaches alone', () => {
    const { p, shaft, ids } = tower();
    shaft.servedFloorIds = [ids[0], ids[1]];
    expect(arrivesAt(p, shaft, ids[2])).toBe(false);
    expect(departsFrom(p, shaft, ids[2])).toBe(false);
    expect(area(p, ids[2], shaft)).toBe(0);
  });

  it("ignores a flight that sets off below a view's lowest drawn level", () => {
    const { p, shaft } = tower();
    const basement = addFloor(p, 'b1', -4.2);
    p.floors.find(f => f.id === basement)!.elevation = -4.2;
    shaft.servedFloorIds = [basement, ...shaft.servedFloorIds!];
    // Above ground the basement flight is not drawn, so the hole it would come up through is a hole
    // onto the basemap.
    expect(area(p, p.floors[0].id, shaft)).toBeGreaterThan(0);
    expect(shaftVoids(p, p.floors[0].id, new Set([shaft.id]), { lowest: -0.01 })).toHaveLength(0);
  });
});

describe('how big the hole is', () => {
  it('cuts a lift its whole footprint: a shaft is a shaft all the way up', () => {
    const { p, shaft, ids } = tower('elevator', { width: 2, depth: 2 });
    expect(area(p, ids[2], shaft)).toBeCloseTo(4, 1);
  });

  it('cuts a turning core its whole footprint too — both lanes are in the box', () => {
    const { p, shaft, ids } = tower('stairs', { width: 2.5, depth: 2.6 });
    expect(stairModel(p, shaft)).toBe('switchback');
    expect(area(p, ids[2], shaft)).toBeCloseTo(2.5 * 2.6, 1);
  });

  it('cuts a straight flight only the head of its run, and keeps the rest as floor', () => {
    const { p, shaft, ids } = tower('stairs', { width: 2.5, depth: 9 });
    expect(stairModel(p, shaft)).toBe('straight');
    const whole = 2.5 * 9;
    const hole = area(p, ids[2], shaft);
    expect(hole).toBeGreaterThan(2.5);
    expect(hole).toBeLessThan(whole * 0.75);
  });

  it("cuts an escalator's arriving and departing ends at opposite ends of the box", () => {
    const { p, shaft, ids } = tower('stairs', { stairModel: 'escalator', width: 1.2, depth: 12 });
    const mid = (ring: number[][]) => ring.reduce((s, pt) => s + pt[1], 0) / ring.length;
    // A criss-cross bank turns every other flight round, so the flight arriving at level 2 and the
    // one leaving it lie head to foot. Their holes must not be the same hole.
    const up = shaftVoids(p, ids[2], new Set([shaft.id]))[0];
    const over = shaftVoids(p, ids[2], new Set([shaft.id]), { through: 'ceiling' })[0];
    expect(mid(up) * mid(over)).toBeLessThan(0);
  });
});

describe('a flight lies where the climb needs it, not wherever the box reaches', () => {
  it("keeps an escalator at the machine's own 30°, and gives the surplus to its landing", () => {
    const { p, shaft } = tower('stairs', { stairModel: 'escalator', width: 1.2, depth: 20 });
    const flight = flights(p, shaft)[0];
    const run = flightRun(p, shaft, flight.rise, 'escalator', 0);
    expect(pitchOf(flight.rise, run.incline)).toBeCloseTo(PITCH.escalator, 1);
    // Twenty metres of box for a 4.2 m rise: most of it is floor, not ramp.
    expect(run.incline).toBeCloseTo(runFor(flight.rise, PITCH.escalator), 1);
    expect(run.half - run.footT).toBeGreaterThan(5);
  });

  it('still shows a box too short for its rise as the steep thing it is', () => {
    const { p, shaft } = tower('stairs', { stairModel: 'escalator', width: 1.2, depth: 6 });
    const run = flightRun(p, shaft, 4.2, 'escalator', 0);
    expect(run.incline).toBeCloseTo(6 - 2 * run.pad, 2);
    expect(pitchOf(4.2, run.incline)).toBeGreaterThan(PITCH.escalator);
  });

  it('caps a tread at a third of a metre, so a shallow climb is a stair with landings', () => {
    // A 1.6 m mezzanine rise in a nine-metre box used to be nine metre-deep slabs.
    const { steps, going } = treads(1.6, 9);
    expect(going).toBeCloseTo(MAX_GOING, 3);
    expect(steps * going).toBeLessThan(4);
    // A box the climb genuinely fills keeps the run the plan drew it.
    expect(treads(4.2, 7.5).going).toBeLessThan(MAX_GOING);
  });
});
