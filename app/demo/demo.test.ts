import { describe, expect, it } from 'vitest';
import { inferOpenBoundaries, inferPortals, spaces, validateProject } from '@kerros/schema';
import { createDemo } from './demo';
import { attachOntology } from './ontology';
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
  it('an escalator bank runs both ways, and says so on the object rather than in its name', () => {
    const p = createDemo();
    const bank = p.objects.filter(o => o.stairModel === 'escalator');
    expect(bank.length).toBeGreaterThan(1);
    expect(new Set(bank.map(o => o.travel))).toEqual(new Set(['up', 'down']));
    // A staircase is not an escalator and has no way to run.
    expect(p.objects.some(o => o.kind === 'stairs' && o.stairModel !== 'escalator' && o.travel !== undefined)).toBe(
      false,
    );
    // Routing rides it the way it runs and no other way: the edges it threads are directed, and a
    // descending escalator's point from the upper landing to the lower one.
    const floorOf = (nodeId: string) => p.navNodes!.find(n => n.id === nodeId)!.floorId;
    const at = (id: string) => p.floors.find(f => f.id === floorOf(id))!.elevation;
    for (const escalator of bank) {
      const edges = p.navEdges!.filter(e => p.objects.find(o => o.id === e.objectId)?.name === escalator.name);
      expect(edges.length).toBeGreaterThan(0);
      for (const edge of edges) {
        expect(edge.directed).toBe(true);
        expect(at(edge.bId) > at(edge.aId)).toBe(escalator.travel === 'up');
      }
    }
  });
  it("reads a shaft zone's direction off the escalator, not off what it is called", () => {
    // The described layer groups per-storey landings into one shaft. Give an escalator a name that
    // says nothing about direction and the zone still knows which way it carries you.
    const p = createDemo();
    const escalator = p.objects.find(o => o.stairModel === 'escalator' && o.travel === 'down')!;
    const upstairs = p.floors.find(f => f.id !== escalator.floorId && f.elevation > 0)!;
    for (const twin of p.objects.filter(o => o.stairModel === 'escalator' && o.travel === escalator.travel))
      twin.name = 'Liukuporras';
    p.objects.push({ ...escalator, id: 'twin-escalator', floorId: upstairs.id, name: 'Liukuporras' });
    attachOntology(p);
    const zone = p.zones!.find(z => z.name === 'Liukuporras');
    expect(zone?.connects).toBe('down');
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
    expect(ids).toHaveLength(1494);
    expect(isolated(doorOnly), 'door-only inference strands most of the store').toHaveLength(1323);
    expect(isolated([...doorOnly, ...inferOpenBoundaries(p)]), 'open boundaries reach the rest').toHaveLength(0);
    // One object per shaft, not one per storey: a lift is a thing standing in a place reaching a
    // list of levels, and `servedFloorIds` is where that list lives.
    expect(
      p.objects.filter(o => o.kind === 'elevator'),
      'the lift shafts the guide counts',
    ).toHaveLength(8);
  });
});
