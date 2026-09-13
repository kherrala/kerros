import { describe, expect, it } from 'vitest';
import { transact, validateProject } from './validate';
import { MIN_SEGMENT, addBarrier, closeRing, distance, openRing, rectangle, splitRoom } from './geometry';
import { addFloor, addPortal as portal, addSpace as space, addTestZone as zone, newProject } from './testFixtures';
import type { ProjectDocument } from './types';

const refuses = (build: (p: ProjectDocument) => void, because: RegExp) => {
  const p = newProject();
  build(p);
  expect(() => validateProject(p)).toThrow(because);
};

describe('rules the schema refuses outright', () => {
  it('a window is an opening but never a portal', () => {
    refuses(p => {
      space(p, 'a', 'floor-ground', [0, 0]);
      space(p, 'b', 'floor-ground', [8, 0]);
      space(p, 'window-1', 'floor-ground', [4, 0], 'window');
      portal(p, 'a', 'b', { openingId: 'window-1' });
    }, /door, gate or turnstile/);
  });
  it('only an opening can sit in a barrier — a camera set into a wall is a placement bug', () => {
    refuses(p => {
      addBarrier(p, [0, 0], [6, 0], 'floor-ground', 'wall');
      space(p, 'cam-1', 'floor-ground', [3, 0], 'camera');
      const cam = p.objects.find(o => o.id === 'cam-1')!;
      cam.rings = undefined;
      cam.barrierId = p.barriers.at(-1)!.id;
      cam.offset = 3;
    }, /Only a door, window or gate/);
  });
  it('zone membership is a set: the same space twice is malformed', () => {
    refuses(p => {
      space(p, 'a', 'floor-ground', [0, 0]);
      zone(p, 'Suite', ['a', 'a']);
    }, /once/);
  });
  it('served floors are a set too', () => {
    refuses(p => {
      space(p, 'lift-1', 'floor-ground', [0, 0], 'elevator');
      p.objects.find(o => o.id === 'lift-1')!.servedFloorIds = ['floor-ground', 'floor-ground'];
    }, /once/);
  });
  it('a lift cannot serve a level it stands nowhere on — its doors would open onto the void', () => {
    refuses(p => {
      addFloor(p, 'floor-mezzanine', 3);
      space(p, 'hall', 'floor-ground', [0, 0]);
      space(p, 'gallery', 'floor-mezzanine', [30, 0]); // the gallery rings the far side of the void
      space(p, 'lift-1', 'floor-ground', [0, 0], 'elevator');
      p.objects.find(o => o.id === 'lift-1')!.servedFloorIds = ['floor-ground', 'floor-mezzanine'];
    }, /opens onto nothing/);
  });
  it('but a shaft in a light well is on the plan, and an undrawn level makes no claim at all', () => {
    const p = newProject();
    addFloor(p, 'floor-1', 3);
    space(p, 'plate', 'floor-1', [0, 0]);
    // A storey plate with an open well at its heart, and the stair winding up inside the well.
    p.objects.find(o => o.id === 'plate')!.rings = [rectangle([0, 0], 30, 30), rectangle([0, 0], 8, 8)];
    space(p, 'stair-1', 'floor-1', [0, 0], 'stairs');
    p.objects.find(o => o.id === 'stair-1')!.servedFloorIds = ['floor-ground', 'floor-1'];
    expect(() => validateProject(p)).not.toThrow(); // floor-ground has nothing drawn on it yet
  });
  it('coordinates a hundred kilometres from the origin are corruption, not geometry', () => {
    refuses(p => {
      p.junctions.push({ id: 'j-far', floorId: 'floor-ground', position: [200_000, 0] });
    }, /junction coordinates/);
  });
  it('rejects a wall below the numerical minimum', () => {
    refuses(p => {
      p.junctions.push(
        { id: 'j1', floorId: 'floor-ground', position: [0, 0] },
        { id: 'j2', floorId: 'floor-ground', position: [0.0005, 0] },
      );
      p.barriers.push({
        id: 'b1',
        floorId: 'floor-ground',
        startId: 'j1',
        endId: 'j2',
        kind: 'wall',
        name: 'Stub',
        thickness: 0.3,
        height: 3,
      });
    }, /at least 0.01 m/);
  });
  it('refuses a door wider than its supporting wall', () => {
    refuses(p => {
      addBarrier(p, [0, 0], [0.8, 0], 'floor-ground', 'wall');
      space(p, 'door-1', 'floor-ground', [0.4, 0], 'door');
      const door = p.objects.find(o => o.id === 'door-1')!;
      door.rings = undefined;
      door.width = 0.9;
      door.barrierId = p.barriers.at(-1)!.id;
      door.offset = 0.4;
    }, /too short for its attached opening/);
  });
});

describe('splitting preserves small architectural features', () => {
  it('keeps a cut and a drawn corner a hand-width apart', () => {
    // A cut vertex on a *straight* run can never leave a sliver — the clip simplifies collinear
    // vertices away. The dangerous case is a cut passing close to a drawn CORNER, where the sliver
    // edge survives simplification. Build a notched hall whose notch corner sits 0.3 m from the cut.
    const p = newProject();
    space(p, 'hall', 'floor-ground', [0, 0]);
    p.objects.find(o => o.id === 'hall')!.rings = [
      closeRing([
        [-5, -5],
        [5, -5],
        [5, 5],
        [0.3, 5],
        [0.3, 7],
        [-5, 7],
      ]),
    ];
    splitRoom(p, 'hall', [0, -8], [0, 9]);
    expect(() => validateProject(p)).not.toThrow();
    // No degenerate edges, but real 0.3 m edges remain rather than being welded away.
    for (const o of p.objects)
      for (const ring of o.rings ?? []) {
        const r = openRing(ring);
        for (let i = 0; i < r.length; i++)
          expect(distance(r[i], r[(i + 1) % r.length])).toBeGreaterThanOrEqual(MIN_SEGMENT);
      }
    for (const b of p.barriers) {
      const ends = [p.junctions.find(j => j.id === b.startId)!, p.junctions.find(j => j.id === b.endId)!];
      expect(distance(ends[0].position, ends[1].position)).toBeGreaterThanOrEqual(MIN_SEGMENT);
    }
    // Both the drawn notch corner and the cut vertex survive.
    const halls = p.objects.filter(o => o.rings);
    expect(halls.some(o => o.rings![0].some(pt => pt[0] === 0.3 && pt[1] === 7))).toBe(true);
    expect(halls.some(o => o.rings![0].some(pt => pt[0] === 0 && pt[1] === 7))).toBe(true);
  });
});

describe('transact — every change is atomic', () => {
  const withRoom = () => {
    const p = newProject();
    space(p, 'room-1', 'floor-ground', [0, 0]);
    return p;
  };
  it('applies a valid change to a clone and leaves the original untouched', () => {
    const p = withRoom();
    const before = structuredClone(p);
    const result = transact(p, d => {
      d.objects.find(o => o.id === 'room-1')!.name = 'Renamed';
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.project).not.toBe(p);
    expect(result.project.objects[0].name).toBe('Renamed');
    expect(p, 'the original did not move').toEqual(before);
  });
  it('refuses a change that breaks a rule, reporting why', () => {
    const p = withRoom();
    const before = structuredClone(p);
    const result = transact(p, d => {
      d.floors = []; // no floors: flagrantly invalid
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/Invalid project/);
    expect(p).toEqual(before);
  });
  it('turns a throwing change into a refusal, not a crash', () => {
    const p = withRoom();
    const result = transact(p, () => {
      throw new Error('splitRoom: that cut would leave disconnected pieces');
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/disconnected pieces/);
  });
  it('returns a frozen document that refuses out-of-band edits, deep down', () => {
    const result = transact(withRoom(), () => {});
    if (!result.ok) throw new Error(result.error);
    expect(Object.isFrozen(result.project)).toBe(true);
    expect(() => {
      (result.project as { name: string }).name = 'sneaky';
    }).toThrow();
    expect(() => {
      result.project.objects.push(result.project.objects[0]);
    }).toThrow();
    expect(() => {
      result.project.objects[0].position[0] = 99;
    }).toThrow();
  });
  it('chains: a frozen result is a fine input for the next transaction', () => {
    const first = transact(withRoom(), d => {
      d.name = 'First';
    });
    if (!first.ok) throw new Error(first.error);
    const second = transact(first.project, d => {
      d.name = 'Second';
    });
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.project.name).toBe('Second');
  });
  it('can hand back a mutable document when explicitly asked', () => {
    const result = transact(withRoom(), () => {}, { freeze: false });
    if (!result.ok) throw new Error(result.error);
    expect(Object.isFrozen(result.project)).toBe(false);
  });
});
