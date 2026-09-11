// Vertical circulation: which levels a stair, escalator or lift actually reaches, and what it has to
// climb between them.
//
// A shaft is the one object that is not on a floor so much as *between* floors, and the document has
// always said so — `servedFloorIds` is authored in the inspector, seeded by the factory, threaded by
// routing and enforced by validation. Nothing else read it. The renderer guessed instead, taking
// "the next floor up in the same building" as the rise and drawing the object only on the storey it
// was filed under, which is why a flight arriving at a level was invisible from that level and why a
// lift serving eight floors was a box you could see over.
//
// This is where that question gets answered once, so the plan, the route and the model agree about
// where a stair goes.
import { closeRing, footprint } from './geometry';
import type { Floor, Point, ProjectDocument, Ring, SiteObject } from './types';

/** True for the kinds that connect levels. */
export const isVertical = (kind: string) => kind === 'stairs' || kind === 'elevator';

/** Which shaft this object is part of.
 *
 *  A shaft is one thing standing in one place reaching several levels, and that is how the document
 *  can describe it: one object, one position, one `servedFloorIds`. Older documents — the demo among
 *  them — instead repeat the object on every storey it serves, because that is what you had to do
 *  before anything read the served list. Both must draw as one lift, so a shaft is identified by what
 *  makes it the same shaft: its kind, its name, and where it stands. */
export const shaftKey = (object: SiteObject) =>
  `${object.kind}|${object.name}|${object.position[0].toFixed(2)}|${object.position[1].toFixed(2)}`;

/** Every level this shaft reaches, lowest first.
 *
 *  `servedFloorIds` when it is authored — that is the document's own statement and outranks any
 *  inference. A shaft that declares nothing serves the floor it stands on and no other: better to
 *  draw a stair going nowhere, which is visibly wrong and easy to fix, than to invent a connection
 *  that routing would then happily send someone through. */
export function servedFloors(project: ProjectDocument, object: SiteObject): Floor[] {
  // Every twin's reach, not just this one's. A plan sheet only says what is on its own storey, so an
  // import gives the same stair once per floor it is drawn on, each claiming only that floor. Read
  // together they say what the stair actually connects — which is the question being asked, and the
  // reason a stair imported from three sheets is one flight and not three plates.
  const key = shaftKey(object);
  const ids = project.objects
    .filter(o => isVertical(o.kind) && shaftKey(o) === key)
    .flatMap(o => (o.servedFloorIds?.length ? o.servedFloorIds : o.floorId ? [o.floorId] : []));
  return [...new Set(ids.length ? ids : object.floorId ? [object.floorId] : [])]
    .map(id => project.floors.find(f => f.id === id))
    .filter((f): f is Floor => !!f)
    .sort((a, b) => a.elevation - b.elevation);
}

/** One climb between two levels the shaft serves. */
export interface Flight {
  from: Floor;
  to: Floor;
  /** Metres climbed, always positive. */
  rise: number;
}

/** The climbs this shaft makes, bottom first.
 *
 *  Consecutive served levels, so a stair serving 0-1-2 makes two flights and a lift serving the same
 *  three makes two hops of shaft. A level in between that the shaft passes without stopping is simply
 *  not in the list, and the flight spanning it is the taller for it — which is the right picture: an
 *  express lift's shaft does pass those floors, and a spiral stair's helix does wind past a mezzanine
 *  it has no landing on. */
export function flights(project: ProjectDocument, object: SiteObject): Flight[] {
  const levels = servedFloors(project, object);
  const out: Flight[] = [];
  for (let i = 1; i < levels.length; i++)
    out.push({ from: levels[i - 1], to: levels[i], rise: levels[i].elevation - levels[i - 1].elevation });
  return out;
}

/** Does this shaft reach the given level? Includes the floor it is filed under. */
export const reaches = (project: ProjectDocument, object: SiteObject, floorId: string | null): boolean =>
  floorId !== null && (object.floorId === floorId || servedFloors(project, object).some(f => f.id === floorId));

/** The flight arriving at a level from below, and the one leaving it upward — what you would see
 *  standing on that level. Either may be absent at the ends of the run. */
export function flightsAt(
  project: ProjectDocument,
  object: SiteObject,
  floorId: string | null,
): { up?: Flight; down?: Flight } {
  const all = flights(project, object);
  return {
    up: all.find(f => f.from.id === floorId),
    down: all.find(f => f.to.id === floorId),
  };
}

/** How far a shaft's body runs, as absolute elevations: the lowest level it serves to the highest.
 *  Null when it serves fewer than two levels and so has no body to speak of. */
export function span(project: ProjectDocument, object: SiteObject): { bottom: number; top: number } | null {
  const levels = servedFloors(project, object);
  if (levels.length < 2) return null;
  return { bottom: levels[0].elevation, top: levels[levels.length - 1].elevation };
}

/** The angle a flight of this kind wants to climb at, in degrees from horizontal.
 *
 *  An escalator is a machine built to one geometry: 30°, the world over. A stair is free-er but a
 *  comfortable flight is around 32°, and anything past about 42° is a ladder. These are what the
 *  plan should be *checked against* — the footprint stays the truth of where the thing is — so a run
 *  too short for its rise reads as the steep slope it would really be. */
export const PITCH = { escalator: 30, stairs: 32 } as const;

/** The run a flight of this rise needs to climb at its natural pitch. Use it to size a shaft the
 *  drawing has not sized, and to tell whether one it has sized is plausible. */
export const runFor = (rise: number, pitch: number = PITCH.stairs) => rise / Math.tan((pitch * Math.PI) / 180);

/** The pitch a flight actually climbs at, given the run the plan gives it. */
export const pitchOf = (rise: number, run: number) => (run > 0 ? (Math.atan(rise / run) * 180) / Math.PI : 90);

/** The one twin that stands for the shaft: the lowest, so the flights count upward from the bottom.
 *  A shaft described the modern way — one object — is trivially its own primary. */
export function primaryShafts(project: ProjectDocument): Set<string> {
  const lowest = new Map<string, SiteObject>();
  for (const o of project.objects) {
    if (!isVertical(o.kind)) continue;
    const key = shaftKey(o);
    const rival = lowest.get(key);
    const at = (x: SiteObject) => project.floors.find(f => f.id === x.floorId)?.elevation ?? 0;
    if (!rival || at(o) < at(rival)) lowest.set(key, o);
  }
  return new Set([...lowest.values()].map(o => o.id));
}

/** Does this shaft pass THROUGH a level — arriving from below and carrying on above?
 *
 *  The distinction that matters for the floor plate: a stair that stops here needs a landing, a stair
 *  that carries on needs a hole. A level the shaft serves in the middle of its run is both, which is
 *  why the test is on the run rather than on the stop: it passes if anything it serves is below and
 *  anything it serves is above. */
export function passesThrough(project: ProjectDocument, object: SiteObject, floorId: string): boolean {
  const level = project.floors.find(f => f.id === floorId);
  if (!level) return false;
  const levels = servedFloors(project, object);
  return (
    levels.some(f => f.elevation < level.elevation - 0.01) && levels.some(f => f.elevation > level.elevation + 0.01)
  );
}

/** The footprints to cut out of a level's floor plate: every shaft that passes through it.
 *
 *  A stairwell is a hole. Drawing the slab whole and the stair beneath it puts a lid over the flight,
 *  so from the landing above you see a plate where the opening should be and the stair appears to
 *  climb into the ceiling — which is the other half of why a flight was never visible from the level
 *  it arrives at. Only shafts that carry on past the level are cut: one that terminates here opens
 *  onto it and needs its floor. */
export function shaftVoids(project: ProjectDocument, floorId: string, primary?: Set<string>): Ring[] {
  const out: Ring[] = [];
  for (const o of project.objects) {
    if (!isVertical(o.kind) || (primary && !primary.has(o.id))) continue;
    if (!passesThrough(project, o, floorId)) continue;
    const ring = footprint(o)[0];
    // A touch proud of the shaft itself, so the slab does not leave a hairline of itself behind.
    if (ring?.length) out.push(closeRing(ring.map(p => [p[0], p[1]] as Point)));
  }
  return out;
}
