import { describe, expect, it } from 'vitest';
import { createDemo } from './demo';
import { GARAGE_FLOORS } from './stockmannGarage';
import {
  distance,
  findRoute,
  pointInRing,
  ringArea,
  slopeElevation,
  validateNavigation,
  validateProject,
} from '@kerros/schema';
import type { Point } from '@kerros/schema';

describe('Stockmann underground garage', () => {
  const p = createDemo();
  const deckIds = GARAGE_FLOORS.map(([id]) => id);
  const ramps = p.objects.filter(o => o.slope);

  it('adds three parking decks below the existing basements', () => {
    const decks = p.floors.filter(f => deckIds.includes(f.id));
    expect(decks).toHaveLength(3);
    // Deeper than the deepest storey of the store itself, and strictly descending.
    const store = Math.min(...p.floors.filter(f => !deckIds.includes(f.id)).map(f => f.elevation));
    expect(Math.max(...decks.map(d => d.elevation))).toBeLessThan(store);
    for (let i = 1; i < decks.length; i++) expect(decks[i].elevation).toBeLessThan(decks[i - 1].elevation);
    expect(() => validateProject(JSON.parse(JSON.stringify(p)))).not.toThrow();
  });

  it('every ramp runs downhill along its axis, from its high end to its low end', () => {
    expect(ramps.length).toBeGreaterThanOrEqual(4); // two inter-deck plus two street driveways
    for (const r of ramps) {
      const s = r.slope!;
      expect(s.high).toBeGreaterThan(s.low);
      expect(slopeElevation(s, s.axis[0])).toBeCloseTo(s.high);
      expect(slopeElevation(s, s.axis[1])).toBeCloseTo(s.low);
      // A drivable gradient, not a cliff: garage ramps top out around 15%.
      const run = Math.hypot(s.axis[1][0] - s.axis[0][0], s.axis[1][1] - s.axis[0][1]);
      expect((s.high - s.low) / run).toBeLessThan(0.15);
    }
  });

  it('the street driveways climb from the top deck to grade, surfacing outside the deck plate', () => {
    const top = GARAGE_FLOORS[0];
    const street = ramps.filter(r => r.slope!.high === 0);
    expect(street.map(r => r.name).sort()).toEqual(['Entry ramp · Mannerheimintie', 'Exit ramp · Kaivokatu']);
    const deck = p.objects.find(o => o.floorId === top[0] && o.name.startsWith('Parking deck'))!;
    for (const r of street) {
      expect(r.slope!.low).toBeCloseTo(top[2]); // bottom end sits on the top deck
      // The high (street) end must be beyond the garage plate — that is what makes it a connection
      // to the road network rather than an internal ramp.
      expect(pointInRing(r.slope!.axis[0] as Point, deck.rings![0])).toBe(false);
      expect(pointInRing(r.slope!.axis[1] as Point, deck.rings![0])).toBe(true);
    }
  });

  it('lands each inter-deck ramp on the deck it arrives at, in a lane of its own', () => {
    const inter = ramps.filter(r => r.slope!.high !== 0);
    expect(inter.map(r => r.name)).toEqual(['Ramp P1 → P2', 'Ramp P2 → P3']);
    for (const [i, r] of inter.entries()) {
      // The deck it arrives on is the one at the ramp's low elevation. Every deck is smaller than
      // the one above it, so a ramp that simply ran back down the lane above finishes off the plate.
      const arrival = p.objects.find(o => o.name.startsWith('Parking deck') && o.floorId === GARAGE_FLOORS[i + 1][0])!;
      expect(r.slope!.low).toBeCloseTo(GARAGE_FLOORS[i + 1][2]);
      expect(pointInRing(r.slope!.axis[1] as Point, arrival.rings![0]), `${r.name} foot on the deck`).toBe(true);
    }
    // And they are two ramps, not one strip driven twice: no end of either lies on the other's run.
    const [a, b] = inter.map(r => r.slope!.axis);
    for (const end of [...a, ...b])
      expect(
        Math.min(
          ...[a, b]
            .flat()
            .map(pt => Math.hypot(pt[0] - end[0], pt[1] - end[1]))
            .filter(d => d > 0.01),
        ),
        'the two ramps share a lane',
      ).toBeGreaterThan(4);
  });

  it('routes on foot from a shop floor down to a bay on the deepest deck', () => {
    expect(validateNavigation(p)).toBeNull();
    const entrance = p.objects.find(o => o.name === 'Main entrance')!;
    const bay = p.objects.find(o => o.floorId === GARAGE_FLOORS[2][0] && o.name.startsWith('Bay '))!;
    const route = findRoute(p, entrance.id, bay.id);
    expect(route, 'the garage must be reachable from the street').not.toBeNull();
    // Getting there means actually going down: some vertical leg, ending at the chosen bay.
    expect(route!.steps.some(s => s.kind === 'elevator' || s.kind === 'stairs')).toBe(true);
    expect(route!.steps.at(-1)!.text).toBe(`Arrive at ${bay.name}`);
    // And the journey crosses from the store into the garage.
    expect(new Set(route!.steps.map(s => s.floorId)).size).toBeGreaterThan(1);
  });

  it('parks cars and columns on every deck', () => {
    for (const id of deckIds) {
      const on = p.objects.filter(o => o.floorId === id);
      expect(on.filter(o => o.name === 'Parked car').length).toBeGreaterThan(20);
      expect(on.filter(o => o.name === 'Column').length).toBeGreaterThan(15);
      const plate = on.find(o => o.name.startsWith('Parking deck'))!;
      expect(ringArea(plate.rings![0])).toBeGreaterThan(4000); // a genuinely vast deck, in m²
    }
  });
  it('encloses the walked garage up to its ceiling while leaving ramp and service mouths open', () => {
    for (const floorId of deckIds) {
      const perimeter = p.barriers.filter(b => b.floorId === floorId && b.name === 'Deck edge');
      expect(perimeter.length).toBeGreaterThanOrEqual(7);
      for (const b of perimeter) expect(b.height + 0.18).toBeCloseTo(p.floors.find(f => f.id === floorId)!.height, 6);
      const passages = p.objects.filter(o => o.floorId === floorId && (o.slope || o.name.startsWith('Service link')));
      for (const b of perimeter) {
        const a = p.junctions.find(j => j.id === b.startId)!.position;
        const z = p.junctions.find(j => j.id === b.endId)!.position;
        const mid: Point = [(a[0] + z[0]) / 2, (a[1] + z[1]) / 2];
        expect(passages.some(o => pointInRing(mid, o.rings![0]))).toBe(false);
      }
    }
  });
});

describe('the garage mouths reach the street', () => {
  const project = createDemo();

  it('puts a gate on the site level where each driveway surfaces', () => {
    const gates = project.objects.filter(o => o.floorId === null && o.kind === 'gate' && o.symbol === 'driveway');
    expect(gates.map(g => g.name).sort()).toEqual(['Entry · garage · Mannerheimintie', 'Exit · garage · Kaivokatu']);
    // Each one stands at the high end of its own ramp, which is the point that reaches grade.
    for (const gate of gates) {
      const ramp = project.objects.find(o => o.slope && o.name.includes(gate.name.split(' · ').at(-1)!));
      expect(ramp, gate.name).toBeTruthy();
      expect(distance(gate.position, ramp!.slope!.axis[0])).toBeLessThan(0.5);
      expect(ramp!.slope!.high).toBeGreaterThanOrEqual(0);
    }
  });

  it('routes from the street, down a ramp, to a bay on the deepest deck', () => {
    const gate = project.objects.find(o => o.floorId === null && o.kind === 'gate' && o.symbol === 'driveway')!;
    const bay = project.objects.find(o => o.floorId === 'floor-p3' && o.name.startsWith('Bay '))!;
    const route = findRoute(project, gate.id, bay.id);
    expect(route, 'no route from the garage mouth to a bay').not.toBeNull();
    // It has to leave the site, so the first level it reaches is the top deck.
    expect(route!.steps.some(s => s.floorId === 'floor-p1')).toBe(true);
    expect(route!.steps.at(-1)!.floorId).toBe('floor-p3');
  });
});
