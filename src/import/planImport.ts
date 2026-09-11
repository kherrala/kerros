// Deterministic import of measured CAD plan entities into a Kerros floor — the orchestrator.
//
// The input is the normalized, metre-unit entity JSON produced host-side from a DWG (see
// scripts/plan-import/extract.mjs — `PlanEntity` in types.ts is the contract for its output). The
// drawings this understands are the axis-aligned kind produced by Finnish prefab CAD: walls drawn
// as parallel face-line pairs on semantic layers, openings as gaps in those faces, room labels as
// text. runs.ts merges face fragments into runs; walls.ts pairs runs into walls and traces the
// envelope ring; this file turns walls into a document.
//
// The method leans on machinery the editor already trusts rather than new geometry: walls become
// barriers; ONE interior plate is traced from the envelope's inner face; each partition then
// divides the plate with the same divideSpaces/splitRoom path a hand-drawn wall takes; labels name
// whatever room they stand in via spaceAt. Runs inside a transact like every other authoring
// operation, so a drawing this cannot digest refuses cleanly instead of importing garbage.
import {
  MIN_SEGMENT,
  OPENING_MIN_SEGMENT,
  addBarrier,
  barrierEnds,
  closeRing,
  createObject,
  divideSpaces,
  refreshPortals,
  spaceAt,
} from '../schema';
import type { Point, ProjectDocument } from '../schema';
import { VERTEX_LAYERS, type PlanEntity, type PlanImportOptions, type PlanImportReport } from './types';
import {
  barrierSpans,
  openingLabel,
  resolveEnvelopeOpenings,
  resolvePartitionGap,
  type ResolvedOpening,
} from './openings';
import { faceSegments, mergeRuns, symbolPoints } from './runs';
import { addGap, along, closeCorners, pairWalls, snapEnds, traceRing, type Wall } from './walls';

/** Import a floor's worth of plan entities into `draft`. Call inside a transaction. */
export function importPlanEntities(
  draft: ProjectDocument,
  entities: PlanEntity[],
  options: PlanImportOptions,
): PlanImportReport {
  const layers = options.layers ?? VERTEX_LAYERS;
  const { floorId } = options;
  const report: PlanImportReport = { walls: 0, rooms: 0, doors: 0, windows: 0, passages: 0, named: 0, skipped: [] };

  const regional = planRegion(entities, layers.interiorFace);
  const { envelope, partitions } = reconstructWalls(regional, layers, report);
  const doorPts = symbolPoints(regional, layers.doors);
  const windowPts = symbolPoints(regional, layers.windows);
  // Envelope openings come from symbol clusters; partition openings from the paired face gaps.
  const openings = new Map<Wall, ResolvedOpening[]>(
    envelope.map(w => [w, resolveEnvelopeOpenings(w, doorPts, windowPts)]),
  );
  const passages = new Map<Wall, [number, number][]>();
  for (const w of partitions) {
    const resolved = w.gaps.map(gap => resolvePartitionGap(w, gap, doorPts, windowPts));
    openings.set(
      w,
      resolved.flatMap(r => r.openings),
    );
    passages.set(
      w,
      resolved.flatMap(r => (r.passage ? [r.passage] : [])),
    );
  }
  emitBarriers(draft, floorId, envelope, partitions, passages, report);
  emitRooms(draft, floorId, envelope, partitions, report);
  emitOpenings(draft, floorId, envelope, partitions, openings, report);
  nameRooms(draft, floorId, regional, layers, report);
  refreshPortals(draft);
  return report;
}

/** The plan region is where the envelope's inner face lives; auxiliary views elsewhere in the
 *  drawing (sections, detail callouts) are outside it and ignored. */
function planRegion(entities: PlanEntity[], interiorFace: RegExp): PlanEntity[] {
  const inner = faceSegments(entities, interiorFace);
  if (!inner.length) throw new Error('Plan import: no interior wall faces found on the expected layer.');
  const rx = [
    Math.min(...inner.map(s => (s.axis === 'h' ? s.lo : s.c))) - 1,
    Math.max(...inner.map(s => (s.axis === 'h' ? s.hi : s.c))) + 1,
  ];
  const ry = [
    Math.min(...inner.map(s => (s.axis === 'v' ? s.lo : s.c))) - 1,
    Math.max(...inner.map(s => (s.axis === 'v' ? s.hi : s.c))) + 1,
  ];
  const inRegion = (p?: Point) => !!p && p[0] >= rx[0] && p[0] <= rx[1] && p[1] >= ry[0] && p[1] <= ry[1];
  return entities.filter(e => [e.a, e.b, e.at, e.center, e.points?.[0]].some(inRegion));
}

/** Envelope and partition walls from the face layers. Prefab drawings put BOTH faces of the outer
 *  wall on the envelope layers (the silhouette continuous, the inner face broken at openings), so
 *  the wall pairs are found by self-pairing the pooled runs; opening gaps are then harvested from
 *  each face layer merged on its own, because an opening does not break every line of the wall. */
function reconstructWalls(
  regional: PlanEntity[],
  layers: NonNullable<PlanImportOptions['layers']>,
  report: PlanImportReport,
): { envelope: Wall[]; partitions: Wall[] } {
  const envelopePool = [...faceSegments(regional, layers.exteriorFace), ...faceSegments(regional, layers.interiorFace)];
  const envelopeRuns = mergeRuns(envelopePool, 4.6, [0.6, 4.6]).filter(r => r.hi - r.lo > 0.8);
  const envelope = pairWalls(envelopeRuns, envelopeRuns, 0.2, 0.65, 0.8, 'either');
  closeCorners(envelope);
  const faceGapRuns = [
    ...mergeRuns(faceSegments(regional, layers.exteriorFace), 4.6, [0.6, 4.6]),
    ...mergeRuns(faceSegments(regional, layers.interiorFace), 4.6, [0.6, 4.6]),
  ];
  for (const w of envelope)
    for (const run of faceGapRuns) {
      if (run.axis !== w.axis || Math.abs(run.c - w.c) > w.thickness / 2 + 0.05) continue;
      for (const gap of run.gaps) addGap(w, gap);
    }

  // Doorless passages between rooms run wider than doorways — record breaks up to 2.6 m.
  const partitionRuns = mergeRuns(faceSegments(regional, layers.partitionFaces), 2.6, [0.6, 2.6]);
  const partitions = pairWalls(partitionRuns, partitionRuns, 0.05, 0.35, 0.4, 'both', 'overlap').filter(w => {
    if (w.hi - w.lo >= MIN_SEGMENT) return true;
    report.skipped.push(`partition stub ${(w.hi - w.lo).toFixed(2)} m at ${along(w, w.lo).map(v => v.toFixed(1))}`);
    return false;
  });
  snapEnds(partitions, [...envelope, ...partitions]);
  return { envelope, partitions };
}

/** Walls become barriers with their measured thickness. A doorless passage splits its wall into
 *  separate barrier pieces — the opening is the absence of wall, and sealing it with a continuous
 *  barrier would wall off two rooms the drawing says flow into each other. */
function emitBarriers(
  draft: ProjectDocument,
  floorId: string | null,
  envelope: Wall[],
  partitions: Wall[],
  passages: Map<Wall, [number, number][]>,
  report: PlanImportReport,
) {
  for (const w of [...envelope, ...partitions]) {
    for (const [lo, hi] of barrierSpans(w, passages.get(w) ?? [])) {
      if (hi - lo < MIN_SEGMENT) {
        report.skipped.push(`wall piece under ${MIN_SEGMENT} m at ${along(w, lo).map(v => v.toFixed(1))}`);
        continue;
      }
      addBarrier(draft, along(w, lo), along(w, hi), floorId, 'wall');
      const barrier = draft.barriers.at(-1)!;
      barrier.thickness = Math.max(0.05, w.thickness);
      barrier.name = envelope.includes(w) ? 'Exterior wall' : 'Partition';
      // A plan is flat: the drawing says nothing about how tall its walls are, so take the storey
      // the plan is being imported onto. Leaving addBarrier's generic default would stand 3.5 m
      // walls on a 2.6 m floor — they punch through the storey above, and on a basement they rise
      // out of the ground.
      const storey = draft.floors.find(f => f.id === floorId)?.height;
      if (storey) barrier.height = storey;
      report.walls++;
    }
    report.passages += (passages.get(w) ?? []).length;
  }
}

/** One interior plate traced from the envelope, then divided along each partition — the same
 *  divideSpaces path a hand-drawn wall takes, so rooms come from battle-tested geometry. */
function emitRooms(
  draft: ProjectDocument,
  floorId: string | null,
  envelope: Wall[],
  partitions: Wall[],
  report: PlanImportReport,
) {
  const ring = traceRing(envelope);
  if (!ring) {
    report.skipped.push('interior plate: envelope inner faces did not close into a ring — no rooms created');
    return;
  }
  const cx = ring.reduce((s, p) => s + p[0], 0) / ring.length;
  const cy = ring.reduce((s, p) => s + p[1], 0) / ring.length;
  const plate = createObject('room', [cx, cy], floorId, 'Room');
  plate.rings = [closeRing(ring)];
  const xs = ring.map(p => p[0]),
    ys = ring.map(p => p[1]);
  plate.width = Math.max(...xs) - Math.min(...xs);
  plate.depth = Math.max(...ys) - Math.min(...ys);
  draft.objects.push(plate);
  // Longest partitions cut first; the divider extends past the room edges so the both-ends-outside
  // rule holds. A cut the geometry refuses skips that divider, not the import.
  for (const w of [...partitions].sort((x, y) => y.hi - y.lo - (x.hi - x.lo)))
    divideSpaces(draft, floorId, along(w, w.lo - 0.25), along(w, w.hi + 0.25));
  report.rooms = draft.objects.filter(o => o.kind === 'room' && o.floorId === floorId).length;
}

/** Resolved openings become wall-bound door/window objects on whichever barrier piece holds them.
 *  Doors sit where their symbols stand — not at the centre of the face break, which often spans a
 *  doorway AND the window beside it. The piece is looked up in the DOCUMENT, not remembered from
 *  emit: junction welds split barriers as later walls arrive, so only the document knows the
 *  pieces that actually exist. Unresolvable envelope gaps are reported, never guessed. */
function emitOpenings(
  draft: ProjectDocument,
  floorId: string | null,
  envelope: Wall[],
  partitions: Wall[],
  openings: Map<Wall, ResolvedOpening[]>,
  report: PlanImportReport,
) {
  for (const w of [...envelope, ...partitions]) {
    for (const o of openings.get(w) ?? []) {
      const p = along(w, o.centre);
      const label = openingLabel(w, o);
      // The barrier piece under the opening: same floor, same axis, on the wall's line, containing
      // the opening's centre.
      let hit: { id: string; offset: number; length: number } | null = null;
      for (const b of draft.barriers) {
        if (b.floorId !== floorId) continue;
        const [a, z] = barrierEnds(draft, b);
        const axis = Math.abs(a[1] - z[1]) < 0.01 ? 'h' : Math.abs(a[0] - z[0]) < 0.01 ? 'v' : null;
        if (axis !== w.axis) continue;
        const [i, j] = axis === 'h' ? [0, 1] : [1, 0];
        if (Math.abs(a[j] - p[j]) > 0.05) continue;
        if (p[i] < Math.min(a[i], z[i]) || p[i] > Math.max(a[i], z[i])) continue;
        hit = { id: b.id, offset: Math.abs(p[i] - a[i]), length: Math.abs(z[i] - a[i]) };
        break;
      }
      if (!hit || hit.length < OPENING_MIN_SEGMENT) {
        report.skipped.push(`${o.kind} has no wall piece to sit in at ${label}`);
        continue;
      }
      if (hit.offset - o.width / 2 < 0.01 || hit.offset + o.width / 2 > hit.length - 0.01) {
        report.skipped.push(`${o.kind} does not fit its wall at ${label}`);
        continue;
      }
      const clash = draft.objects.some(
        x => x.barrierId === hit!.id && Math.abs((x.offset ?? 0) - hit!.offset) < (x.width + o.width) / 2 + 0.05,
      );
      if (clash) {
        report.skipped.push(`${o.kind} overlapping another opening at ${label}`);
        continue;
      }
      const opening = createObject(o.kind, p, floorId, o.kind === 'door' ? 'Door' : 'Window');
      opening.width = Math.round(o.width * 100) / 100;
      opening.barrierId = hit.id;
      opening.offset = Math.round(hit.offset * 1000) / 1000;
      opening.rotation = w.axis === 'h' ? 0 : 90;
      draft.objects.push(opening);
      if (o.kind === 'door') report.doors++;
      else report.windows++;
    }
  }
}

/** Each label christens the room it stands in. Pure numbers are the area figures — ignored. */
function nameRooms(
  draft: ProjectDocument,
  floorId: string | null,
  regional: PlanEntity[],
  layers: NonNullable<PlanImportOptions['layers']>,
  report: PlanImportReport,
) {
  for (const e of regional) {
    if (e.type !== 'TEXT' || !layers.labels.test(e.layer) || !e.at || !e.text) continue;
    if (/^[\d.,\s]+$/.test(e.text)) continue;
    const room = spaceAt(draft, floorId, e.at);
    if (!room || room.floorId !== floorId) {
      report.skipped.push(`label "${e.text}" stands in no room`);
      continue;
    }
    room.name = e.text.trim();
    report.named++;
  }
}

export { VERTEX_LAYERS } from './types';
export type { PlanEntity, PlanImportOptions, PlanImportReport, PlanLayerMap } from './types';
