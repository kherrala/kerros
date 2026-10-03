import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDemo } from './demo';
import { applyGeometryDrag, drawBarrier, encloseRoom, type GeometryDrag } from '../../src/model/authoring';
import { boundaryEdges, normalizeBoundaries } from '../../src/model/boundaries';
import { barrierEnds, distance, openRing, removeBarrier, splitRoom } from '../../src/model/geometry';
import { commitHistory, makeHistory, redoHistory, undoHistory } from '../../src/model/history';
import { pruneOntology } from '../../src/model/ontology';
import { transformObject } from '../../src/model/project';
import { isOpening, type Point, type ProjectDocument, type SiteObject } from '../../src/model/types';
import { freezeProject, transact, validateProject } from '../../src/model/validate';
import { fitOpening, snapDragPoint } from '../../src/model/walls';

// Long CPU-only sessions must let Vitest flush its worker messages between gestures.
const yieldToRunner = () => new Promise<void>(resolve => setImmediate(resolve));

// A full campus, not a floor extracted from it: openings, holes, shafts, ontology and navigation
// must survive together. No browser or paid AI provider is involved. See README for replay flags.
function setting(name: string, fallback: number, minimum: number) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`${name} must be an integer >= ${minimum}.`);
  return value;
}
const firstSeed = setting('STOCKMANN_FUZZ_SEED', 1, 0);
const cases = setting('STOCKMANN_FUZZ_CASES', process.env.STOCKMANN_FUZZ_SEED ? 1 : 2, 1);
const steps = setting('STOCKMANN_FUZZ_STEPS', 27, 9);
const seeds = Array.from({ length: cases }, (_, i) => firstSeed + i);
function random(seed: number) {
  let state = Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b) >>> 0;
  return () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 0x100000000;
}

// Only geometric refusals are expected for arbitrary gestures. Missing references, stale caches,
// broken boundary loops, clipping exceptions and programming errors must fail the fuzz run.
const geometricRefusal =
  /^(?:Invalid project: )?(?:A junction cannot split an opening\.|That crossing would leave a boundary segment too short\.|A wall or fence must be at least |The barrier is too short for its attached opening\.|Attached openings cannot overlap\.|Remove duplicate vertices\.|Area boundaries cannot cross themselves\.|A hole must be completely inside|Hole boundaries must not touch|Holes cannot overlap\.|A nested zone must remain inside|A space needs at least |Each split space needs at least |The wall would leave \d+ disconnected usable regions|That cut would leave disconnected pieces|The cut must cross the room|a stair or lift serves a level it does not stand on)/;

function session(initial: ProjectDocument, seed: number | string) {
  let history = makeHistory(initial);
  const trace: unknown[] = [];
  const accepted = new Map<string, number>();
  const refused = new Map<string, number>();
  function check(action: unknown, run: () => void) {
    trace.push(action);
    try {
      run();
    } catch (error) {
      throw new Error(
        `Stockmann seed ${seed}, step ${trace.length}: ${String(error)}\nReplay trace:\n${trace.map(x => JSON.stringify(x)).join('\n')}`,
      );
    }
  }
  return {
    get project() {
      return history.present;
    },
    accepted,
    refused,
    step(
      kind: string,
      target: unknown,
      floorId: string | null,
      change: (draft: ProjectDocument) => void,
      mustAccept = false,
    ) {
      check({ kind, target, floorId }, () => {
        const project = history.present;
        const before = JSON.stringify(project);
        const result = transact(project, change);
        expect(JSON.stringify(project), 'transaction mutated its input').toBe(before);
        if (!result.ok) {
          if (mustAccept || !geometricRefusal.test(result.error)) throw new Error(result.error);
          refused.set(result.error, (refused.get(result.error) ?? 0) + 1);
          expect(history.present).toBe(project);
          return;
        }
        // Coordinate edits must not disturb other floors, including their IDs and geometry.
        for (const key of ['junctions', 'barriers', 'objects', 'virtualBoundaries'] as const)
          expect(result.project[key]?.filter(o => o.floorId !== floorId)).toEqual(
            project[key]?.filter(o => o.floorId !== floorId),
          );
        validateProject(JSON.parse(JSON.stringify(result.project)));
        if (JSON.stringify(result.project) !== before) accepted.set(kind, (accepted.get(kind) ?? 0) + 1);
        history = commitHistory(history, result.project);
      });
    },
    travel() {
      check('undo / redo / reload', () => {
        const shape = (p: ProjectDocument) => JSON.stringify({ ...p, updatedAt: '' });
        const current = shape(history.present);
        history = undoHistory(history);
        validateProject(JSON.parse(JSON.stringify(history.present)));
        history = redoHistory(history);
        expect(shape(history.present)).toBe(current);
        history = { ...history, present: freezeProject(validateProject(JSON.parse(JSON.stringify(history.present)))) };
      });
    },
  };
}

describe('Stockmann editor mutation fuzzing', () => {
  let baseline: ProjectDocument;
  let nextId = 0;
  let fixtureIds = 0;
  let restoreIds: () => void;
  beforeAll(() => {
    // Stable UUIDs make the entire printed trace reproducible, including entities created by cuts.
    const spy = vi
      .spyOn(globalThis.crypto, 'randomUUID')
      .mockImplementation(() => `00000000-0000-4000-8000-${(nextId++).toString(16).padStart(12, '0')}`);
    restoreIds = () => spy.mockRestore();
    baseline = freezeProject(validateProject(createDemo()));
    fixtureIds = nextId;
    expect(baseline.floors.length).toBeGreaterThan(15);
    expect(baseline.objects.length).toBeGreaterThan(4000);
  }, 30_000);
  afterAll(() => restoreIds?.());

  it('allows a small wall and vertex drag on every drawn floor, without fixing unrelated geometry first', async () => {
    // An acceptance oracle: a fuzzer that permits every rejection would miss the original bug.
    for (const floorId of new Set(baseline.barriers.map(b => b.floorId))) {
      const wall = baseline.barriers
        .filter(b => b.floorId === floorId)
        .sort((a, b) => distance(...barrierEnds(baseline, b)) - distance(...barrierEnds(baseline, a)))[0];
      const [a, b] = barrierEnds(baseline, wall);
      const length = distance(a, b);
      const point: Point = [
        (a[0] + b[0]) / 2 - ((b[1] - a[1]) / length) * 0.02,
        (a[1] + b[1]) / 2 + ((b[0] - a[0]) / length) * 0.02,
      ];
      const s = session(baseline, floorId ?? 'site');
      s.step('wall', wall.id, floorId, d => applyGeometryDrag(d, { kind: 'barrier', id: wall.id, point }), true);
      s.step(
        'junction',
        wall.startId,
        floorId,
        d =>
          applyGeometryDrag(d, {
            kind: 'junction',
            id: wall.startId,
            point: [a[0] + 0.02, a[1] + 0.01],
          }),
        true,
      );
      s.travel();
      expect(s.accepted.get('wall')).toBe(1);
      expect(s.accepted.get('junction')).toBe(1);
      await yieldToRunner();
    }
  }, 120_000);

  it('ships office walls already joined, with no partition through a door or window', () => {
    for (const floorId of ['floor-07', 'floor-08', 'floor-09']) {
      const draft = structuredClone(baseline);
      normalizeBoundaries(draft, floorId);
      expect(draft).toEqual(baseline);
    }
  });

  it('rolls back an impossible wall shortening and accepts the next edit', () => {
    const wall = baseline.barriers.find(b => b.floorId === 'floor-ground' && b.name === 'Facade wall')!;
    const [a, b] = barrierEnds(baseline, wall);
    const length = distance(a, b);
    const before = JSON.stringify(baseline);
    const result = transact(baseline, d =>
      applyGeometryDrag(d, {
        kind: 'junction',
        id: wall.endId,
        point: [a[0] + ((b[0] - a[0]) / length) * 0.02, a[1] + ((b[1] - a[1]) / length) * 0.02],
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/junction cannot split an opening|too short for its attached opening/);
    expect(JSON.stringify(baseline)).toBe(before);
    const next = transact(baseline, d => {
      d.name = 'Stockmann after refused edit';
    });
    expect(next.ok).toBe(true);
    if (next.ok) validateProject(JSON.parse(JSON.stringify(next.project)));
  });

  it.each(seeds)(
    'keeps sequential gestures atomic, editable and reloadable (seed %i)',
    async seed => {
      nextId = fixtureIds;
      const rng = random(seed);
      const pick = <T>(values: T[]): T => values[Math.floor(rng() * values.length)];
      const s = session(baseline, seed);
      // Also exercise the shared-boundary model in this otherwise legacy outline-based sample.
      s.step(
        'enclose',
        [25, 10],
        'floor-ground',
        d => {
          expect(encloseRoom(d, 'floor-ground', [25, 10])).not.toBeNull();
        },
        true,
      );
      const room = s.project.objects.find(o => o.geometry?.mode === 'boundaries')!;
      if (room.geometry?.mode !== 'boundaries') throw new Error('Missing connected test space');
      const edgeId = room.geometry.loops[0][0].edgeId;
      const edge = boundaryEdges(s.project).find(e => e.id === edgeId)!;
      const [a, b] = barrierEnds(s.project, edge);
      const length = distance(a, b);
      const point: Point = [
        (a[0] + b[0]) / 2 - ((b[1] - a[1]) / length) * 0.02,
        (a[1] + b[1]) / 2 + ((b[0] - a[0]) / length) * 0.02,
      ];
      s.step(
        'connected wall',
        { id: edge.id, point },
        edge.floorId,
        d => {
          applyGeometryDrag(d, { kind: 'barrier', id: edge.id, point });
        },
        true,
      );
      expect(s.project.objects.find(o => o.id === room.id)!.rings).not.toEqual(room.rings);
      await yieldToRunner();
      for (let step = 0; step < steps; step++) {
        const p = s.project;
        const kind = ['barrier', 'junction', 'ring', 'opening', 'thickness', 'object', 'draw', 'delete', 'split'][
          step % 9
        ];
        const span = pick([0.05, 0.2, 0.5, 2]);
        const offset = (point: Point): Point => [point[0] + (rng() - 0.5) * span, point[1] + (rng() - 0.5) * span];
        if (kind === 'barrier' || kind === 'junction' || kind === 'ring') {
          const ringObjects = p.objects.filter(o => o.rings?.length && o.geometry?.mode !== 'boundaries');
          // Atrium holes are rare among 1,477 spaces; sample them deliberately as well as outlines.
          const holes = kind === 'ring' && Math.floor(step / 9) % 2 === 0;
          const o =
            kind === 'barrier'
              ? pick(boundaryEdges(p))
              : kind === 'junction'
                ? pick(p.junctions)
                : pick(holes ? ringObjects.filter(o => o.rings!.length > 1) : ringObjects);
          const rings = kind === 'ring' ? (o as SiteObject).rings! : [];
          const ringIndex = kind === 'ring' ? (holes ? 1 + Math.floor(rng() * (rings.length - 1)) : 0) : 0;
          const index = kind === 'ring' ? Math.floor(rng() * openRing(rings[ringIndex]).length) : 0;
          const at: Point =
            'startId' in o
              ? barrierEnds(p, o).reduce<Point>((a, b) => [a[0] + b[0] / 2, a[1] + b[1] / 2], [0, 0])
              : kind === 'ring'
                ? openRing(rings[ringIndex])[index]
                : o.position;
          const raw = offset(at);
          const snapping = rng() < 0.5;
          const point = snapDragPoint(p, o.floorId, kind, o.id, raw, snapping, 0.15, ringIndex, index);
          const move = { kind, id: o.id, point, ringIndex, index } as GeometryDrag;
          s.step(kind, { ...move, raw, snapping }, o.floorId, d => applyGeometryDrag(d, move));
        } else if (kind === 'opening') {
          const o = pick(p.objects.filter(o => o.barrierId && isOpening(o.kind)));
          const at = offset(o.position);
          // Same host-only search used by the editor when sliding an opening.
          const fit = fitOpening(
            { ...p, barriers: p.barriers.filter(b => b.id === o.barrierId) },
            o.floorId,
            o.kind as 'door',
            at,
            o.width,
            Infinity,
            o.id,
          );
          expect(fit).not.toBeNull();
          s.step(
            kind,
            { id: o.id, at, fit },
            o.floorId,
            d => {
              Object.assign(d.objects.find(x => x.id === o.id)!, { offset: fit!.offset, position: fit!.position });
            },
            true,
          );
        } else if (kind === 'thickness') {
          const b = pick(p.barriers);
          const thickness = pick([0.1, 0.18, 0.3, 0.45]);
          s.step(kind, { id: b.id, thickness }, b.floorId, d => {
            d.barriers.find(x => x.id === b.id)!.thickness = thickness;
          });
        } else if (kind === 'object') {
          const o = pick(p.objects.filter(o => o.kind === 'fixture'));
          const patch = { position: offset(o.position), rotation: Math.round(rng() * 24) * 15 };
          s.step(
            kind,
            { id: o.id, patch },
            o.floorId,
            d => transformObject(d.objects.find(x => x.id === o.id)!, patch),
            true,
          );
        } else if (kind === 'draw') {
          const b = pick(p.barriers);
          const [a, c] = barrierEnds(p, b);
          const mid: Point = [(a[0] + c[0]) / 2, (a[1] + c[1]) / 2];
          const point = offset(mid);
          s.step(kind, { mid, point }, b.floorId, d => {
            drawBarrier(d, b.floorId, mid, point);
          });
        } else if (kind === 'delete') {
          const b = pick(p.barriers);
          s.step(
            kind,
            b.id,
            b.floorId,
            d => {
              removeBarrier(d, b.id);
              pruneOntology(d);
            },
            true,
          );
        } else {
          const o = pick(p.objects.filter(o => o.kind === 'room' && o.rings?.length));
          const at = offset(o.position);
          const angle = rng() * Math.PI;
          const end: Point = [at[0] + Math.cos(angle), at[1] + Math.sin(angle)];
          s.step(kind, { id: o.id, at, end }, o.floorId, d => {
            splitRoom(d, o.id, at, end);
          });
        }
        if (step % 9 === 8) s.travel();
        await yieldToRunner();
      }
      // Random drags can legitimately snap back or hit constraints. The per-floor acceptance
      // test above guards against blanket refusal; these unconstrained edits must make progress.
      for (const kind of ['object', 'delete'])
        expect(
          s.accepted.get(kind) ?? 0,
          `${kind} made no progress; refusals: ${JSON.stringify([...s.refused])}`,
        ).toBeGreaterThan(0);
      s.step(
        'rename',
        baseline.id,
        null,
        d => {
          d.name = `${d.name} · fuzz ${seed}`;
        },
        true,
      );
      s.travel();
    },
    Math.max(120_000, steps * 5_000),
  );
});
