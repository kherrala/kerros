import { describe, expect, it } from 'vitest';
import { inferOpenBoundaries, inferPortals, spaces, validateProject } from '@kerros/schema';
import { createDemo } from './demo';
import { createSilo } from './silo';

// Integration tests for the reference app's sample data, exercised through the public @kerros/schema
// surface (validateProject runs relationship + navigation validation).
describe('demo projects', () => {
  it('the Stockmann campus validates, sits on the real footprint and stacks its retail floors', () => {
    const p = createDemo();
    expect(() => validateProject(JSON.parse(JSON.stringify(p)))).not.toThrow();
    expect(p.floors.length).toBeGreaterThanOrEqual(8);
    expect(p.objects.some(o => o.kind === 'room' && o.rings && o.rings.length > 1)).toBe(true); // atrium void
    expect(p.origin).toHaveLength(3);
  });
  it('the Silo validates', () => {
    expect(() => validateProject(JSON.parse(JSON.stringify(createSilo())))).not.toThrow();
  });
  it('every demo carries its ontology: zones to browse and portals read off the plan', () => {
    for (const p of [createDemo(), createSilo()]) {
      expect(p.zones?.length ?? 0, `${p.name} has zones`).toBeGreaterThan(0);
      expect(p.portals?.length ?? 0, `${p.name} has portals`).toBeGreaterThan(0);
    }
  });
  // The numbers docs/guide/ontology.md quotes for why open boundaries matter. Asserted here so the
  // manual cannot drift away from the building it describes — update both together or neither.
  it('doors alone isolate most of Stockmann; open boundaries connect all of it', () => {
    const p = createDemo();
    const ids = spaces(p).map(s => s.id);
    const isolated = (portals: { a: string; b: string }[]) => {
      const touched = new Set(portals.flatMap(x => [x.a, x.b]));
      return ids.filter(id => !touched.has(id));
    };
    const doorOnly = inferPortals(p);
    expect(ids).toHaveLength(1626);
    expect(isolated(doorOnly), 'door-only inference strands most of the store').toHaveLength(1456);
    expect(isolated([...doorOnly, ...inferOpenBoundaries(p)]), 'open boundaries reach the rest').toHaveLength(0);
    expect(
      p.objects.filter(o => o.kind === 'elevator'),
      'the lift landings the guide counts',
    ).toHaveLength(52);
  });
});
