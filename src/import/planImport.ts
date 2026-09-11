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
  centroid,
  closeRing,
  createObject,
  distance,
  divideSpaces,
  enclosedRegions,
  refreshPortals,
  segmentProjection,
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
import { faceSegments, mergeRuns, symbolPoints, symbolVertices } from './runs';
import { addGap, along, closeCorners, pairWalls, snapEnds, type Wall } from './walls';

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
  // Vertices, not samples: a window is read from where its jambs are, and sampling fills the glass
  // between them. A door is read from the cloud its swing makes, and wants the samples.
  const windowPts = symbolVertices(regional, layers.windows);
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
  // Before the rooms, because a bridged doorway is what closes the region they are read from.
  bridgeDoorways(draft, floorId, doorPts, report);
  emitRooms(draft, floorId, partitions, passages, report);
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
  dropStubs(draft, report);
}

/** Adding a wall welds a junction wherever its end lands, which splits whatever already crossed
 *  there — so a wall ending close to another's end can leave behind a piece shorter than the plan is
 *  allowed to hold. The document is then refused, and the refusal names the rule rather than the
 *  drawing, which is no help at all to someone importing one. Drop the stubs instead, and the
 *  junctions they leave orphaned, and report how many. */
function dropStubs(draft: ProjectDocument, report: PlanImportReport) {
  const at = new Map(draft.junctions.map(j => [j.id, j.position]));
  const stubs = new Set(
    draft.barriers
      .filter(b => {
        const p = at.get(b.startId),
          q = at.get(b.endId);
        return p && q && Math.hypot(q[0] - p[0], q[1] - p[1]) < MIN_SEGMENT;
      })
      .map(b => b.id),
  );
  if (!stubs.size) return;
  draft.barriers = draft.barriers.filter(b => !stubs.has(b.id));
  draft.objects = draft.objects.filter(o => !o.barrierId || !stubs.has(o.barrierId));
  const used = new Set(draft.barriers.flatMap(b => [b.startId, b.endId]));
  draft.junctions = draft.junctions.filter(j => used.has(j.id));
  report.skipped.push(`${stubs.size} wall stub${stubs.size > 1 ? 's' : ''} under ${MIN_SEGMENT} m`);
}

/** One interior plate traced from the envelope, then divided along each partition — the same
 *  divideSpaces path a hand-drawn wall takes, so rooms come from battle-tested geometry. */
function emitRooms(
  draft: ProjectDocument,
  floorId: string | null,
  partitions: Wall[],
  passages: Map<Wall, [number, number][]>,
  report: PlanImportReport,
) {
  // Every region the walls enclose, in one read. The previous approach traced a single plate from
  // the envelope and then cut it once per partition, which asked far more of the drawing than it
  // could give: a partition had to span the whole plate to divide it, so a floor laid out around a
  // hall — partitions meeting each other rather than crossing the building — came back as one room.
  // A basement whose envelope did not quite close came back as none at all, plate and rooms both.
  //
  // The walls already say where the rooms are. Subtracting their bodies from the floor's extent
  // falls apart into exactly those rooms, whatever shape they are and whatever meets what.
  const regions = enclosedRegions(draft, floorId);
  if (!regions.length) {
    report.skipped.push('no enclosed regions: the walls do not close around anything');
    return;
  }
  for (const ring of regions) {
    const room = createObject('room', centroid(ring as Point[]), floorId, 'Room');
    room.rings = [closeRing(ring)];
    const xs = ring.map((p: Point) => p[0]),
      ys = ring.map((p: Point) => p[1]);
    room.width = Math.max(...xs) - Math.min(...xs);
    room.depth = Math.max(...ys) - Math.min(...ys);
    draft.objects.push(room);
  }
  // A doorless passage is a gap in a partition, so the regions either side of it are one region —
  // the walls really do leave them open to each other. The drawing still says they are two places
  // with a way through, which is what an open boundary means, so cut along those partitions and let
  // portal inference call the result open.
  for (const w of partitions) {
    if (!(passages.get(w) ?? []).length) continue;
    divideSpaces(draft, floorId, along(w, w.lo - 0.25), along(w, w.hi + 0.25));
  }
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

/** Close an oblique doorway the Manhattan pass could not see.
 *
 *  The reconstruction reads axis-aligned faces, which is what a Finnish prefab drawing is made of —
 *  except where it is not. A room cut off at 45° leaves two wall ends dangling a metre or so apart
 *  with nothing between them but the door symbol drawn across the gap, and every axis-aligned pass
 *  drops all three: the faces because they are oblique, the wall because it has no faces, the door
 *  because it has no wall. The region then leaks and two rooms import as one.
 *
 *  What the drawing is actually saying there is legible without reading oblique geometry at all: two
 *  loose wall ends, a plausible door's distance apart, with door symbols standing on the line between
 *  them. That is a doorway, and this bridges it — a barrier on that line carrying the door.
 *
 *  Deliberately conservative. It fires only between ends that nothing else has claimed, only when the
 *  span is a door's width, and only when the drawing put a door symbol there: it can close a gap the
 *  drawing shows a door in, and it cannot invent a wall anywhere else. */
export function bridgeDoorways(
  draft: ProjectDocument,
  floorId: string | null,
  doorPts: Point[],
  report: PlanImportReport,
) {
  const mine = draft.barriers.filter(b => b.floorId === floorId);
  // A loose end is a junction exactly one wall reaches: a wall that simply stops is the drawing
  // admitting something is missing there.
  const uses = new Map<string, number>();
  for (const b of mine) for (const id of [b.startId, b.endId]) uses.set(id, (uses.get(id) ?? 0) + 1);
  const at = (id: string) => draft.junctions.find(j => j.id === id)!.position;
  const loose = [...uses].filter(([, n]) => n === 1).map(([id]) => id);
  const before = enclosedRegions(draft, floorId).length;

  type Candidate = { from: string; to: string; span: number; score: number };
  const candidates: Candidate[] = [];
  for (const from of loose)
    for (const to of uses.keys()) {
      if (from === to) continue;
      const a = at(from),
        b = at(to);
      const span = distance(a, b);
      // A door's worth of gap: a generous double door is 1.6 m, a single leaf 0.9. Shorter than
      // 0.6 is a butt joint the snapping missed; wider than 1.8 is not a doorway, it is a room.
      if (span < 0.6 || span > 1.8) continue;
      // Axis-aligned gaps are the Manhattan pass's own business — a wall it broke, a passage it
      // meant to leave. This is only for what it could not represent at all.
      const angle = Math.abs(((((Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI) % 90) + 90) % 90);
      if (angle < 8 || angle > 82) continue;
      // Nothing already runs along this line: a wall the Manhattan pass DID find is not a gap.
      if (
        mine.some(w => {
          const [wa, wb] = barrierEnds(draft, w);
          return segmentProjection(a, wa, wb).distance < 0.15 && segmentProjection(b, wa, wb).distance < 0.15;
        })
      )
        continue;
      // Door symbols standing ON the line and reaching BOTH ends of it. A swing sweeping past is
      // not a door in the gap, and a symbol crowding one jamb is the door in the wall next to it.
      const ts = doorPts.filter(q => segmentProjection(q, a, b).distance < 0.4).map(q => segmentProjection(q, a, b).t);
      if (ts.length < 6) continue;
      if (!ts.some(t => t < 0.2) || !ts.some(t => t > 0.8)) continue;
      candidates.push({ from, to, span, score: ts.length / span });
    }

  // Strongest claim first. A junction takes part in one bridge and no more: a gap is one doorway,
  // and without this the same gap is bridged twice — once from each end — and a corner sprouts a
  // second doorway running off at another angle.
  const claimed = new Set<string>();
  let regions = before;
  // Shortest first. Where two lines from one loose end both carry door symbols and both close a
  // room, the doorway is the narrower: a door is the smallest gap that separates two places, and
  // the longer line is the same doorway plus a diagonal across the room behind it.
  for (const c of candidates.sort((x, y) => x.span - y.span || y.score - x.score)) {
    if (claimed.has(c.from) || claimed.has(c.to) || (uses.get(c.from) ?? 0) !== 1) continue;
    const a = at(c.from),
      b = at(c.to);
    const neighbours = mine.filter(w => [c.from, c.to].includes(w.startId) || [c.from, c.to].includes(w.endId));
    const thickness = Math.max(0.05, Math.min(...neighbours.map(w => w.thickness), 0.2));
    // The test that matters: does this actually close a room? A doorway is worth drawing where it
    // separates two places and nowhere else, and a line that leaves the plan exactly as open as it
    // was is a coincidence among the door symbols, not a wall. Probed on a copy, so a candidate that
    // fails leaves nothing behind.
    const probe: ProjectDocument = {
      ...draft,
      junctions: [...draft.junctions, { id: 'probe-a', position: a, floorId }, { id: 'probe-b', position: b, floorId }],
      barriers: [
        ...draft.barriers,
        { ...mine[0], id: 'probe', startId: 'probe-a', endId: 'probe-b', floorId, thickness },
      ],
    };
    const after = enclosedRegions(probe, floorId).length;
    // Re-measured each time, not against the count this pass started with: a second bridge judged
    // against a stale number is judged against a plan that no longer exists.
    if (after <= regions) continue;
    regions = after;
    claimed.add(c.from);
    claimed.add(c.to);
    uses.set(c.from, 2);
    addBarrier(draft, a, b, floorId, 'wall');
    const wall = draft.barriers.at(-1)!;
    wall.thickness = thickness;
    wall.name = 'Partition';
    const storey = draft.floors.find(f => f.id === floorId)?.height;
    if (storey) wall.height = storey;
    report.walls++;
    // The doorway fills the span but for a jamb at each end — a door flush to a wall end is one the
    // document will not hold.
    const clear = distance(a, b) - 2 * (thickness + 0.02);
    if (clear < OPENING_MIN_SEGMENT / 2) {
      report.skipped.push(`bridged doorway too narrow to hold a door at ${a.map(v => v.toFixed(1))}`);
      continue;
    }
    const door = createObject('door', [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], floorId, 'Door');
    door.width = Math.round(clear * 100) / 100;
    door.barrierId = wall.id;
    door.offset = Math.round((distance(a, b) / 2) * 1000) / 1000;
    draft.objects.push(door);
    report.doors++;
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
