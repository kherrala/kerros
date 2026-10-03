import { beforeAll, expect, it } from 'vitest';
import { createDemo } from './demo';
import { areaOf, intersection } from './stockmannPlanning';
import { containedBy, footprint, objectArea } from '../../src/model/geometry';
import { createRouteClearance } from '../../src/model/routeClearance';
import { normalizeBoundaries } from '../../src/model/boundaries';
import type { ProjectDocument } from '../../src/model/types';

let p: ProjectDocument;
beforeAll(() => {
  p = createDemo();
}, 30_000);

it('gives every storey its own programme and reserves circulation before departments', () => {
  const programmes = new Set<string>();
  for (const floor of p.floors.filter(f => !f.id.startsWith('floor-p'))) {
    const rooms = p.objects.filter(o => o.floorId === floor.id && o.kind === 'room' && o.category);
    const circulation = rooms.filter(o => o.category === 'circulation');
    expect(circulation.length, floor.name).toBeGreaterThanOrEqual(5);
    expect(
      rooms.some(o => /lift.*lobby/i.test(o.name)),
      floor.name,
    ).toBe(true);
    expect(rooms.filter(o => o.category !== 'circulation').length, floor.name).toBeGreaterThanOrEqual(7);
    programmes.add(
      rooms
        .filter(o => o.category !== 'circulation')
        .map(o => o.name)
        .sort()
        .join('|'),
    );
    const plate = p.objects
      .filter(o => o.floorId === floor.id && o.kind === 'zone' && !o.slope)
      .sort((a, b) => objectArea(b) - objectArea(a))[0];
    for (const room of rooms.filter(o => o.category))
      expect(containedBy(room.rings!, plate.rings!), `${floor.name}: ${room.name}`).toBe(true);
    // Departments occupy disjoint faces. A circulation loop surrounding a department must not
    // introduce a fictitious slab hole that would make its floor non-walkable.
    for (let i = 0; i < rooms.length; i++) {
      expect(rooms[i].rings).toHaveLength(1);
      for (let j = i + 1; j < rooms.length; j++)
        expect(
          intersection(rooms[i].rings!, rooms[j].rings!).reduce((sum, r) => sum + areaOf(r), 0),
          `${floor.id}: ${rooms[i].name} / ${rooms[j].name}`,
        ).toBeLessThan(0.001);
    }
  }
  expect(programmes.size).toBe(14);
});

it('reaches every room and vertical landing from the street through clear walking edges', () => {
  const byId = new Map(p.navNodes!.map(n => [n.id, n]));
  const adjacent = new Map<string, string[]>();
  const link = (a: string, b: string) => adjacent.set(a, [...(adjacent.get(a) ?? []), b]);
  const clearance = createRouteClearance(p);
  const clear = new Map(p.floors.map(f => [f.id, clearance(f.id)]));
  for (const e of p.navEdges!) {
    link(e.aId, e.bId);
    if (!e.directed) link(e.bId, e.aId);
    if (e.kind !== 'walk') continue;
    const a = byId.get(e.aId)!,
      b = byId.get(e.bId)!;
    expect(a.floorId).toBe(b.floorId);
    if (a.floorId) expect(clear.get(a.floorId)!(a.position, b.position), `Blocked walk on ${a.floorId}`).toBe(true);
  }
  const main = p.objects.find(o => o.name === 'Main entrance')!;
  const pending = p.navNodes!.filter(n => n.objectId === main.id).map(n => n.id);
  const reached = new Set<string>();
  while (pending.length) {
    const id = pending.pop()!;
    if (reached.has(id)) continue;
    reached.add(id);
    pending.push(...(adjacent.get(id) ?? []));
  }
  for (const room of p.objects.filter(o => o.kind === 'room'))
    expect(
      p.navNodes!.some(n => n.objectId === room.id && reached.has(n.id)),
      `${room.floorId}: ${room.name}`,
    ).toBe(true);
  const verticalIds = new Set(p.objects.filter(o => o.kind === 'stairs' || o.kind === 'elevator').map(o => o.id));
  for (const node of p.navNodes!.filter(n => n.objectId && verticalIds.has(n.objectId)))
    expect(reached.has(node.id), `Landing ${node.objectId} on ${node.floorId}`).toBe(true);
});

it('keeps parking bays clear of lobbies, service rooms and marked pedestrian routes', () => {
  for (const floor of p.floors.filter(f => f.id.startsWith('floor-p'))) {
    const rooms = p.objects.filter(o => o.floorId === floor.id && o.kind === 'room');
    const bays = p.objects.filter(o => o.floorId === floor.id && o.symbol === 'parking');
    const deck = p.objects.find(o => o.floorId === floor.id && o.name.startsWith('Parking deck'))!;
    for (const bay of bays)
      for (const room of rooms)
        expect(
          intersection(footprint(bay), room.rings!).reduce((sum, r) => sum + areaOf(r), 0),
          `${bay.name} in ${room.name}`,
        ).toBeLessThan(0.01);
    for (const aisle of p.objects.filter(
      o => o.floorId === floor.id && o.name.startsWith('Aisle ') && o.kind === 'zone',
    ))
      expect(containedBy(aisle.rings!, deck.rings!), aisle.name).toBe(true);
  }
});

it('ships joined partitions with doors and windows intact before the first edit', () => {
  const draft = structuredClone(p);
  for (const floor of p.floors) normalizeBoundaries(draft, floor.id);
  expect(draft.barriers).toEqual(p.barriers);
  expect(draft.junctions).toEqual(p.junctions);
  expect(draft.objects).toEqual(p.objects);
});
