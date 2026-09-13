import { describe, expect, it } from 'vitest';
import {
  addBoundaryHole,
  addVirtualBoundary,
  boundaryEdges,
  boundaryRegions,
  connectSpace,
  derivedSpaceRings,
  disconnectSpace,
} from './boundaries';
import { drawBarrier, encloseRoom, dragGeometry } from './authoring';
import {
  addBarrier,
  barrierEnds,
  distance,
  duplicateFloor,
  objectArea,
  rectangle,
  removeBarrier,
  removeFloor,
  rotate,
  splitRoom,
} from './geometry';
import { mergeSpaces } from './inference';
import { createObject } from './factory';
import { newProject } from './testFixtures';
import { transact, validateProject } from './validate';
import type { ProjectDocument } from './types';
import { commitHistory, makeHistory, redoHistory, undoHistory } from './history';

const floor = 'floor-ground';
function edit(p: ProjectDocument, action: (d: ProjectDocument) => void) {
  const before = JSON.stringify(p),
    result = transact(p, action);
  expect(JSON.stringify(p)).toBe(before);
  if (!result.ok) throw new Error(result.error);
  validateProject(JSON.parse(JSON.stringify(result.project)));
  return result.project;
}
function shell(angle = 0) {
  return edit(newProject(), p => {
    const r = rectangle([0, 0], 10, 8, angle);
    for (let i = 1; i < r.length; i++) addBarrier(p, r[i - 1], r[i], floor, 'wall')!.thickness = 0.2;
    encloseRoom(p, floor, [0, 0]);
  });
}

describe('shared space boundaries', () => {
  it('stores edge references and a generated inside-face footprint', () => {
    const p = shell(),
      room = p.objects[0];
    expect(room.geometry?.mode).toBe('boundaries');
    expect(room.rings).toEqual(derivedSpaceRings(p, room));
    expect(objectArea(room)).toBeCloseTo(9.8 * 7.8, 8);
    expect(p.virtualBoundaries ?? []).toHaveLength(0);
  });

  it('follows a wall moved beyond the old overlap-matching threshold and preserves the room identity', () => {
    const p = shell(),
      room = p.objects[0],
      right = p.barriers.find(b => barrierEnds(p, b).every(q => q[0] === 5))!;
    const next = edit(p, d => {
      for (const j of d.junctions) if ([right.startId, right.endId].includes(j.id)) j.position[0] = 30;
    });
    expect(next.objects).toHaveLength(1);
    expect(next.objects[0].id).toBe(room.id);
    expect(next.objects[0].width).toBeCloseTo(34.8, 8);
    expect(next.objects[0].rings).toEqual(derivedSpaceRings(next, next.objects[0]));
  });

  it('updates both sides when a partition moves or thickens', () => {
    let p = edit(shell(), d => drawBarrier(d, floor, [0, -4], [0, 4]));
    const ids = p.objects.map(o => o.id),
      wall = p.barriers.find(b => barrierEnds(p, b).every(q => Math.abs(q[0]) < 1e-8))!;
    expect(p.objects).toHaveLength(2);
    p = edit(p, d => {
      d.barriers.find(b => b.id === wall.id)!.thickness = 0.4;
      for (const j of d.junctions) if ([wall.startId, wall.endId].includes(j.id)) j.position[0] = 2;
    });
    expect(p.objects.map(o => o.id)).toEqual(ids);
    const byX = [...p.objects].sort((a, b) => a.position[0] - b.position[0]);
    expect(Math.max(...byX[0].rings![0].map(q => q[0]))).toBeCloseTo(1.8, 8);
    expect(Math.min(...byX[1].rings![0].map(q => q[0]))).toBeCloseTo(2.2, 8);
    expect(byX.reduce((s, o) => s + objectArea(o), 0)).toBeCloseTo((9.8 - 0.4) * 7.8, 8);
  });

  it('keeps a virtual division and both identities when its wall is removed, and merges only explicitly', () => {
    let p = edit(shell(), d => drawBarrier(d, floor, [0, -4], [0, 4]));
    const ids = p.objects.map(o => o.id),
      wall = p.barriers.find(b => barrierEnds(p, b).every(q => q[0] === 0))!;
    p = edit(p, d => removeBarrier(d, wall.id));
    expect(p.objects.map(o => o.id)).toEqual(ids);
    expect(p.virtualBoundaries!.map(e => e.id)).toContain(wall.id);
    expect(p.objects.reduce((s, o) => s + objectArea(o), 0)).toBeCloseTo(9.8 * 7.8, 8);
    p = edit(p, d => {
      expect(mergeSpaces(d, ids[0], ids[1])).toBe(true);
    });
    expect(p.objects).toHaveLength(1);
    expect(p.objects[0].id).toBe(ids[0]);
    expect(p.virtualBoundaries).toHaveLength(0);
    expect(objectArea(p.objects[0])).toBeCloseTo(9.8 * 7.8, 8);
  });

  it('creates a shared virtual division and can build a physical wall on it', () => {
    let p = edit(shell(), d => addVirtualBoundary(d, floor, [0, -4], [0, 4]));
    expect(p.objects).toHaveLength(2);
    expect(p.barriers).toHaveLength(6);
    expect(p.virtualBoundaries).toHaveLength(1);
    const ids = p.objects.map(o => o.id);
    p = edit(p, d => drawBarrier(d, floor, [0, 4], [0, -4]));
    expect(p.virtualBoundaries).toHaveLength(0);
    expect(p.objects.map(o => o.id)).toEqual(ids);
    expect(p.objects.reduce((s, o) => s + objectArea(o), 0)).toBeCloseTo((9.8 - 0.3) * 7.8, 8);
  });

  it('subdivides an X crossing into one junction shared by all four branches', () => {
    const p = edit(newProject(), d => {
      drawBarrier(d, floor, [-3, 0], [3, 0]);
      drawBarrier(d, floor, [0, -3], [0, 3]);
    });
    const common = p.junctions.find(j => distance(j.position, [0, 0]) < 1e-8)!;
    expect(p.barriers).toHaveLength(4);
    expect(p.barriers.every(b => b.startId === common.id || b.endId === common.id)).toBe(true);
  });

  it('canonicalizes a partial collinear overlap without duplicate walls', () => {
    const p = edit(newProject(), d => {
      drawBarrier(d, floor, [0, 0], [6, 0]);
      drawBarrier(d, floor, [9, 0], [3, 0]);
    });
    expect(p.barriers).toHaveLength(3);
    expect(p.barriers.reduce((s, b) => s + distance(...barrierEnds(p, b)), 0)).toBeCloseTo(9, 8);
  });

  it('refuses crossing an opening atomically and permits the next edit', () => {
    const p = edit(newProject(), d => {
      const b = addBarrier(d, [-3, 0], [3, 0], floor, 'wall')!;
      const door = createObject('door', [0, 0], floor);
      Object.assign(door, { barrierId: b.id, offset: 3, width: 1 });
      d.objects.push(door);
    });
    expect(transact(p, d => drawBarrier(d, floor, [0, -3], [0, 3]))).toEqual({
      ok: false,
      error: 'A junction cannot split an opening.',
    });
    expect(edit(p, d => drawBarrier(d, floor, [2, -3], [2, 3])).barriers).toHaveLength(4);
  });

  it('preserves opening position when its wall is split away from the opening', () => {
    let p = edit(shell(), d => {
      const wall = d.barriers[0],
        door = createObject('door', [0, 0], floor);
      Object.assign(door, { barrierId: wall.id, width: 1, offset: 8 });
      d.objects.push(door);
    });
    p = edit(p, d => drawBarrier(d, floor, [0, -4], [0, 4]));
    const door = p.objects.find(o => o.kind === 'door')!,
      wall = p.barriers.find(b => b.id === door.barrierId)!;
    const [a] = barrierEnds(p, wall);
    expect(a[0] + door.offset!).toBeCloseTo(3, 8);
    expect(p.objects.filter(o => o.kind === 'room')).toHaveLength(2);
  });

  it('derives a courtyard hole and follows its walls when they move', () => {
    let p = edit(newProject(), d => {
      for (const size of [12, 4]) {
        const r = rectangle([0, 0], size, size);
        for (let i = 1; i < r.length; i++) addBarrier(d, r[i - 1], r[i], floor, 'wall')!.thickness = 0.2;
      }
      encloseRoom(d, floor, [4, 0]);
    });
    expect(p.objects[0].rings).toHaveLength(2);
    expect(objectArea(p.objects[0])).toBeCloseTo(11.8 ** 2 - 4.2 ** 2, 8);
    p = edit(p, d => {
      for (const j of d.junctions)
        if (Math.abs(j.position[0]) === 2 && Math.abs(j.position[1]) === 2) j.position[0] += 1;
    });
    expect(p.objects).toHaveLength(1);
    expect(p.objects[0].rings).toHaveLength(2);
    expect(Math.min(...p.objects[0].rings![1].map(q => q[0]))).toBeCloseTo(-1.1, 8);
  });

  it('keeps an incomplete spur from becoming a fake region', () => {
    const p = edit(shell(), d => drawBarrier(d, floor, [0, -4], [0, 0]));
    expect(p.objects).toHaveLength(1);
    expect(boundaryRegions(p, floor)).toHaveLength(1);
    expect(objectArea(p.objects[0])).toBeLessThan(9.8 * 7.8);
  });

  it('preserves legacy outlines and supports explicit connection and detachment', () => {
    let p = edit(newProject(), d => {
      const room = createObject('room', [0, 0], floor);
      room.rings = [rectangle([0, 0], 8, 6)];
      d.objects.push(room);
    });
    const original = p.objects[0];
    p = edit(p, d => addBarrier(d, [9, 0], [9, 8], floor, 'wall'));
    expect(p.objects[0]).toEqual(original);
    p = edit(p, d => connectSpace(d, original.id));
    expect(p.virtualBoundaries).toHaveLength(4);
    expect(objectArea(p.objects[0])).toBeCloseTo(48, 8);
    p = edit(p, d => disconnectSpace(d, original.id));
    const rings = p.objects[0].rings;
    p = edit(p, d => {
      d.junctions.find(j => j.id === d.virtualBoundaries![0].startId)!.position[0] -= 1;
    });
    expect(p.objects[0].rings).toEqual(rings);
  });

  it('rejects stale saved caches and repairs caches within a transaction', () => {
    const p = shell(),
      stale = structuredClone(p);
    stale.objects[0].rings![0][0][0] += 0.5;
    expect(() => validateProject(stale)).toThrow(/stale/);
    const corrected = edit(p, d => {
      d.objects[0].width = 100;
    });
    expect(corrected.objects[0].width).toBeCloseTo(9.8, 8);
  });

  it('refuses broken loops, cross-floor references and duplicate ownership', () => {
    const p = shell();
    for (const damage of ['missing', 'reverse', 'duplicate', 'floor'] as const) {
      const broken = structuredClone(p),
        o = broken.objects[0];
      if (damage === 'duplicate') broken.objects.push({ ...structuredClone(o), id: 'other' });
      else if (damage === 'floor') o.floorId = null;
      else if (o.geometry?.mode === 'boundaries') {
        if (damage === 'missing') o.geometry.loops[0][0].edgeId = 'missing';
        else o.geometry.loops[0][0].reversed = !o.geometry.loops[0][0].reversed;
      }
      expect(() => validateProject(broken)).toThrow();
    }
  });

  it('duplicates and removes floors with all boundary references remapped', () => {
    let p = edit(shell(), d => addVirtualBoundary(d, floor, [0, -4], [0, 4]));
    let copy = '';
    p = edit(p, d => {
      copy = duplicateFloor(d, floor);
    });
    expect(p.objects.filter(o => o.floorId === copy)).toHaveLength(2);
    expect(p.virtualBoundaries).toHaveLength(2);
    const old = new Set(
      boundaryEdges(p)
        .filter(e => e.floorId === floor)
        .map(e => e.id),
    );
    for (const o of p.objects.filter(o => o.floorId === copy))
      if (o.geometry?.mode === 'boundaries') expect(o.geometry.loops.flat().some(u => old.has(u.edgeId))).toBe(false);
    p = edit(p, d => removeFloor(d, copy));
    expect(p.virtualBoundaries).toHaveLength(1);
    expect(p.objects).toHaveLength(2);
  });

  it.each([0, 15, 23, 45, 113, 271])('conserves floor area across a virtual split on a %i degree floor', angle => {
    let p = shell(angle);
    const original = objectArea(p.objects[0]);
    p = edit(p, d => splitRoom(d, d.objects[0].id, rotate([0, -5], angle), rotate([0, 5], angle), false));
    expect(p.objects).toHaveLength(2);
    expect(p.objects.reduce((s, o) => s + objectArea(o), 0)).toBeCloseTo(original, 7);
  });

  it('clamps a collapsing wall drag and restores references through undo and redo', () => {
    const p = shell(),
      wall = p.barriers[1];
    const next = dragGeometry(p, floor, { kind: 'barrier', id: wall.id, point: [-8, 0] });
    expect(next.objects[0].id).toBe(p.objects[0].id);
    expect(objectArea(next.objects[0])).toBeGreaterThanOrEqual(1);
    const history = commitHistory(makeHistory(p), next);
    expect(undoHistory(history).present.objects).toEqual(p.objects);
    expect(redoHistory(undoHistory(history)).present.objects).toEqual(next.objects);
  });

  it.each([0.99, 1, 1.01])('requires 1 m² of usable area when enclosing (%s m²)', usableArea => {
    const width = usableArea + 0.2;
    const p = edit(newProject(), d => {
      const r = rectangle([0, 0], width, 1.2);
      for (let i = 1; i < r.length; i++) addBarrier(d, r[i - 1], r[i], floor, 'wall')!.thickness = 0.2;
    });
    const result = transact(p, d => {
      encloseRoom(d, floor, [0, 0]);
    });
    expect(result.ok).toBe(usableArea >= 1);
    if (result.ok) expect(objectArea(result.project.objects[0])).toBeCloseTo(usableArea, 8);
    else expect(result.error).toMatch(/at least 1 m²/);
  });

  it('uses net area for independent room creation and preserves small legacy outlines', () => {
    const p = newProject(),
      room = createObject('room', [0, 0], floor);
    room.rings = [rectangle([0, 0], 1.1, 1.1), rectangle([0, 0], 0.5, 0.5)];
    expect(transact(p, d => d.objects.push(room))).toEqual({
      ok: false,
      error: 'A space needs at least 1 m² of usable area.',
    });
    p.objects.push(room); // An older document may already contain this outline.
    const renamed = edit(p, d => {
      d.objects[0].name = 'Existing cupboard';
    });
    expect(renamed.objects[0].rings).toEqual(room.rings);
  });

  it.each([false, true])('refuses a split below 1 m² and accepts the next cut (shared=%s)', shared => {
    let p = edit(newProject(), d => {
      const room = createObject('room', [0, 0], floor);
      room.rings = [rectangle([0, 0], 4, 2)];
      d.objects.push(room);
      if (shared) connectSpace(d, room.id);
    });
    const old = JSON.stringify(p);
    expect(transact(p, d => splitRoom(d, d.objects[0].id, [-1.75, -2], [-1.75, 2], false)).ok).toBe(false);
    expect(JSON.stringify(p)).toBe(old);
    p = edit(p, d => splitRoom(d, d.objects[0].id, [0, -2], [0, 2], false));
    expect(p.objects).toHaveLength(2);
    expect(p.objects.every(o => objectArea(o) >= 1)).toBe(true);
  });

  it('retains small graph faces without creating sliver rooms or losing small holes', () => {
    let p = edit(shell(), d => addVirtualBoundary(d, floor, [-4.85, -4], [-4.85, 4]));
    expect(boundaryRegions(p, floor)).toHaveLength(2);
    expect(p.objects).toHaveLength(1);
    const area = objectArea(p.objects[0]);
    p = edit(p, d => addBoundaryHole(d, d.objects[0], rectangle([0, 0], 0.5, 0.5)));
    expect(p.objects[0].rings).toHaveLength(2);
    expect(objectArea(p.objects[0])).toBeCloseTo(area - 0.25, 8);
  });

  it('refuses a wall whose thickness disconnects a space until its centreline reaches the boundary', () => {
    const p = shell(),
      original = JSON.stringify(p);
    const refused = transact(p, d => drawBarrier(d, floor, [0, -4], [0, 3.8]));
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error).toMatch(/disconnected usable regions/);
    expect(JSON.stringify(p)).toBe(original);
    const next = edit(p, d => drawBarrier(d, floor, [0, -4], [0, 4]));
    expect(next.objects).toHaveLength(2);
  });

  it('preserves semantic membership and keeps the live feed on the original after splitting', () => {
    const p = edit(shell(), d => {
      d.objects[0].feedId = 'occupancy';
      d.zones = [{ id: 'department', name: 'Department', spaceIds: [d.objects[0].id] }];
      addVirtualBoundary(d, floor, [0, -4], [0, 4]);
    });
    expect(p.zones![0].spaceIds).toEqual(p.objects.map(o => o.id));
    expect(p.objects.map(o => o.feedId)).toEqual(['occupancy', undefined]);
  });

  it('satisfies Euler’s bounded-face count with disconnected components, a hole, bridges and crossings', () => {
    const p = edit(shell(), d => {
      addVirtualBoundary(d, floor, [0, -4], [0, 4]);
      addVirtualBoundary(d, floor, [-5, 0], [5, 0]);
      addVirtualBoundary(d, floor, [-3, -4], [-3, -3]);
      const hole = rectangle([2, 2], 1, 1);
      for (let i = 1; i < hole.length; i++) addVirtualBoundary(d, floor, hole[i - 1], hole[i]);
    });
    const edges = boundaryEdges(p),
      vertices = new Set(edges.flatMap(e => [e.startId, e.endId]));
    const visited = new Set<string>();
    let components = 0;
    for (const vertex of vertices)
      if (!visited.has(vertex)) {
        components++;
        const stack = [vertex];
        while (stack.length) {
          const at = stack.pop()!;
          if (visited.has(at)) continue;
          visited.add(at);
          for (const edge of edges) {
            if (edge.startId === at) stack.push(edge.endId);
            if (edge.endId === at) stack.push(edge.startId);
          }
        }
      }
    expect(boundaryRegions(p, floor)).toHaveLength(edges.length - vertices.size + components);
  });
});

import { drawVirtualBoundary } from './boundaries';

describe('drawing an open wall passage', () => {
  it.each([0, 37, 90])('cuts just the covered span and keeps both rooms at %s degrees', angle => {
    const at = (q: [number, number]) => rotate(q, angle);
    const p = edit(shell(angle), d => drawBarrier(d, floor, at([0, -4]), at([0, 4])));
    const ids = p.objects.map(o => o.id);
    const next = edit(p, d => drawVirtualBoundary(d, floor, at([0, 1]), at([0, -1])));
    expect(next.objects.map(o => o.id)).toEqual(ids);
    expect(next.virtualBoundaries).toHaveLength(1);
    expect(distance(...barrierEnds(next, next.virtualBoundaries![0]))).toBeCloseTo(2);
    expect(next.barriers).toHaveLength(p.barriers.length + 1);
    expect(next.objects.reduce((a, o) => a + objectArea(o), 0)).toBeGreaterThan(
      p.objects.reduce((a, o) => a + objectArea(o), 0),
    );
    const history = commitHistory(makeHistory(p), next);
    expect({ ...undoHistory(history).present, updatedAt: p.updatedAt }).toEqual(p);
  });
  it('removes a wholly covered door, but refuses a cut through part of a door atomically', () => {
    const p = edit(shell(), d => {
      const wall = drawBarrier(d, floor, [0, -4], [0, 4])!;
      const door = createObject('door', [0, 0], floor);
      Object.assign(door, { barrierId: wall.id, offset: 4, width: 1 });
      d.objects.push(door);
    });
    const before = JSON.stringify(p);
    const rejected = transact(p, d => drawVirtualBoundary(d, floor, [0, 0], [0, 2]));
    expect(rejected.ok).toBe(false);
    expect(JSON.stringify(p)).toBe(before);
    const next = edit(p, d => drawVirtualBoundary(d, floor, [0, -1], [0, 1]));
    expect(next.objects.some(o => o.kind === 'door')).toBe(false);
    expect(next.objects.filter(o => o.kind === 'room')).toHaveLength(2);
  });
});
