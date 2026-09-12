import { describe, expect, it } from 'vitest';
import { barrierEnds, objectArea, parseExport, validateProject } from '@kerros/schema';
import { createBackrooms, OFFICE_CELL } from './backrooms';
import { generateOfficeLayout } from './officeLayout';

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
    for (const f of project.floors) {
      const rooms = project.objects.filter(o => o.floorId === f.id && o.kind === 'room');
      expect(rooms.length).toBeGreaterThan(250);
      expect(rooms.reduce((sum, r) => sum + objectArea(r), 0)).toBeCloseTo((28 * OFFICE_CELL) ** 2);
      expect(rooms.every(r => r.material === 'carpet')).toBe(true);
    }
    expect(
      new Set(project.floors.map(f => project.objects.filter(o => o.floorId === f.id && o.kind === 'room').length))
        .size,
    ).toBeGreaterThan(1);
    expect(project.barriers.every(b => b.material === 'wallpaper')).toBe(true);
  });
  it('routes to every room across all three levels', () => {
    const seen = reachable(
      project.navNodes![0].id,
      project.navEdges!.map(e => [e.aId, e.bId]),
    );
    expect(seen.size).toBe(project.navNodes!.length);
    const bound = new Set(project.navNodes!.filter(n => seen.has(n.id)).map(n => n.objectId));
    expect(project.objects.filter(o => o.kind === 'room').every(r => bound.has(r.id))).toBe(true);
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
