// Reading the plan: what the geometry already says about connection and separation. Portals are
// inferred from doors and from open boundaries, and a wall drawn or removed changes which spaces
// exist at all. Nothing here decides anything — decisions (zones, hand-set passage) live in
// ontology.ts; this module only reports what is drawn, which is why it may be re-run at any time.
import polygonClipping from 'polygon-clipping';
import { mergeBoundaryGeometry } from './boundaries';
import {
  barrierEnds,
  closeRing,
  distance,
  footprint,
  objectArea,
  objectPosition,
  openRing,
  segmentProjection,
  splitRoom,
} from './geometry';
import { isSpace, type Point, type Portal, type ProjectDocument, type SiteObject } from './types';
import { inSpace, spaceAt } from './spaces';
import { isVertical, servedFloors, shaftKey } from './vertical';
import { pruneOntology } from './ontology';
import { sharedBoundaryPortals } from './portals';
import { TRAVERSABLE } from './passages';
export { TRAVERSABLE } from './passages';

/** How far past a wall face to look for the room on that side — enough to clear the leaf and any
 *  threshold, small enough to stay in the room rather than reaching into the next one. */
const PROBE = 0.35;
/** Infer the portals a plan already describes: for each opening, the space on either side of the wall
 *  it sits in. This is the move software without a plan cannot make — it has to be told which
 *  doors bound an area, because none of them has a floor plan to ask.
 *
 *  Openings whose sides cannot be resolved are skipped rather than guessed at: an unbounded or
 *  open-plan side is a real modelling gap, and inventing a portal there would hide it. */
export function inferPortals(project: ProjectDocument): Portal[] {
  const barriers = new Map(project.barriers.map(b => [b.id, b]));
  const out: Portal[] = [];
  for (const opening of project.objects) {
    if (!TRAVERSABLE.has(opening.kind)) continue;
    const at = objectPosition(project, opening);
    // The direction to probe: across the wall it is set into, or across its own facing if it is free.
    let nx: number,
      ny: number,
      clearance = PROBE;
    const barrier = opening.barrierId ? barriers.get(opening.barrierId) : undefined;
    if (barrier) {
      const [a, b] = barrierEnds(project, barrier);
      const len = distance(a, b) || 1;
      nx = (b[1] - a[1]) / len;
      ny = -(b[0] - a[0]) / len;
      clearance += barrier.thickness / 2;
    } else {
      const rad = ((opening.rotation ?? 0) * Math.PI) / 180;
      nx = -Math.sin(rad);
      ny = Math.cos(rad);
      clearance += opening.depth / 2;
    }
    // Look on the opening's own floor first, then outdoors. A front door has a room on one side and
    // the street on the other, and the street is not a floor — it is floorId null. Probing only the
    // door's own level makes every entrance in the building unresolvable, which quietly severs the
    // inside from the outside and leaves no route to a muster point.
    const side = (sign: number): SiteObject | null => {
      const probe: Point = [at[0] + nx * clearance * sign, at[1] + ny * clearance * sign];
      return (
        spaceAt(project, opening.floorId, probe) ?? (opening.floorId === null ? null : spaceAt(project, null, probe))
      );
    };
    const a = side(1),
      b = side(-1);
    if (!a || !b || a.id === b.id) continue;
    out.push({ id: `inferred:${opening.id}`, openingId: opening.id, a: a.id, b: b.id, attests: 'assumed' });
  }
  return out;
}

/** Sampling step along a space's outline, and how far past it to look for a neighbour. */
const WALK = 1,
  REACH = 0.45;
/** A shared run shorter than this is two rooms brushing at a corner, not a way through. */
const MIN_OPENING = 1.2;

/** Infer the portals that have no door in them: two spaces that share a boundary with nothing built
 *  across it. Open-plan floors are made of these — a department opening onto a gallery, a lift car
 *  onto its lobby — and a model that only knows about door objects cannot see any of them.
 *
 * Shared virtual edges give exact connectivity. For independent outlines, walk the outline and
 * accumulate stretches that can step across into a neighbour without crossing a wall. */
export function inferOpenBoundaries(project: ProjectDocument): Portal[] {
  const byFloor = new Map<string, SiteObject[]>();
  const standOn = (space: SiteObject, key: string) => {
    const list = byFloor.get(key);
    if (list) list.push(space);
    else byFloor.set(key, [space]);
  };
  // Which floors already have a landing of each shaft drawn on them. A plan drawn sheet by sheet
  // gives one landing per storey and every one of them meets its own lobby without help.
  const landed = new Map<string, Set<string>>();
  for (const o of project.objects) {
    if (!isVertical(o.kind) || !o.floorId) continue;
    const key = shaftKey(o);
    const floors = landed.get(key);
    if (floors) floors.add(o.floorId);
    else landed.set(key, new Set([o.floorId]));
  }
  for (const space of project.objects) {
    if (!isSpace(space.kind)) continue;
    standOn(space, space.floorId ?? '');
    // A shaft is a column, and it stands on every floor it serves. A plan that draws the core once
    // and lists the floors it serves makes the same claim as a hundred landings do, in one object —
    // and walking only the floor that object happens to be filed under found a ten-storey lift
    // exactly one way in, which reads as a cupboard in the basement rather than as a lift.
    //
    // Only where nothing of this shaft already stands, though. servedFloors unions what every twin
    // declares, so a tower drawn landing by landing has each of its hundred landings claiming all
    // hundred floors: lifting them all onto all of them is the same wall walked ten thousand times
    // for the hundred placements that meant anything, and it took the Silo's inference from under a
    // second to eight.
    if (!isVertical(space.kind)) continue;
    const here = landed.get(shaftKey(space));
    for (const floor of servedFloors(project, space))
      if (floor.id !== space.floorId && !here?.has(floor.id)) standOn(space, floor.id);
  }
  const wallsByFloor = new Map<string, [Point, Point][]>();
  for (const barrier of project.barriers) {
    const key = barrier.floorId ?? '';
    const list = wallsByFloor.get(key);
    const ends = barrierEnds(project, barrier);
    if (list) list.push(ends);
    else wallsByFloor.set(key, [ends]);
  }
  const shared = new Map<string, number>();
  for (const [floorKey, onFloor] of byFloor) {
    const walls = wallsByFloor.get(floorKey) ?? [];
    // Smallest-first, so a probe landing in a nested room reports the room and not the plate.
    const ordered = [...onFloor].sort((a, b) => objectArea(a) - objectArea(b));
    for (const space of onFloor) {
      // Every ring, holes included. A courtyard's edge is as much a boundary as the outer wall, and
      // a pavilion standing in that courtyard connects to nothing if only the outline is walked.
      // Probing back into the space itself is skipped below, so a hole over open void costs nothing.
      for (const ringRaw of footprint(space)) {
        if (!ringRaw?.length) continue;
        const ring = openRing(ringRaw);
        for (let i = 0; i < ring.length; i++) {
          const a = ring[i],
            b = ring[(i + 1) % ring.length];
          const len = distance(a, b);
          if (len < 0.05) continue;
          const ux = (b[0] - a[0]) / len,
            uy = (b[1] - a[1]) / len,
            nx = uy,
            ny = -ux; // outward-ish normal; both signs are tried below
          const steps = Math.max(1, Math.round(len / WALK));
          for (let s = 0; s < steps; s++) {
            const t = ((s + 0.5) / steps) * len;
            const px = a[0] + ux * t,
              py = a[1] + uy * t;
            // Built across this stretch? Then whatever is beyond it is behind a wall.
            if (walls.some(([wa, wb]) => segmentProjection([px, py], wa, wb).distance < REACH)) continue;
            for (const sign of [1, -1]) {
              const probe: Point = [px + nx * REACH * sign, py + ny * REACH * sign];
              if (inSpace(space, probe)) continue; // still inside ourselves
              const other = ordered.find(o => o.id !== space.id && inSpace(o, probe));
              if (!other) continue;
              // Shared geometry already says whether these two faces have an open edge. A coarse
              // probe must neither miss a narrow opening nor invent a shortcut at a wall junction.
              if (space.geometry?.mode === 'boundaries' && other.geometry?.mode === 'boundaries') continue;
              const key = space.id < other.id ? `${space.id}|${other.id}` : `${other.id}|${space.id}`;
              shared.set(key, (shared.get(key) ?? 0) + len / steps);
            }
          }
        }
      }
    }
  }
  const out = sharedBoundaryPortals(project);
  for (const [key, run] of shared) {
    if (run < MIN_OPENING) continue;
    const [a, b] = key.split('|');
    out.push({ id: `open:${a}:${b}`, a, b, attests: 'none' });
  }
  return out;
}

/** An inferred portal's id is deterministic — the opening or the pair of spaces it joins — so a
 *  re-inference can recognise the portal it replaces and carry a person's edits across. */
const INFERRED = (id: string) => id.startsWith('inferred:') || id.startsWith('open:');

/** Re-read the portals from the plan, keeping what a person has decided.
 *
 *  Hand-authored portals (any id inference would not mint) survive wholesale. On re-inferred ones the
 *  geometry is the plan's to change — which spaces, through which opening — but the semantic fields a
 *  person may have set (`passage`, `attests`, `name`, `metadata`) are carried onto the replacement:
 *  sealing a doorway or marking it monitored must survive the plan being redrawn around it. A portal
 *  the plan no longer describes goes, and its edits go with it — they were about a way through that
 *  no longer exists. */
export function refreshPortals(project: ProjectDocument): number {
  const previous = project.portals ?? [];
  const authored = previous.filter(p => !INFERRED(p.id));
  const held = new Set(authored.flatMap(p => (p.openingId ? [p.openingId] : [])));
  const heldPairs = new Set(authored.map(p => JSON.stringify([p.a, p.b].sort())));
  const edited = new Map(previous.filter(p => INFERRED(p.id)).map(p => [p.id, p]));
  const fresh = [...inferPortals(project), ...inferOpenBoundaries(project)]
    .filter(p => !p.openingId || !held.has(p.openingId))
    .filter(p => !p.id.startsWith('open:') || !heldPairs.has(JSON.stringify([p.a, p.b].sort())))
    .map(p => {
      const old = edited.get(p.id);
      if (!old) return p;
      if (old.passage !== undefined) p.passage = old.passage;
      if (old.attests !== undefined) p.attests = old.attests;
      if (old.name !== undefined) p.name = old.name;
      if (old.metadata !== undefined) p.metadata = old.metadata;
      return p;
    });
  project.portals = [...authored, ...fresh];
  return fresh.length;
}

/** Spaces the segment a→b cuts clean across: it enters and leaves, so the space really is in two
 *  pieces. Touching a corner or stopping halfway inside does not divide anything. */
export function spacesDividedBy(project: ProjectDocument, floorId: string | null, a: Point, b: Point): SiteObject[] {
  const out: SiteObject[] = [];
  for (const space of project.objects) {
    if (space.floorId !== floorId || !isSpace(space.kind)) continue;
    if (space.geometry?.mode === 'boundaries') continue; // the shared graph handles the subdivision
    // A containing area names the whole floor/department. Split its rooms, keeping their
    // parent intact; cutting the parent first strands children outside their parent polygon.
    if (project.objects.some(o => o.parentId === space.id)) continue;
    const ring = footprint(space)[0];
    if (!ring?.length) continue;
    // Both ends outside, and some part of the run inside. Testing the midpoint alone is not enough:
    // a wall crossing two rooms has its midpoint in the gap between them and would divide neither.
    const interior = (point: Point) =>
      inSpace(space, point) &&
      !footprint(space).some(closed => {
        const r = openRing(closed);
        return r.some((q, i) => segmentProjection(point, q, r[(i + 1) % r.length]).distance < 1e-6);
      });
    if (interior(a) || interior(b)) continue;
    const steps = Math.max(8, Math.min(200, Math.round(distance(a, b) / 0.25)));
    let entered = false;
    for (let i = 1; i < steps && !entered; i++) {
      const t = i / steps;
      entered = inSpace(space, [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
    if (entered) out.push(space);
  }
  return out;
}

/** Split every space a new wall cuts across, so the plan cannot claim two walled-apart halves are one
 *  place. Returns the ids of the pieces created.
 *
 *  The wall is assumed to exist already — this is called *because* one was drawn — so no partition is
 *  built. splitRoom would otherwise lay a second wall along the first.
 *
 *  Splitting is safe in a way that joining is not: one space becomes two and both inherit everything,
 *  where merging two spaces would have to destroy one identity — its name, its feed binding, whichever
 *  zones it had joined. That asymmetry is why this happens automatically and merging never will. */
export function divideSpaces(project: ProjectDocument, floorId: string | null, a: Point, b: Point): string[] {
  const made: string[] = [];
  for (const space of spacesDividedBy(project, floorId, a, b)) {
    try {
      made.push(splitRoom(project, space.id, a, b, false));
    } catch {
      // A cut that produces a sliver, or a shape polygon-clipping will not divide, leaves the space
      // whole. Better one honest space than two broken ones.
    }
  }
  return made;
}

/** Spaces that a wall was the only thing keeping apart: remove it and they are one room again.
 *
 *  Answered before the wall goes, because afterwards the evidence is gone. Two spaces qualify when
 *  they share a boundary that this barrier runs along, and nothing else is built across it. */
export function spacesRejoinedBy(project: ProjectDocument, barrierId: string): [SiteObject, SiteObject] | null {
  const barrier = project.barriers.find(b => b.id === barrierId);
  if (!barrier) return null;
  const without: ProjectDocument = { ...project, barriers: project.barriers.filter(x => x.id !== barrierId) };
  // The rule is simply: which pair becomes open to each other once this wall is gone? Ask the same
  // inference the rest of the model uses rather than inventing a second notion of adjacency, and
  // compare against what was already open so an unrelated doorway is not mistaken for this wall.
  const already = new Set(inferOpenBoundaries(project).map(p => [p.a, p.b].sort().join('|')));
  for (const portal of inferOpenBoundaries(without)) {
    if (already.has([portal.a, portal.b].sort().join('|'))) continue;
    const one = project.objects.find(o => o.id === portal.a),
      two = project.objects.find(o => o.id === portal.b);
    if (one && two) return [one, two];
  }
  return null;
}
/** Merge `absorbed` into `keep`, uniting their footprints. The survivor keeps its own name, colour and
 *  bindings; that is the whole reason this is never automatic — something is always discarded. */
export function mergeSpaces(project: ProjectDocument, keepId: string, absorbedId: string): boolean {
  const keep = project.objects.find(o => o.id === keepId),
    absorbed = project.objects.find(o => o.id === absorbedId);
  if (!keep || !absorbed || keep.id === absorbed.id) return false;
  if (keep.geometry?.mode === 'boundaries' || absorbed.geometry?.mode === 'boundaries') {
    if (!mergeBoundaryGeometry(project, keep, absorbed)) return false;
  } else {
    const united = polygonClipping.union(footprint(keep).map(closeRing), footprint(absorbed).map(closeRing));
    if (united.length !== 1) return false;
    keep.rings = united[0].map(r => closeRing(r as Point[]));
  }
  project.objects = project.objects.filter(o => o.id !== absorbedId);
  for (const o of project.objects) if (o.parentId === absorbedId) o.parentId = keepId;
  // Anything that pointed at the absorbed space now points at the survivor, then duplicates collapse.
  for (const portal of project.portals ?? []) {
    if (portal.a === absorbedId) portal.a = keepId;
    if (portal.b === absorbedId) portal.b = keepId;
  }
  project.portals = (project.portals ?? []).filter(p => p.a !== p.b);
  for (const zone of project.zones ?? [])
    zone.spaceIds = [...new Set(zone.spaceIds.map(id => (id === absorbedId ? keepId : id)))];
  pruneOntology(project);
  return true;
}
