import { describe, expect, it } from 'vitest';
import { createDemo } from './demo';
import { GARAGE_FLOORS } from './stockmannGarage';
import { findRoute, pointInRing, ringArea, slopeElevation, validateNavigation, validateProject } from '@kerros/schema';
import type { Point } from '@kerros/schema';

describe('Stockmann underground garage', () => {
  const p = createDemo();
  const deckIds = GARAGE_FLOORS.map(([id]) => id);
  const ramps = p.objects.filter(o => o.slope);

  it('adds three parking decks below the existing basements', () => {
    const decks = p.floors.filter(f => deckIds.includes(f.id));
    expect(decks).toHaveLength(3);
    // Deeper than the deepest pre-existing level (Herkku at -8.8) and strictly descending.
    expect(Math.max(...decks.map(d => d.elevation))).toBeLessThan(-8.8);
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
});
