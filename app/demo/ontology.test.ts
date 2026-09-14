import { expect, it } from 'vitest';
import { createDemo } from './demo';
import { createSilo } from './silo';
import { createBackrooms } from './backrooms';
import { primaryShafts, servedFloors, shaftKey } from '../../src/model/vertical';
import { zoneSpaces } from '../../src/model/ontology';
import { navEdges, navNodes } from '../../src/model/navigation';
import { validateProject } from '../../src/schema';

it.each([
  ['Stockmann', createDemo],
  ['Silo', createSilo],
  ['Backrooms', createBackrooms],
] as const)(
  '%s circulation zones and route landings agree with every vertical shaft',
  (_name, make) => {
    const p = make();
    validateProject(p);
    const primaries = primaryShafts(p),
      nodes = navNodes(p),
      edges = navEdges(p);
    const byId = new Map(nodes.map(n => [n.id, n]));
    const elevations = new Map(p.floors.map(f => [f.id, f.elevation]));
    for (const shaft of p.objects.filter(o => primaries.has(o.id))) {
      const twins = new Set(p.objects.filter(o => shaftKey(o) === shaftKey(shaft)).map(o => o.id));
      const zones = p.zones!.filter(z => z.purpose === 'circulation' && zoneSpaces(p, z).some(id => twins.has(id)));
      expect(zones, `${shaft.name} has exactly one circulation zone`).toHaveLength(1);
      expect(new Set(zoneSpaces(p, zones[0]))).toEqual(twins);
      expect(zones[0].connects).toBe(
        shaft.kind === 'elevator' ? 'all' : shaft.stairModel === 'escalator' ? (shaft.travel ?? 'up') : 'adjacent',
      );
      const floors = servedFloors(p, shaft);
      const landings = nodes.filter(n => n.objectId && twins.has(n.objectId));
      for (const floor of floors) {
        const node = landings.find(n => n.floorId === floor.id);
        expect(node, `${shaft.name} at ${shaft.position}: landing on ${floor.id}`).toBeDefined();
        expect(
          edges.some(e => e.kind !== 'stairs' && e.kind !== 'elevator' && (e.aId === node!.id || e.bId === node!.id)),
          `${shaft.name}: access on ${floor.id}`,
        ).toBe(true);
      }
      const rides = edges.filter(
        e => e.objectId && twins.has(e.objectId) && (e.kind === 'stairs' || e.kind === 'elevator'),
      );
      expect(rides.length, `${shaft.name}: every served floor connected`).toBe(
        shaft.kind === 'elevator' ? (floors.length * (floors.length - 1)) / 2 : floors.length - 1,
      );
      for (const edge of rides) {
        expect(twins.has(byId.get(edge.aId)!.objectId!)).toBe(true);
        expect(twins.has(byId.get(edge.bId)!.objectId!)).toBe(true);
        if (shaft.stairModel === 'escalator') {
          expect(edge.directed).toBe(true);
          const rise = elevations.get(byId.get(edge.bId)!.floorId!)! - elevations.get(byId.get(edge.aId)!.floorId!)!;
          expect(Math.sign(rise)).toBe(shaft.travel === 'down' ? -1 : 1);
        } else expect(edge.directed).not.toBe(true);
      }
    }
  },
  30_000,
);
