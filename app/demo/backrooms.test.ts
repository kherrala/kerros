import { describe, expect, it } from 'vitest';
import { barrierEnds, objectArea, parseExport, validateProject, ringArea, pointInRing } from '@kerros/schema';
import { floorDropAt } from '../../src/map/walkSurfaces';
import { createBackrooms, OFFICE_CELL } from './backrooms';
import { generateOfficeLayout } from './officeLayout';
import { flights, primaryShafts } from '../../src/model/vertical';

function reachable<T>(start: T, edges: [T, T][]): Set<T> {
  const adjacent = new Map<T, T[]>();
  for (const [a, b] of edges) {
    adjacent.set(a, [...(adjacent.get(a) ?? []), b]);
    adjacent.set(b, [...(adjacent.get(b) ?? []), a]);
  }
  const seen = new Set([start]),
    queue = [start];
  for (let i = 0; i < queue.length; i++)
    for (const next of adjacent.get(queue[i]) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  return seen;
}

describe('procedural office layouts', () => {
  it('repeats the same seed, varies other seeds, and contains several room sizes', () => {
    const a = generateOfficeLayout('repeatable');
    expect(generateOfficeLayout('repeatable')).toEqual(a);
    expect(generateOfficeLayout('another')).not.toEqual(a);
    expect(new Set(a.rooms.map(r => `${r.width}:${r.depth}`)).size).toBeGreaterThan(3);
  });
  it.each(['yellow', 'records', '0', '∞', 'narrow', 'large'])(
    'covers every cell once and connects every room for seed %s',
    seed => {
      const layout = generateOfficeLayout(seed, seed === 'large' ? 48 : 24, seed === 'narrow' ? 12 : 28);
      const counts = Array(layout.cells.length).fill(0);
      layout.rooms.forEach((room, i) => {
        for (let y = room.y; y < room.y + room.depth; y++)
          for (let x = room.x; x < room.x + room.width; x++) {
            expect(x).toBeLessThan(layout.columns);
            expect(y).toBeLessThan(layout.rows);
            const cell = y * layout.columns + x;
            counts[cell]++;
            expect(layout.cells[cell]).toBe(i);
          }
      });
      expect(counts.every(n => n === 1)).toBe(true);
      const passages = layout.boundaries.filter(e => e.passage);
      expect(passages.every(e => e.b !== -1)).toBe(true); // the perimeter is sealed
      expect(
        reachable(
          0,
          passages.map(e => [e.a, e.b]),
        ).size,
      ).toBe(layout.rooms.length);
      expect(passages.length).toBeGreaterThan(layout.rooms.length - 1); // loops, not only a tree
    },
  );
  it.each([0, 11, 49, 24.5, NaN, Infinity])('rejects invalid dimensions %s', size => {
    expect(() => generateOfficeLayout('seed', size)).toThrow(/dimensions/);
  });
});

describe('Backrooms reference sample', () => {
  const project = createBackrooms();
  it('validates and survives a portable JSON round trip', () => {
    expect(validateProject(JSON.parse(JSON.stringify(project)))).toEqual(project);
    expect(parseExport(JSON.stringify({ ...project, embeddedAssets: {} })).project).toEqual(project);
  });
  it('has hundreds of rooms on each distinct floor with complete coverage', () => {
    for (const f of project.floors.filter(f => f.id.startsWith('backrooms-office-'))) {
      const rooms = project.objects.filter(o => o.floorId === f.id && o.kind === 'room');
      expect(rooms.length).toBeGreaterThan(250);
      const holes = rooms
        .flatMap(o => o.rings?.slice(1) ?? [])
        .reduce((sum, hole) => sum + Math.abs(ringArea(hole)), 0);
      expect(rooms.reduce((sum, r) => sum + objectArea(r), 0) + holes).toBeCloseTo((28 * OFFICE_CELL) ** 2);
      expect(rooms.every(r => r.material === 'carpet')).toBe(true);
    }
    expect(
      new Set(project.floors.map(f => project.objects.filter(o => o.floorId === f.id && o.kind === 'room').length))
        .size,
    ).toBeGreaterThan(1);
    expect(
      project.barriers.filter(b => b.floorId?.startsWith('backrooms-office-')).every(b => b.material === 'wallpaper'),
    ).toBe(true);
  });
  it('routes to every room across the offices and bath levels', () => {
    const seen = reachable(
      project.navNodes![0].id,
      project.navEdges!.map(e => [e.aId, e.bId]),
    );
    expect(seen.size).toBe(project.navNodes!.length);
    const bound = new Set(project.navNodes!.filter(n => seen.has(n.id)).map(n => n.objectId));
    expect(project.objects.filter(o => o.kind === 'room').every(r => bound.has(r.id))).toBe(true);
  });
  it('uses one shared staircase and one flight between each adjacent pair of levels', () => {
    const stairs = project.objects.filter(o => o.kind === 'stairs');
    expect(stairs).toHaveLength(1);
    expect(primaryShafts(project)).toEqual(new Set([stairs[0].id]));
    const climbs = flights(project, stairs[0]);
    expect(climbs).toHaveLength(project.floors.length - 1);
    expect(new Set(climbs.map(f => `${f.from.id}/${f.to.id}`)).size).toBe(climbs.length);
    expect(project.navEdges!.filter(e => e.kind === 'stairs').every(e => e.objectId === stairs[0].id)).toBe(true);
    expect(project.navNodes!.filter(n => n.objectId === stairs[0].id)).toHaveLength(project.floors.length);
  });
  it('has vast halls with rectangular drops and a double-height landing beneath each opening', () => {
    const galleries = project.objects.filter(
      o => o.floorId === 'backrooms-office-0' && o.category === 'backrooms-hall',
    );
    expect(galleries).toHaveLength(2);
    for (const gallery of galleries) {
      expect(objectArea(gallery)).toBeGreaterThan(500);
      expect(gallery.rings![1]).toHaveLength(5);
      const drop = floorDropAt(project, gallery.floorId, gallery.position);
      expect(drop?.floorId).toBe('backrooms-office-1');
      expect(drop?.distance).toBeCloseTo(3.6);
      expect(
        project.objects.some(
          o => o.floorId === drop!.floorId && o.ceilingHeight! > 6 && pointInRing(gallery.position, o.rings![0]),
        ),
      ).toBe(true);
    }
  });
  it('puts white tiled pool halls below the offices, with clear basins, slides and submerged lights', () => {
    const baths = project.floors.filter(f => f.id.startsWith('backrooms-pool-'));
    expect(baths).toHaveLength(2);
    for (const floor of baths) {
      expect(floor.elevation).toBeLessThan(-11.2);
      expect(floor.light?.level).toBe(0);
      expect(floor.ambience).toEqual({ preset: 'baths', level: 0.55 });
      const objects = project.objects.filter(o => o.floorId === floor.id);
      expect(
        objects.filter(o => o.kind === 'light').every(o => o.light!.mountHeight! < 0 && o.light!.kelvin >= 9000),
      ).toBe(true);
      const rooms = objects.filter(o => o.kind === 'room');
      expect(rooms.length).toBeGreaterThan(30);
      expect(rooms.every(o => o.ceilingHeight! >= 7)).toBe(true);
      expect(rooms.some(o => o.ceilingHeight === 10)).toBe(true);
      const pools = objects.filter(o => o.water);
      expect(pools).toHaveLength(6);
      const poolRooms = pools.map(pool => rooms.find(room => room.id === pool.parentId)!);
      expect(poolRooms.filter(room => room.width <= 10 && room.depth <= 10)).toHaveLength(4);
      expect(objects.filter(o => o.slide)).toHaveLength(2);
      expect(objects.filter(o => o.material).every(o => o.material === 'tile')).toBe(true);
      expect(
        project.barriers.filter(b => b.floorId === floor.id).every(b => b.material === 'tile' && b.color === '#f2f3ef'),
      ).toBe(true);
      for (const pool of pools) {
        expect(pool.water!.depth).toBeGreaterThan(0.5);
        const lamps = objects.filter(
          o => o.kind === 'light' && o.light?.mountHeight !== undefined && pointInRing(o.position, pool.rings![0]),
        );
        expect(lamps.length).toBeGreaterThanOrEqual(4);
        expect(lamps.every(o => o.light!.mountHeight! < 0 && o.light!.mountHeight! > -pool.water!.depth)).toBe(true);
      }
    }
  });
  it('puts every passage in a real gap with shoulder clearance', () => {
    const byFloor = new Map(
      project.floors.map(f => [
        f.id,
        project.barriers
          .filter(b => b.floorId === f.id)
          .map(b => ({ ends: barrierEnds(project, b), thickness: b.thickness })),
      ]),
    );
    for (const node of project.navNodes!.filter(n => n.id.includes('-passage-'))) {
      const [x, y] = node.position;
      let clearance = Infinity;
      for (const {
        ends: [[ax, ay], [bx, by]],
        thickness,
      } of byFloor.get(node.floorId!)!) {
        const t = Math.max(
          0,
          Math.min(1, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / ((bx - ax) ** 2 + (by - ay) ** 2)),
        );
        clearance = Math.min(clearance, Math.hypot(x - ax - t * (bx - ax), y - ay - t * (by - ay)) - thickness / 2);
      }
      expect(clearance).toBeGreaterThan(0.28);
    }
  });
  it('keeps generated entity IDs stable and gives each seed/size its own saved project', () => {
    const same = createBackrooms();
    expect({ ...same, updatedAt: project.updatedAt }).toEqual(project);
    expect(createBackrooms({ seed: 'other' }).id).not.toBe(project.id);
    expect(createBackrooms({ size: 24 }).id).not.toBe(project.id);
  });
});
