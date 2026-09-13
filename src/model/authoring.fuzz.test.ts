import { describe, expect, it } from 'vitest';
import polygonClipping from 'polygon-clipping';
import { createObject } from './factory';
import {
  addBarrier,
  barrierEnds,
  centroid,
  closeRing,
  distance,
  rotate,
  splitRoom,
  removeBarrier,
  rectangle,
  objectArea,
  barrierStrokeIssue,
  snapPoint,
  MIN_SEGMENT,
  ringArea,
} from './geometry';
import { dragGeometry, drawBarrier, encloseRoom } from './authoring';
import { axisDelta, axisOf, fitOpening, mainAxis, proposeWall } from './walls';
import { commitHistory, makeHistory, redoHistory, undoHistory } from './history';
import { pruneOntology } from './ontology';
import { divideSpaces } from './inference';
import { enclosedRegions, refitEnclosedRooms } from './spaces';
import { newProject } from './testFixtures';
import type { Point, ProjectDocument } from './types';
import { transact, validateProject, validateRings } from './validate';

// Replay a failure with GEOMETRY_FUZZ_SEED=<seed> npm run test:geometry.
// Increase GEOMETRY_FUZZ_CASES for a longer local/CI stress run; no unseeded randomness.
const firstSeed = Number(process.env.GEOMETRY_FUZZ_SEED ?? 1);
const cases = Number(process.env.GEOMETRY_FUZZ_CASES ?? (process.env.GEOMETRY_FUZZ_SEED ? 1 : 32));
if (!Number.isSafeInteger(firstSeed) || firstSeed < 0 || !Number.isSafeInteger(cases) || cases < 1)
  throw new Error('GEOMETRY_FUZZ_SEED must be a non-negative integer and GEOMETRY_FUZZ_CASES a positive integer.');
const seeds = [
  ...new Set([
    ...Array.from({ length: cases }, (_, i) => firstSeed + i),
    // Keep failures from longer stress runs in the ordinary suite too.
    ...(process.env.GEOMETRY_FUZZ_SEED ? [] : [53, 89, 151, 211, 526, 721, 802, 885]),
  ]),
];
function random(seed: number) {
  // Mix the seed so consecutive cases cover the whole circle, rather than nearby rotations.
  let state = Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b) >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function session(seed: number) {
  let project = newProject();
  let history = makeHistory(project);
  const trace: string[] = [];
  const step = (
    action: string,
    change: (draft: ProjectDocument) => void,
    expectedError?: string,
    mayCloseGap = false,
  ) => {
    trace.push(action);
    const before = JSON.stringify(project);
    let attempted: ProjectDocument | undefined;
    const result = transact(project, draft => {
      attempted = draft;
      change(draft);
    });
    expect(JSON.stringify(project), 'an edit must not mutate its input').toBe(before);
    if (expectedError) {
      expect(result).toEqual({ ok: false, error: expectedError });
      validateProject(project);
      return;
    }
    if (!result.ok) {
      // Thick walls may close a gap before their centrelines meet. One semantic space cannot
      // store disconnected footprints: refuse that precise constraint, then keep using tools.
      if (mayCloseGap && /^The wall would leave \d+ disconnected usable regions/.test(result.error)) {
        validateProject(project);
        return;
      }
      const invalid = attempted?.objects.filter(o => o.rings && validateRings(o.rings));
      throw new Error(
        `Seed ${seed}, step ${trace.length}: ${result.error}\n${trace.join('\n')}\nInvalid areas: ${JSON.stringify(invalid)}`,
      );
    }
    project = result.project;
    history = commitHistory(history, project);
    // Validate what persistence will actually load, too.
    validateProject(JSON.parse(JSON.stringify(project)));
  };
  const travel = (redo: boolean) => {
    trace.push(redo ? 'redo' : 'undo');
    history = redo ? redoHistory(history) : undoHistory(history);
    project = history.present;
    validateProject(JSON.parse(JSON.stringify(project)));
  };
  return {
    step,
    travel,
    get project() {
      return project;
    },
  };
}

describe('randomized building authoring', () => {
  it.each(seeds)('keeps small alcoves and conserves area when splitting them (seed %i)', seed => {
    const rng = random(seed);
    const s = session(seed);
    const angle = rng() * 360,
      nib = 0.03 + rng() * 0.46;
    const at = (x: number, y: number): Point => rotate([x, y], angle);
    const outline = [
      [0, 0],
      [6, 0],
      [6, 4],
      [3, 4],
      [3, 4 + nib],
      [2, 4 + nib],
      [2, 4],
      [0, 4],
    ].map(([x, y]) => at(x, y));
    for (let i = 0; i < outline.length; i++) {
      const a = outline[i],
        b = outline[(i + 1) % outline.length];
      s.step(`alcove wall ${JSON.stringify([a, b])}`, p => {
        const wall = drawBarrier(p, 'floor-ground', a, b);
        expect(wall, `seed ${seed}: retain the short return`).toBeDefined();
        wall!.thickness = 0.02;
        expect(barrierEnds(p, wall!)).toEqual([a, b]);
      });
    }
    expect(s.project.barriers).toHaveLength(8);
    s.step('enclose alcove', p => {
      expect(encloseRoom(p, 'floor-ground', at(3, 2))).not.toBeNull();
    });
    const room = s.project.objects[0];
    const area = objectArea(room);
    const x = 3 - nib / 2;
    s.step(`split next to alcove corner at x=${x}`, p => splitRoom(p, room.id, at(x, -1), at(x, 6), false));
    expect(s.project.objects).toHaveLength(2);
    expect(
      s.project.objects.reduce((sum, o) => sum + objectArea(o), 0),
      `seed ${seed}: no lost floor area`,
    ).toBeCloseTo(area, 7);
    const [one, two] = s.project.objects;
    const overlap = polygonClipping.intersection(one.rings!, two.rings!);
    expect(
      overlap.reduce((sum, pg) => sum + ringArea(pg[0]) - pg.slice(1).reduce((holes, r) => holes + ringArea(r), 0), 0),
      `seed ${seed}: the two rooms must not overlap`,
    ).toBeLessThan(1e-8);
  });

  it.each(seeds)(
    'joins centimetre-rounded input onto rotated walls without rounding the shared intersections (seed %i)',
    seed => {
      const rng = random(seed);
      const s = session(seed);
      const angle = rng() * 360;
      const cm = (p: Point): Point => p.map(n => Math.round(n * 100) / 100) as Point;
      const at = (x: number, y: number): Point => cm(rotate([x, y], angle));
      s.step('rounded facade', p => drawBarrier(p, 'floor-ground', at(0, 0), at(12, 0)));
      let x = 0.06;
      for (let i = 0; i < 8; i++) {
        x += 0.04 + rng() * 0.15;
        const raw = at(x, 0);
        // The pointer can be on a centimetre grid; the intersection belongs to the supporting
        // wall's exact line and is then shared by identity. Rounding that intersection again
        // would pull a T junction off an angled facade.
        const snapped = snapPoint(s.project, 'floor-ground', raw, 0.012, undefined, false);
        const end = at(x, i % 2 ? 2 : -2);
        s.step(`short staggered T ${JSON.stringify([snapped.point, end])}`, p => {
          const wall = drawBarrier(p, 'floor-ground', snapped.point, end);
          expect(wall).toBeDefined();
          expect(p.barriers.filter(b => b.startId === wall!.startId || b.endId === wall!.startId)).toHaveLength(3);
        });
      }
      expect(s.project.barriers).toHaveLength(17);
      const short = s.project.barriers.filter(b => distance(...barrierEnds(s.project, b)) < 0.5);
      expect(short).toHaveLength(8);
    },
  );

  it.each(seeds)('snaps 15 degree walls and four-way junctions to the floor axis (seed %i)', seed => {
    const rng = random(seed);
    const s = session(seed);
    const angle = rng() * 360;
    const at = (x: number, y: number): Point => rotate([x, y], angle);
    s.step('draw rotated floor outline', p => {
      const plate = createObject('zone', [0, 0], 'floor-ground');
      plate.rings = [rectangle([0, 0], 30, 20, angle)];
      p.objects.push(plate);
    });
    const axis = mainAxis(s.project, 'floor-ground');
    expect(Math.abs(axisDelta(axis, angle))).toBeLessThan(1e-8);
    s.step('draw main wall', p => drawBarrier(p, 'floor-ground', at(-10, 0), at(10, 0)));
    s.step('draw T branch', p => drawBarrier(p, 'floor-ground', at(0, 0), at(0, -6)));
    const common = s.project.junctions.find(j => distance(j.position, [0, 0]) < 1e-8)!;
    const fourth = snapPoint(
      s.project,
      'floor-ground',
      at(0.4 + rng() * 0.25, rng() * 0.05),
      0.5,
      at(0, 8),
      false,
      axis,
    );
    expect(fourth.label).toBe('Junction');
    s.step(`fourth branch ${JSON.stringify(fourth.point)}`, p =>
      drawBarrier(p, 'floor-ground', at(0, 8), fourth.point),
    );
    expect(s.project.barriers.filter(b => b.startId === common.id || b.endId === common.id)).toHaveLength(4);
    for (let i = 0; i < 8; i++) {
      const turn = Math.floor(rng() * 24) * 15;
      const start = at(40 + i * 20, 40);
      const delta = rotate([5 + rng() * 5, (rng() - 0.5) * 0.1], angle + turn);
      const raw: Point = [start[0] + delta[0], start[1] + delta[1]];
      const snap = snapPoint(s.project, 'floor-ground', raw, 0.3, start, false, axis);
      expect(Math.abs(axisDelta(axisOf(start, snap.point), angle + turn))).toBeLessThan(1e-8);
      s.step(`wall at ${turn} degrees to floor`, p => drawBarrier(p, 'floor-ground', start, snap.point));
    }
  });

  it.each(seeds)('can attach walls near existing corners (seed %i)', seed => {
    const rng = random(seed);
    const s = session(seed);
    const angle = rng() * 360;
    const at = (x: number, y: number): Point => rotate([x, y], angle);
    s.step('draw facade', p => addBarrier(p, at(0, 0), at(20, 0), 'floor-ground', 'wall'));
    for (let i = 0; i < 8; i++) {
      const x = i * 2 + 0.03 + rng() * 0.45;
      const a = at(x, 0),
        b = at(x, 3 + rng() * 5);
      s.step(`wall ${JSON.stringify([a, b])}`, p => addBarrier(p, a, b, 'floor-ground', 'wall'));
    }
  });

  it.each(seeds)('can enclose and divide a hand-drawn building (seed %i)', seed => {
    const rng = random(seed);
    const s = session(seed);
    const angle = rng() * 360,
      width = 12 + rng() * 20,
      depth = 12 + rng() * 20;
    const at = (x: number, y: number): Point => rotate([x, y], angle);
    const corners = [at(0, 0), at(width, 0), at(width, depth), at(0, depth)];
    for (let i = 0; i < corners.length; i++)
      s.step(`facade ${i}`, p => addBarrier(p, corners[i], corners[(i + 1) % 4], 'floor-ground', 'wall'));
    const x = width * (0.3 + rng() * 0.4);
    const a = at(x, 0),
      b = at(x, depth);
    s.step(`partition ${JSON.stringify([a, b])}`, p => {
      addBarrier(p, a, b, 'floor-ground', 'wall');
      divideSpaces(p, 'floor-ground', a, b);
    });
    const regions = enclosedRegions(s.project, 'floor-ground');
    expect(regions, `seed ${seed}: a closed building with a partition must have two rooms`).toHaveLength(2);
    for (const [i, ring] of regions.entries()) {
      expect(validateRings([ring]), `seed ${seed}: generated room ${i}`).toBeNull();
      s.step(`enclose ${i}`, p => {
        const room = createObject('room', centroid(ring), 'floor-ground');
        room.rings = [closeRing(ring)];
        p.objects.push(room);
      });
    }
    const roomId = s.project.objects[0].id;
    const y = depth * (0.3 + rng() * 0.4);
    s.step(`split at y=${y}`, p => splitRoom(p, roomId, at(-2, y), at(width + 2, y)));
    expect(s.project.objects).toHaveLength(3);
    for (const wall of s.project.barriers)
      expect(distance(...barrierEnds(s.project, wall))).toBeGreaterThanOrEqual(MIN_SEGMENT - 1e-6);
  });

  it.each(seeds)('keeps editing through a mixed tool sequence (seed %i)', seed => {
    const rng = random(seed * 0x9e3779b1);
    const s = session(seed);
    const angle = rng() * 360;
    const at = (x: number, y: number): Point => rotate([x, y], angle);
    const pick = <T>(items: T[]): T => items[Math.floor(rng() * items.length)];
    const corners = [at(-12, -10), at(12, -10), at(12, 10), at(-12, 10)];
    for (let i = 0; i < 4; i++)
      s.step(`facade ${i}`, p => drawBarrier(p, 'floor-ground', corners[i], corners[(i + 1) % 4]));
    s.step('enclose initial hall', p => {
      expect(encloseRoom(p, 'floor-ground', [0, 0])).not.toBeNull();
    });
    let performed = 0;
    for (let i = 0; i < 40; i++) {
      const tool = Math.floor(rng() * 8);
      if (tool === 0) {
        // Whole wall, with overshoot, at least a metre from a previous parallel run.
        const x = -9 + Math.floor(rng() * 7) * 3;
        const a = at(x, -11),
          b = at(x, 11);
        const issue = barrierStrokeIssue(s.project, a, b, 'floor-ground');
        s.step(
          `draw wall ${JSON.stringify([a, b])}`,
          p => drawBarrier(p, 'floor-ground', a, b),
          issue ?? undefined,
          true,
        );
      } else if (tool === 1) {
        const atPoint = at(-9 + rng() * 18, -7 + rng() * 14);
        const offer = proposeWall(s.project, 'floor-ground', atPoint);
        if (!offer) continue;
        // A proposal must be usable, rather than a preview that promises a refused edit.
        s.step(`partition ${JSON.stringify(offer.segment)}`, p => drawBarrier(p, 'floor-ground', ...offer.segment));
      } else if (tool === 2) {
        const region = pick(enclosedRegions(s.project, 'floor-ground'));
        if (!region) continue;
        const atPoint = centroid(region);
        s.step(`enclose ${JSON.stringify(atPoint)}`, p => {
          encloseRoom(p, 'floor-ground', atPoint);
        });
      } else if (tool === 3) {
        const wall = pick(s.project.barriers);
        if (!wall) continue;
        const [a, b] = barrierEnds(s.project, wall);
        const width = 0.6 + rng() * 0.6;
        const position: Point = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        const fit = fitOpening(s.project, wall.floorId, 'door', position, width, 2);
        if (!fit) continue;
        s.step(`door ${JSON.stringify({ position, width })}`, p => {
          const door = createObject('door', fit.position, wall.floorId);
          Object.assign(door, { width, barrierId: fit.barrierId, offset: fit.offset });
          p.objects.push(door);
        });
      } else if (tool === 4) {
        const wall = pick(s.project.barriers);
        if (!wall) continue;
        const [a, b] = barrierEnds(s.project, wall);
        const position: Point = [(a[0] + b[0]) / 2 + rng() * 2 - 1, (a[1] + b[1]) / 2 + rng() * 2 - 1];
        const next = dragGeometry(s.project, wall.floorId, { kind: 'barrier', id: wall.id, point: position });
        s.step(`slide wall ${s.project.barriers.indexOf(wall)} to ${JSON.stringify(position)}`, p =>
          Object.assign(p, next),
        );
      } else if (tool === 5) {
        const wall = pick(s.project.barriers);
        if (!wall) continue;
        s.step(`delete wall ${s.project.barriers.indexOf(wall)}`, p => {
          const before = enclosedRegions(p, 'floor-ground');
          removeBarrier(p, wall.id);
          refitEnclosedRooms(p, 'floor-ground', before);
          pruneOntology(p);
        });
      } else if (tool === 6) {
        s.travel(false);
        s.travel(true);
      } else {
        const atPoint = at(-8 + rng() * 16, -6 + rng() * 12);
        s.step(`rectangle ${JSON.stringify(atPoint)}`, p => {
          const zone = createObject('zone', atPoint, 'floor-ground');
          zone.rings = [rectangle(atPoint, 2 + rng() * 4, 2 + rng() * 4, angle)];
          p.objects.push(zone);
        });
      }
      performed++;
    }
    expect(performed, `seed ${seed}: exercise real gestures, not only unavailable tools`).toBeGreaterThan(20);
    expect(s.project.objects.some(o => o.rings && objectArea(o) > 1)).toBe(true);
  });
});
