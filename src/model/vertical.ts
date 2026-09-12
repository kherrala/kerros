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
import { closeRing, footprint, objectPosition, objectRotation, rectangle } from './geometry';
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

/** The deepest tread that is still a tread. Past about a third of a metre a flight stops being a
 *  stair: the going grows with the box while the rise per step does not, and what you get is a ramp
 *  with slabs laid on it. A box longer than the climb needs keeps its length — the surplus is
 *  landing, which is what that spare floor really is. */
export const MAX_GOING = 0.32;
/** A comfortable domestic riser, and close to code everywhere. */
const RISER = 0.175;
/** Head clearance under a flight, and so the reach of the hole one needs in the plate it climbs
 *  through: everything above the plate, plus the stretch below it where a person standing on the
 *  plate would still be under the soffit. */
const HEADROOM = 2.1;

/** The treads one flight of this rise gets, and how deep each is in a run of this length. Capped
 *  both ways: a handful of boxes reads as a stair, two hundred reads as a stair and costs a level. */
export function treads(rise: number, run: number): { steps: number; going: number } {
  const steps = Math.max(2, Math.min(24, Math.round(rise / RISER)));
  return { steps, going: Math.min(MAX_GOING, run / steps) };
}

export type StairModel = NonNullable<SiteObject['stairModel']>;

/** How a shaft is built — as the document says, or as its own footprint implies.
 *
 *  A footprint that cannot take the rise at a civil pitch is describing a stair that turns, which is
 *  what a short wide core box always is. Both the renderer and the plate it cuts its hole in have to
 *  agree about that, so the reading lives here rather than in either of them. */
export function stairModel(project: ProjectDocument, object: SiteObject): StairModel {
  if (object.stairModel) return object.stairModel;
  const first = flights(project, object)[0];
  return first && pitchOf(first.rise, Math.max(0.6, object.depth)) > 38 ? 'switchback' : 'straight';
}

/** A bank of escalators is stacked criss-cross: every other flight runs the other way, so you step
 *  off one and turn to step onto the next. Which way round a given flight is decides which end of
 *  the footprint it arrives at, and so which end of it the floor above has to be open. */
export const flightReversed = (model: StairModel, index: number) => model === 'escalator' && index % 2 === 1;

/** Where one flight's sloping part actually lies inside the box the plan drew.
 *
 *  The plan gives a footprint; the climb is what has to fit in it. An escalator keeps a metre of flat
 *  comb plate at each end and then climbs at the machine's own 30°, so a box with run to spare gets a
 *  longer landing at its foot instead of a shallower ramp — a 1.6 m rise in a 12 m box is a stair with
 *  a lot of floor round it, not a slide. A stair's treads are capped at MAX_GOING for the same reason.
 *  A box too short for its rise is left alone: it really is that steep and the picture should say so.
 *
 *  `t` runs along the object's depth axis from its centre. The foot of a flight is at +depth/2 and its
 *  head at -depth/2, which is how the renderer has always laid one out; the surplus goes to whichever
 *  end that leaves free — the foot of an escalator, whose comb plates must stay at the ends the plan
 *  drew them at, and the head of a stair, which has none. */
export interface FlightRun {
  /** The rotation this flight is drawn at — see flightReversed. */
  rotation: number;
  /** A point t metres along the run from the object's centre. */
  at: (t: number) => Point;
  /** How long the box is along that axis, and half of it. */
  length: number;
  half: number;
  /** The flat plate at each end of an escalator; zero for a stair. */
  pad: number;
  /** The sloping part: how long it is, and where it starts and ends along the run. */
  incline: number;
  topT: number;
  footT: number;
}
export function flightRun(
  project: ProjectDocument,
  object: SiteObject,
  rise: number,
  model: StairModel,
  index = 0,
): FlightRun {
  const position = objectPosition(project, object);
  const rotation = objectRotation(project, object) + (flightReversed(model, index) ? 180 : 0);
  const rad = (rotation * Math.PI) / 180;
  const ux = Math.sin(rad),
    uy = -Math.cos(rad);
  const at = (t: number): Point => [position[0] + ux * t, position[1] + uy * t];
  const length = Math.max(0.6, object.depth),
    half = length / 2;
  if (model === 'escalator') {
    const pad = Math.min(1, length / 4);
    const incline = Math.min(length - pad * 2, Math.max(0.4, runFor(rise, PITCH.escalator)));
    return { rotation, at, length, half, pad, incline, topT: -half + pad, footT: -half + pad + incline };
  }
  const { steps, going } = treads(rise, length);
  const incline = Math.min(length, steps * going);
  return { rotation, at, length, half, pad: 0, incline, topT: half - incline, footT: half };
}

/** The hole one flight needs in a plate standing `height` metres above its foot.
 *
 *  Not the flight's whole footprint. Everything from the head of the run down to where the flight
 *  pierces the plate has to be open, because the flight is above the plate there; so does the stretch
 *  below it where the soffit is still within head height. Past that the flight is under the floor,
 *  which is where the cupboard under the stairs comes from — and why punching the whole of an
 *  eight-metre escalator through every storey it passes opened a trench in each of them. */
function headroomBand(run: FlightRun, rise: number, height: number, width: number): Ring {
  const steep = rise > 0.01 ? run.incline / rise : run.incline;
  const end = Math.min(run.footT, Math.max(run.topT + 0.6, run.footT - height * steep + HEADROOM * steep));
  const depth = end - run.topT;
  return closeRing(rectangle(run.at(run.topT + depth / 2), width, depth, run.rotation));
}

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

/** Does something come up through this level's floor? The shaft starts below it and reaches it or
 *  goes past — so a flight arrives here and the plate it arrives through has to be open.
 *
 *  This is one half of what `passesThrough` used to answer for both. Requiring a served level above
 *  as well meant the flight arriving at the top of a run was drawn under an uncut slab: on Stockmann's
 *  ninth floor all twelve shafts arrive and not one of them cut a hole, so the last flight of every
 *  stair in the building was invisible from the storey it lands on. */
export function arrivesAt(project: ProjectDocument, object: SiteObject, floorId: string): boolean {
  const level = project.floors.find(f => f.id === floorId);
  if (!level) return false;
  const levels = servedFloors(project, object);
  return (
    levels.some(f => f.elevation < level.elevation - 0.01) && levels.some(f => f.elevation >= level.elevation - 0.01)
  );
}

/** The other half: does something climb out through this level's ceiling? The shaft stands on this
 *  level or lower and carries on above it, so the lid a walked storey gets has to be open over it —
 *  which the bottom of a run needs just as much as the middle of one. */
export function departsFrom(project: ProjectDocument, object: SiteObject, floorId: string): boolean {
  const level = project.floors.find(f => f.id === floorId);
  if (!level) return false;
  const levels = servedFloors(project, object);
  return (
    levels.some(f => f.elevation <= level.elevation + 0.01) && levels.some(f => f.elevation > level.elevation + 0.01)
  );
}

/** Does this shaft pass THROUGH a level — arriving from below and carrying on above? Both halves at
 *  once, which is the question a level in the middle of a run answers yes to and no end of one does. */
export const passesThrough = (project: ProjectDocument, object: SiteObject, floorId: string): boolean =>
  arrivesAt(project, object, floorId) && departsFrom(project, object, floorId);

export interface VoidOptions {
  /** `floor` (the default) cuts what arrives from below; `ceiling` cuts what departs upward. */
  through?: 'floor' | 'ceiling';
  /** Ignore flights that set off below this elevation. An above-ground view draws nothing under
   *  grade, and a hole with nothing beneath it is worse than no hole at all. */
  lowest?: number;
}

/** What to cut out of a level's floor plate, or out of the lid over a walked storey.
 *
 *  A stairwell is a hole. Drawing the slab whole and the stair beneath it puts a lid over the flight,
 *  so from the landing above you see a plate where the opening should be and the stair appears to
 *  climb into the ceiling. The hole is only as big as the flight needs, though: a lift or a turning
 *  core is a shaft and takes its whole footprint, but a straight flight or an escalator lies under
 *  the floor for most of its length and wants opening only where it comes up — see headroomBand. */
export function shaftVoids(
  project: ProjectDocument,
  floorId: string,
  primary?: Set<string>,
  options: VoidOptions = {},
): Ring[] {
  const level = project.floors.find(f => f.id === floorId);
  if (!level) return [];
  const ceiling = options.through === 'ceiling';
  const lowest = options.lowest ?? -Infinity;
  const out: Ring[] = [];
  for (const o of project.objects) {
    if (!isVertical(o.kind) || (primary && !primary.has(o.id))) continue;
    const all = flights(project, o);
    // The one climb this plate is in the way of: the flight arriving through it, or the flight
    // setting off up through it. They are different flights on a level in the middle of a run, and
    // on a criss-cross bank they arrive at opposite ends of the same box.
    const index = ceiling
      ? all.findIndex(f => f.from.elevation <= level.elevation + 0.01 && f.to.elevation > level.elevation + 0.01)
      : all.findIndex(f => f.from.elevation < level.elevation - 0.01 && f.to.elevation >= level.elevation - 0.01);
    if (index < 0) continue;
    const flight = all[index];
    if (flight.from.elevation < lowest) continue;
    const model = stairModel(project, o);
    if (o.kind === 'stairs' && (model === 'straight' || model === 'escalator')) {
      const run = flightRun(project, o, flight.rise, model, index);
      const height = ceiling ? flight.rise : level.elevation - flight.from.elevation;
      out.push(headroomBand(run, flight.rise, height, o.width));
      continue;
    }
    const ring = footprint(o)[0];
    // A touch proud of the shaft itself, so the slab does not leave a hairline of itself behind.
    if (ring?.length) out.push(closeRing(ring.map(p => [p[0], p[1]] as Point)));
  }
  return out;
}
