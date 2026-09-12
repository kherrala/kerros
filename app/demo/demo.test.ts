import { describe, expect, it } from 'vitest';
import {
  barrierEnds,
  flights,
  footprint,
  inferOpenBoundaries,
  inferPortals,
  isArea,
  isVertical,
  openRing,
  pitchOf,
  pointInRing,
  primaryShafts,
  spaces,
  validateProject,
} from '@kerros/schema';
import type { Point, ProjectDocument } from '@kerros/schema';
import { createDemo } from './demo';
import { attachOntology } from './ontology';
import { createSilo } from './silo';

/** Is there floor under this point on that level — inside an area's outline, clear of its holes? */
const standsOn = (p: ProjectDocument, floorId: string, pt: Point) =>
  p.objects.some(
    o =>
      o.floorId === floorId &&
      isArea(o.kind) &&
      o.rings?.length &&
      pointInRing(pt, o.rings[0]) &&
      !o.rings.slice(1).some(hole => pointInRing(pt, hole)),
  );
/** Do the two segments cross? Endpoints touching do not count — walls meet at shared junctions. */
const crosses = (a: Point, b: Point, c: Point, d: Point) => {
  const side = (p: Point, q: Point, r: Point) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const [ac, ad, ca, cb] = [side(a, b, c), side(a, b, d), side(c, d, a), side(c, d, b)];
  return ac > 0 !== ad > 0 && ca > 0 !== cb > 0;
};

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
  it('lands every escalator flight on the floors it joins, at both ends, and climbs at 30°', () => {
    const p = createDemo();
    const bank = p.objects.filter(o => o.stairModel === 'escalator');
    expect(bank).toHaveLength(4);
    for (const escalator of bank) {
      // Laid out the way SceneLayer.flight() lays it out: the run follows the object's DEPTH axis,
      // a metre of flat comb plate at each end, and those two plates are what you step onto.
      const rad = (escalator.rotation * Math.PI) / 180;
      const [ux, uy] = [Math.sin(rad), -Math.cos(rad)];
      const pad = Math.min(1, escalator.depth / 4);
      const reach = escalator.depth / 2 - pad / 2;
      const plates = [1, -1].map(
        side => [escalator.position[0] + ux * reach * side, escalator.position[1] + uy * reach * side] as Point,
      );
      const runs = flights(p, escalator);
      expect(runs.length, `${escalator.name} climbs the building`).toBeGreaterThan(4);
      for (const flight of runs) {
        // Sized for the tallest storey it crosses, comb plates excluded from the incline.
        expect(pitchOf(flight.rise, escalator.depth - 2 * pad), `${escalator.name} pitch`).toBeLessThanOrEqual(30.01);
        for (const level of [flight.from, flight.to])
          for (const plate of plates)
            expect(standsOn(p, level.id, plate), `${escalator.name} landing on ${level.name}`).toBe(true);
      }
    }
  });
  it('stands both mezzanines up, inside the storey each hangs in, without breaking the stack', () => {
    const p = createDemo();
    const mezzanines = p.floors.filter(f => f.mezzanine);
    expect(mezzanines).toHaveLength(2);
    for (const m of mezzanines) {
      // A walker's eye is 2.03 m: anything under about 2.4 is a shelf, not a level you walk on.
      expect(m.height, `${m.name} is standable`).toBeGreaterThanOrEqual(2.4);
      const host = p.floors
        .filter(f => !f.mezzanine && f.buildingId === m.buildingId && f.elevation <= m.elevation)
        .sort((a, b) => b.elevation - a.elevation)[0];
      expect(host, `${m.name} hangs in a storey`).toBeTruthy();
      expect(m.elevation - host.elevation, `${m.name} leaves headroom under it`).toBeGreaterThanOrEqual(2.4);
      expect(m.elevation + m.height, `${m.name} fits under its host's slab`).toBeLessThanOrEqual(
        host.elevation + host.height + 1e-9,
      );
    }
    // And the full storeys still stack: no floor's ceiling pokes into the level above it.
    const stack = p.floors.filter(f => !f.mezzanine).sort((a, b) => a.elevation - b.elevation);
    for (let i = 1; i < stack.length; i++)
      expect(
        stack[i - 1].elevation + stack[i - 1].height,
        `${stack[i - 1].name} under ${stack[i].name}`,
      ).toBeLessThanOrEqual(stack[i].elevation + 1e-9);
  });
  it('keeps the office fit-out out of the shafts: no partition crosses a well on 07-09', () => {
    const p = createDemo();
    const primary = primaryShafts(p);
    const shafts = p.objects.filter(o => isVertical(o.kind) && primary.has(o.id));
    for (const floorId of ['floor-07', 'floor-08', 'floor-09']) {
      const wells = shafts.filter(o => o.servedFloorIds?.includes(floorId)).map(o => openRing(footprint(o)[0]));
      expect(wells.length).toBeGreaterThan(4);
      for (const barrier of p.barriers.filter(b => b.floorId === floorId)) {
        const [a, b] = barrierEnds(p, barrier) as [Point, Point];
        for (const well of wells) {
          const hit =
            pointInRing(a, well) ||
            pointInRing(b, well) ||
            well.some((pt, i) => crosses(a, b, pt, well[(i + 1) % well.length]));
          expect(hit, `${barrier.name} on ${floorId} stands in a shaft`).toBe(false);
        }
      }
    }
  });
  it('refuses a core told to serve a gallery it stands outside of', () => {
    // The rule the schema gained, on the building it was written for: Lift C is in the east core,
    // four metres beyond the edge of the entresol gallery, so a landing there would be a door onto
    // the hall two storeys down. The demo's own served lists are trimmed to the levels each shaft
    // stands on; put one back and the document stops being valid.
    const p = createDemo();
    const liftC = p.objects.find(o => o.name === 'Lift C')!;
    expect(liftC.servedFloorIds).not.toContain('floor-entresol');
    liftC.servedFloorIds = [...liftC.servedFloorIds!, 'floor-entresol'];
    expect(() => validateProject(JSON.parse(JSON.stringify(p)))).toThrow(/opens onto nothing/);
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
    expect(ids).toHaveLength(1477);
    expect(isolated(doorOnly), 'door-only inference strands most of the store').toHaveLength(1305);
    expect(isolated([...doorOnly, ...inferOpenBoundaries(p)]), 'open boundaries reach the rest').toHaveLength(0);
    // One object per shaft, not one per storey: a lift is a thing standing in a place reaching a
    // list of levels, and `servedFloorIds` is where that list lives.
    expect(
      p.objects.filter(o => o.kind === 'elevator'),
      'the lift shafts the guide counts',
    ).toHaveLength(8);
  });
});
