// First-person walk mode: the MapLibre camera becomes a person standing on the active floor, driven
// the way every first-person game drives one — W A S D and the arrows to move, the mouse to aim.
//
// MapLibre has no eye of its own: it has a ground point it looks AT, a pitch, and a zoom. Where the
// eye ends up is a consequence of the three, and solving them by hand with the wrong tile size is
// how the previous walk came to stand at half its own height. eyeCamera() is that solve done the
// way MapLibre's own calculateCameraOptionsFromCameraLngLatAltRotation() does it — the same mercator
// arithmetic, the same zoom formula — so this module only has to say where the person is and which
// way they face, plus the geometry a map has never needed: a body that cannot walk through a wall.
//
// Deliberately free of React and of the document model: it takes plan-coordinate wall rectangles and
// gives back a pose, so everything below the controller is testable without a GL context.
import maplibregl, { type Map as GLMap } from 'maplibre-gl';
import type { Origin, Point, Ring } from '../model/types';
import { toLngLat } from '../model/geometry';

/** Eye above the slab it stands on. A constant, not the floor's height: a mezzanine and a hall are
 *  different rooms but the same visitor. */
export const EYE = 1.7;
/** Shoulder radius. Generous enough that you do not clip a corner, tight enough for a 0.9 m door. */
export const BODY = 0.28;
/** Faster than anyone walks a corridor, because on a screen the corridor is the size of a hand and
 *  a literal 1.4 m/s reads as wading. Games settle around 3–4 m/s for the same reason. */
export const WALK_SPEED = 3;
export const RUN_SPEED = 6; // Shift: covering a department without waiting for it
/** Following a route on its own. A touch over walking pace, because nobody watches a demonstration
 *  dawdle, and short of the run — a tour is for looking about you, and at eye level 6 m/s is a
 *  sprint. */
export const TOUR_SPEED = 3.5;
/** How fast the head can swing while a route is driving. A corner taken at the full rate still
 *  reads as a turn rather than as a cut, and anything quicker is the sharp turn this replaced. */
export const TURN_RATE = 120;
/** How far up the path to look while following it. Aiming at a point ahead rather than at the
 *  segment you are on is what makes the camera begin its turn before the corner instead of at it —
 *  it is also what a person does, which is why it looks right. */
export const LOOK_AHEAD = 2.6;
/** Pitch is MapLibre's: 0 looks straight down at the ground, 90 is level with it. The head can drop
 *  to 55° below level — enough to read a floor marking at your feet — and rise to a degree short of
 *  level. Not level itself: at 90° the point the map looks at leaves the ground, and MapLibre then
 *  has to invent a target in the sky, which pulls its zoom (and every zoom-gated layer) down to
 *  what a satellite would use. At 89° the target is a hundred-odd metres up the corridor, the
 *  horizon is a degree above the middle of the frame, and nothing has to be invented. */
export const MIN_PITCH = 35,
  MAX_PITCH = 89;
/** Where the head rests: a few degrees below level, so the near floor is in frame and walking reads
 *  as walking, with room to look up from. */
export const REST_PITCH = 86;
/** The plan camera's zoom ceiling, and the one the walk raises it to while it has the map. MapLibre
 *  puts its camera at the eye by choosing a zoom for the ground point the eye looks at, and jumpTo
 *  clamps that zoom to the ceiling without a word — a ceiling the solve can hit is a ceiling that
 *  silently lifts the eye off the floor. A 2 m eye looking 55° down on a 4K display at the equator
 *  needs 26.6, so the walk's ceiling is 28. Kept here so MapCanvas and the solve agree. */
export const MAX_MAP_ZOOM = 26,
  WALK_ZOOM = 28;
/** The most device pixels per CSS pixel the walk will draw. A retina display asks for two, which
 *  is four times the pixels of one, and at eye level every one of them is lit by the sun, the sky
 *  and four lamps with shadows: a dense floor measured at 11 frames a second at two and 35 at one.
 *  A plan is read; a walk is watched, and a watched picture has to move. 1.25 keeps most of the
 *  crispness of a retina display for a third of its cost. */
export const WALK_PIXEL_RATIO = 1.25;
/** Horizontal field of view in degrees. Kept stable when side panels resize the viewport. */
export const DEFAULT_WALK_FOV = 90,
  MIN_WALK_FOV = 60,
  MAX_WALK_FOV = 120;

export function walkFieldOfView(value: number): number {
  return Number.isFinite(value) ? Math.min(MAX_WALK_FOV, Math.max(MIN_WALK_FOV, value)) : DEFAULT_WALK_FOV;
}

/** MapLibre takes a vertical angle; tan(h/2) = aspect · tan(v/2). */
export function verticalFieldOfView(horizontal: number, aspect: number): number {
  return (2 * Math.atan(Math.tan((walkFieldOfView(horizontal) * Math.PI) / 360) / aspect) * 180) / Math.PI;
}
/** Degrees the view turns per pixel the mouse moves while the pointer is locked. */
export const MOUSE_LOOK = 0.12;
/** Degrees per pixel when dragging instead — the fallback when the browser refuses the lock. A drag
 *  is a deliberate motion and wants a bit more turn for its trouble. */
export const DRAG_LOOK = 0.22;
export const TURN_SPEED = 120; // degrees per second for A, D and the arrow keys
/** A wall piece whose underside clears this is a head-height lintel — the strip over a door — and you
 *  walk under it. Anything lower is something you walk into. */
export const HEAD_ROOM = 1.25;

/** Where the walker is, kept apart from the camera: the camera is whatever mode you are in, the
 *  avatar is the person, and they persist across leaving the walk and coming back to it. */
export interface WalkAvatar {
  floorId: string | null;
  /** Plan metres. */
  position: Point;
  /** Clockwise from plan +Y, as WalkPose.heading. */
  heading: number;
  pitch?: number;
}

export interface WalkPose {
  /** Where the walker stands, in plan metres. */
  position: Point;
  /** Clockwise from plan +Y, matching the plan's own grid rather than the compass. */
  heading: number;
  pitch: number;
  /** True while the mouse is aiming the view — the pointer is locked, or held down and dragged. */
  looking: boolean;
  /** True while the browser has given the pointer to the walk: no cursor, and Esc hands it back. */
  locked: boolean;
}

/* ------------------------------------------------------------------ geometry */

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const wrap = (deg: number) => ((deg % 360) + 360) % 360;

/** Nearest point to `p` on the segment ab. */
function onSegment(p: Point, a: Point, b: Point): Point {
  const dx = b[0] - a[0],
    dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-12) return a;
  const t = clamp(((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2, 0, 1);
  return [a[0] + t * dx, a[1] + t * dy];
}

function inside(p: Point, ring: Ring): boolean {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i],
      [xj, yj] = ring[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

/** Push a walker of radius `r` out of every wall it overlaps.
 *
 *  Resolving each wall independently and in sequence is what produces sliding for free: walking into
 *  a wall at an angle leaves the along-wall component of the move untouched and cancels only the
 *  component that would have gone through it. Two passes settle inside corners, where pushing out of
 *  one wall can push you into its neighbour. */
export function unstick(p: Point, walls: Ring[], r = BODY): Point {
  let out = p;
  for (let pass = 0; pass < 2; pass++) {
    let moved = false;
    for (const ring of walls) {
      let near: Point | null = null,
        nearD = Infinity;
      for (let i = 0; i < ring.length - 1; i++) {
        const c = onSegment(out, ring[i], ring[i + 1]);
        const d = Math.hypot(out[0] - c[0], out[1] - c[1]);
        if (d < nearD) {
          nearD = d;
          near = c;
        }
      }
      if (!near || (nearD >= r && !inside(out, ring))) continue;
      let dx = out[0] - near[0],
        dy = out[1] - near[1];
      if (inside(out, ring)) {
        // Standing in the wall — a door frame skimmed at speed, or a start point placed badly. Leave
        // by the face we are nearest, which is the one we came in through.
        dx = -dx;
        dy = -dy;
      }
      const len = Math.hypot(dx, dy);
      if (len < 1e-9) continue; // exactly on the centreline: no direction to prefer, let the next frame decide
      out = [near[0] + (dx / len) * r, near[1] + (dy / len) * r];
      moved = true;
    }
    if (!moved) break;
  }
  return out;
}

/** The MapLibre camera that stands at `eye`, `alt` metres up, facing `bearing` and tilted `pitch`:
 *  the ground point it looks at and the zoom that puts it that far away.
 *
 *  This is MapLibre's calculateCenterFromCameraLngLatAlt() for a camera that looks at the ground —
 *  the ray from the eye meets the ground alt/cos(pitch) away, and the zoom is the one at which that
 *  distance fills cameraToCenterDistance pixels. MapLibre's own copy gives up within six degrees of
 *  level and invents a target ten kilometres off instead, which is fine for a plane and is a 700 m
 *  eye for a person; this one holds to the ground right up to MAX_PITCH. The mercator scale is
 *  taken at the target rather than the eye, iterated, because a metre is a different fraction of
 *  the world at each latitude and the target is the point the zoom is measured at. */
export function eyeCamera(
  view: { cameraToCenterDistance: number; tileSize: number },
  eye: [number, number],
  alt: number,
  bearing: number,
  pitch: number,
): { center: [number, number]; zoom: number } {
  const pitchRad = (Math.min(pitch, MAX_PITCH) * Math.PI) / 180,
    bearingRad = (bearing * Math.PI) / 180;
  const distance = alt / Math.cos(pitchRad); // eye to target, along the view
  const dx = Math.sin(pitchRad) * Math.sin(bearingRad),
    dy = -Math.sin(pitchRad) * Math.cos(bearingRad); // mercator y grows southward
  const from = maplibregl.MercatorCoordinate.fromLngLat({ lng: eye[0], lat: eye[1] }, alt);
  let perMetre = from.meterInMercatorCoordinateUnits();
  let target = from;
  for (let i = 0; i < 10; i++) {
    const d = distance * perMetre;
    target = new maplibregl.MercatorCoordinate(from.x + dx * d, from.y + dy * d, 0);
    const next = target.meterInMercatorCoordinateUnits();
    if (Math.abs(next - perMetre) < 1e-18) break;
    perMetre = next;
  }
  const ll = target.toLngLat();
  return {
    center: [ll.lng, ll.lat],
    zoom: Math.log2(view.cameraToCenterDistance / (distance * perMetre) / view.tileSize),
  };
}

/** What a mouse movement does to where you are looking. Right turns you right; up looks up — which
 *  in MapLibre's terms is a LARGER pitch, 90 being level and 0 the floor. The head stops at the
 *  limits rather than wrapping: nobody looks at the ceiling by looking too far at their feet. */
export function aim(
  heading: number,
  pitch: number,
  dx: number,
  dy: number,
  perPixel = MOUSE_LOOK,
): { heading: number; pitch: number } {
  return { heading: wrap(heading + dx * perPixel), pitch: clamp(pitch - dy * perPixel, MIN_PITCH, MAX_PITCH) };
}

/** One frame of walking: what the held keys do to a heading and a position over `dt` seconds.
 *
 *  Pulled out of the controller because it is the part with an opinion in it — which key turns you
 *  and which key carries you — and that opinion is worth stating somewhere a test can read it.
 *  Returns the new heading and the step to take, in plan metres, before any wall gets a say. */
export function stride(keys: ReadonlySet<string>, heading: number, dt: number): { heading: number; step?: Point } {
  // Turning is a turn on the spot: A, D and the arrows swing you round your own axis and move you
  // nowhere, which is what a person does when they look down a different corridor. Strafing —
  // sidling along without turning — is Q and E, and is a different thing that wants a different key.
  let facing = heading;
  if (keys.has('turnLeft') !== keys.has('turnRight'))
    facing = wrap(facing + (keys.has('turnRight') ? 1 : -1) * TURN_SPEED * dt);
  const ahead = (keys.has('ahead') ? 1 : 0) - (keys.has('back') ? 1 : 0);
  const side = (keys.has('right') ? 1 : 0) - (keys.has('left') ? 1 : 0);
  if (!ahead && !side) return { heading: facing };
  const rad = (facing * Math.PI) / 180;
  // Plan +Y is the walker's forward at heading 0, so forward is [sin, cos] and right is its
  // perpendicular. Diagonals are normalised — strafing must not be faster than walking.
  const scale = (keys.has('fast') ? RUN_SPEED : WALK_SPEED) * dt * (ahead && side ? Math.SQRT1_2 : 1);
  return {
    heading: facing,
    step: [
      (ahead * Math.sin(rad) + side * Math.cos(rad)) * scale,
      (ahead * Math.cos(rad) - side * Math.sin(rad)) * scale,
    ],
  };
}

/** Where you are after walking `travelled` metres along a polyline, and which way the path is
 *  heading `ahead` metres further on. Clamped at both ends, and `done` once the path runs out. */
export function alongPath(
  points: Point[],
  travelled: number,
  ahead = LOOK_AHEAD,
): { at: Point; heading: number; done: boolean; left: number } {
  const seg: number[] = [];
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const d = Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
    seg.push(d);
    total += d;
  }
  const pick = (distance: number): Point => {
    let left = clamp(distance, 0, total);
    for (let i = 0; i < seg.length; i++) {
      if (left <= seg[i] || i === seg.length - 1) {
        const t = seg[i] > 1e-9 ? clamp(left / seg[i], 0, 1) : 0;
        return [
          points[i][0] + (points[i + 1][0] - points[i][0]) * t,
          points[i][1] + (points[i + 1][1] - points[i][1]) * t,
        ];
      }
      left -= seg[i];
    }
    return points[points.length - 1];
  };
  const at = pick(travelled);
  // The aim point is capped at the end of the path, and the point it is measured FROM is held a
  // hair short of the end — otherwise the two coincide on the last step, the direction collapses to
  // nothing and the walker finishes facing plan north instead of facing the way they arrived.
  const from = pick(Math.min(travelled, total - 1e-3));
  const aimAt = pick(Math.min(total, travelled + ahead));
  const dx = aimAt[0] - from[0],
    dy = aimAt[1] - from[1];
  const heading = Math.hypot(dx, dy) < 1e-6 ? 0 : wrap((Math.atan2(dx, dy) * 180) / Math.PI);
  return { at, heading, done: travelled >= total, left: Math.max(0, total - travelled) };
}

/** Turn `from` towards `to` by at most `step` degrees, the short way round. */
export function easeHeading(from: number, to: number, step: number): number {
  const delta = ((((to - from + 540) % 360) + 360) % 360) - 180;
  return wrap(from + clamp(delta, -step, step));
}

/* ------------------------------------------------------------------ controller */

export interface WalkTerrain {
  /** Solid wall bodies on the floor being walked, in plan metres. */
  walls: Ring[];
  /** Eye height above the presented ground plane: EYE plus whatever lifts the slab. */
  eye: number;
  floorId?: string | null;
  dropAt?: (at: Point) => { floorId: string; distance: number } | undefined;
}

export interface WalkCallbacks {
  /** A real opening has a landing below. Rebase the scene onto that floor before animating descent. */
  onDrop?(floorId: string): void;
  /** Fired once per frame in which anything changed — position, heading, pitch or pointer lock. */
  onPose(pose: WalkPose): void;
  /** The walker asked to change level (F, or Shift+F for down). The host decides whether there is
   *  anywhere to go from where they are standing. */
  onUse(down: boolean): void;
  /** Escape with no pointer lock to release: the host leaves walk mode. */
  onExit(): void;
  /** M: the walker wants the sound on or off. */
  onSound?(): void;
}

const HANDLERS = ['dragPan', 'dragRotate', 'scrollZoom', 'keyboard', 'touchZoomRotate', 'doubleClickZoom'] as const;
type Handler = (typeof HANDLERS)[number];

/** The keys, by physical position rather than by letter so the layout survives a French or a Dvorak
 *  keyboard. W and S walk, A and D turn — the way Doom bound the arrows, and what a person
 *  walking a floor plan reaches for: the point of A is to look down the other corridor, not to
 *  sidle towards it. Q and E sidestep for whoever wants it, the arrows mirror the letters, and Shift
 *  runs. */
export const KEYS: Record<string, string> = {
  KeyW: 'ahead',
  ArrowUp: 'ahead',
  KeyS: 'back',
  ArrowDown: 'back',
  KeyA: 'turnLeft',
  ArrowLeft: 'turnLeft',
  KeyD: 'turnRight',
  ArrowRight: 'turnRight',
  KeyQ: 'left',
  KeyE: 'right',
  ShiftLeft: 'fast',
  ShiftRight: 'fast',
};

/** Esc leaves the pointer lock, and the browser may deliver that key to the page as well as acting
 *  on it. For this long after an unlock a second Esc is taken to be the same one. */
const UNLOCK_GRACE_MS = 300;

export class WalkController {
  private map?: GLMap;
  private origin: Origin = [0, 0];
  private terrain: WalkTerrain = { walls: [], eye: EYE };
  private keys = new Set<string>();
  private frame = 0;
  private last = 0;
  private handlers: [Handler, boolean][] = [];
  private maxPitch = 60;
  private maxZoom = 22;
  private pixelRatio = 1;
  private planFov = 0;
  private fieldOfView = DEFAULT_WALK_FOV;
  private running = false;
  private dragging = false;
  private locked = false;
  private unlockedAt = -Infinity;
  private drag: Point = [0, 0];
  private path: Point[] | null = null;
  private travelled = 0;
  private arrive?: () => void;
  private fall?: { floorId: string; remaining: number; speed: number; ready: boolean };
  position: Point = [0, 0];
  heading = 0;
  pitch = REST_PITCH;

  constructor(private readonly on: WalkCallbacks) {}

  attach(map: GLMap, origin: Origin, start: { position: Point; heading: number; pitch?: number }) {
    this.map = map;
    this.origin = origin;
    this.position = start.position;
    this.fall = undefined;
    this.heading = wrap(start.heading);
    this.pitch = clamp(start.pitch ?? REST_PITCH, MIN_PITCH, MAX_PITCH);
    this.running = true;
    // MapLibre's own handlers would fight every jumpTo we make, and its keyboard handler eats the
    // very keys we walk with. Remember which were on rather than re-enabling a fixed list on the way
    // out: the host has its own opinions about dragRotate and doubleClickZoom, and handing back a
    // different map than we were given is how a mode leaves damage behind it.
    this.handlers = HANDLERS.map(h => [h, map[h]?.isEnabled() ?? false]);
    for (const [h] of this.handlers) map[h]?.disable();
    // jumpTo clamps to the map's pitch and zoom ceilings without a word, and the plan camera's are
    // below where a walker looks and how near the floor they stand. Raise both for the walk, and
    // put them back with the handlers.
    this.maxPitch = map.getMaxPitch();
    this.maxZoom = map.getMaxZoom();
    this.planFov = map.getVerticalFieldOfView();
    map.setMaxPitch(Math.max(this.maxPitch, MAX_PITCH));
    map.setMaxZoom(Math.max(this.maxZoom, WALK_ZOOM));
    this.pixelRatio = map.getPixelRatio();
    if (this.pixelRatio > WALK_PIXEL_RATIO) map.setPixelRatio(WALK_PIXEL_RATIO);
    const canvas = map.getCanvas();
    canvas.addEventListener('pointerdown', this.grab);
    canvas.addEventListener('pointermove', this.look);
    canvas.addEventListener('pointerup', this.drop);
    canvas.addEventListener('pointercancel', this.drop);
    document.addEventListener('pointerlockchange', this.lockChanged);
    window.addEventListener('keydown', this.down, true);
    window.addEventListener('keyup', this.up, true);
    window.addEventListener('blur', this.release);
    map.on('resize', this.resize);
    this.last = performance.now();
    this.frame = requestAnimationFrame(this.tick);
    canvas.style.cursor = 'crosshair';
    this.resize();
  }

  detach() {
    const map = this.map;
    this.running = false;
    this.cancelFollow();
    cancelAnimationFrame(this.frame);
    this.keys.clear();
    document.removeEventListener('pointerlockchange', this.lockChanged);
    window.removeEventListener('keydown', this.down, true);
    window.removeEventListener('keyup', this.up, true);
    window.removeEventListener('blur', this.release);
    if (!map) return;
    map.off('resize', this.resize);
    const canvas = map.getCanvas();
    canvas.removeEventListener('pointerdown', this.grab);
    canvas.removeEventListener('pointermove', this.look);
    canvas.removeEventListener('pointerup', this.drop);
    canvas.removeEventListener('pointercancel', this.drop);
    if (document.pointerLockElement === canvas) document.exitPointerLock?.();
    this.locked = false;
    this.dragging = false;
    canvas.style.cursor = '';
    for (const [h, was] of this.handlers) if (was) map[h]?.enable();
    this.handlers = [];
    map.setMaxPitch(this.maxPitch);
    map.setMaxZoom(this.maxZoom);
    map.setVerticalFieldOfView(this.planFov);
    if (map.getPixelRatio() !== this.pixelRatio) map.setPixelRatio(this.pixelRatio);
    this.map = undefined;
  }

  /** The floor under the walker changed, or its walls were edited. */
  setTerrain(terrain: WalkTerrain) {
    this.terrain = terrain;
    if (this.fall) {
      if (terrain.floorId === this.fall.floorId) this.fall.ready = true;
      else this.fall = undefined;
    }
    if (this.running) this.apply();
  }

  /** Widen the lens without changing the person's position, heading or eye height. */
  setFieldOfView(value: number) {
    this.fieldOfView = walkFieldOfView(value);
    if (this.running) this.resize();
  }

  private resize = () => {
    const map = this.map;
    if (!map) return;
    const canvas = map.getCanvas();
    if (canvas.clientWidth > 0 && canvas.clientHeight > 0)
      map.setVerticalFieldOfView(verticalFieldOfView(this.fieldOfView, canvas.clientWidth / canvas.clientHeight));
    // A new lens changes cameraToCenterDistance; solve zoom again to keep the eye in place.
    this.apply();
  };

  /** Walk a path on its own, as far as it goes on this floor, then call `onArrive`. Taking any
   *  control cancels it: a tour you cannot interrupt is a video. */
  follow(points: Point[], onArrive: () => void) {
    const pts = points.filter((p, i) => !i || Math.hypot(p[0] - points[i - 1][0], p[1] - points[i - 1][1]) > 0.01);
    if (pts.length < 2) return onArrive();
    this.path = pts;
    this.travelled = 0;
    this.arrive = onArrive;
    const start = alongPath(pts, 0);
    this.position = start.at;
    this.heading = start.heading;
    if (this.running) this.apply();
  }

  cancelFollow() {
    this.path = null;
    this.arrive = undefined;
  }

  get following() {
    return !!this.path;
  }

  /** Put the walker somewhere — arriving at a new floor, or jumping to a route's start. */
  place(position: Point, heading = this.heading) {
    this.fall = undefined;
    this.position = position;
    this.heading = wrap(heading);
    if (this.running) this.apply();
  }

  /** Inspect something from the current position. Only the walker writes a POV camera: panning
   *  its ground target like a plan camera would move the eye far behind the selected object. */
  lookAt(point: Point) {
    const dx = point[0] - this.position[0],
      dy = point[1] - this.position[1];
    if (Math.hypot(dx, dy) < 1e-6) return;
    this.heading = wrap((Math.atan2(dx, dy) * 180) / Math.PI);
    if (this.running) this.apply();
  }

  get pose(): WalkPose {
    return {
      position: this.position,
      heading: this.heading,
      pitch: this.pitch,
      looking: this.locked || this.dragging,
      locked: this.locked,
    };
  }

  /** A click takes the mouse: the pointer is locked to the canvas and its movement turns the head,
   *  the way a first-person game does it. The browser can refuse — no support, a permission policy,
   *  or Chrome's cool-down after Esc released the last lock — so the same click also begins a drag,
   *  and the drag stays in force only if the lock never arrives. */
  private grab = (e: PointerEvent) => {
    if (e.button !== 0 || e.pointerType === 'touch') return;
    const canvas = this.map?.getCanvas();
    if (!canvas) return;
    e.preventDefault();
    // A click while the pointer is already locked is nothing: the mouse is aiming, and Chrome
    // throws on a capture request from a locked element. The drag is only for when there is no lock.
    if (this.locked || document.pointerLockElement === canvas) return;
    this.dragging = true;
    this.drag = [e.clientX, e.clientY];
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {
      /* the pointer went away between down and here; the drag ends with the next up */
    }
    if (!this.locked && document.pointerLockElement !== canvas) {
      try {
        // Raw mouse input first — no OS acceleration, which is what aiming wants — and a plain
        // lock when the platform has none, because Chrome refuses the whole request rather than
        // settling for the plain one. Chrome returns a promise; Safari and Firefox return nothing
        // and report through pointerlockerror instead. Either way a refusal leaves the drag.
        const lock = canvas.requestPointerLock as (o?: unknown) => Promise<void> | undefined;
        lock
          .call(canvas, { unadjustedMovement: true })
          ?.catch(() => lock.call(canvas))
          ?.catch(() => undefined);
      } catch {
        /* no pointer lock here: drag to look */
      }
    }
    this.on.onPose(this.pose);
  };

  private drop = (e: PointerEvent) => {
    if (!this.dragging) return;
    this.dragging = false;
    const canvas = this.map?.getCanvas();
    if (canvas?.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    this.on.onPose(this.pose);
  };

  private lockChanged = () => {
    const canvas = this.map?.getCanvas();
    const locked = !!canvas && document.pointerLockElement === canvas;
    if (locked === this.locked) return;
    this.locked = locked;
    if (locked)
      this.dragging = false; // the lock supersedes the drag that asked for it
    else this.unlockedAt = performance.now();
    this.on.onPose(this.pose);
  };

  private release = () => this.keys.clear();

  private look = (e: PointerEvent) => {
    let dx: number, dy: number;
    if (this.locked) {
      dx = e.movementX;
      dy = e.movementY;
    } else if (this.dragging) {
      dx = e.clientX - this.drag[0];
      dy = e.clientY - this.drag[1];
      this.drag = [e.clientX, e.clientY];
    } else return;
    if (!dx && !dy) return;
    const turned = aim(this.heading, this.pitch, dx, dy, this.locked ? MOUSE_LOOK : DRAG_LOOK);
    this.heading = turned.heading;
    this.pitch = turned.pitch;
    this.apply();
  };

  private down = (e: KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const target = e.target as HTMLElement | null;
    if (target && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))) return;
    if (e.code === 'Escape') {
      // With the pointer locked, Esc is the browser's: it releases the lock, and the walk carries
      // on. Only an Esc with nothing left to release leaves the walk.
      if (this.locked || performance.now() - this.unlockedAt < UNLOCK_GRACE_MS) return;
      this.on.onExit();
      return;
    }
    if (e.code === 'KeyF' || e.code === 'Enter') {
      e.preventDefault();
      e.stopImmediatePropagation();
      this.on.onUse(e.shiftKey);
      return;
    }
    if (e.code === 'KeyM') {
      e.preventDefault();
      e.stopImmediatePropagation();
      this.on.onSound?.();
      return;
    }
    const action = KEYS[e.code];
    if (!action) return;
    e.preventDefault();
    // stopPropagation is not enough: the host registers its own shortcuts on window too, and
    // stopping propagation does nothing to listeners on the same target. W and S would pitch the
    // map, the arrows would pan it, and both would fight the walk on every step.
    e.stopImmediatePropagation();
    this.keys.add(action);
  };

  private up = (e: KeyboardEvent) => {
    const action = KEYS[e.code];
    if (action) this.keys.delete(action);
  };

  private tick = (now: number) => {
    if (!this.running) return;
    this.frame = requestAnimationFrame(this.tick);
    // Capped, so a backgrounded tab does not teleport you when it comes back — but not at a frame's
    // worth: a dense floor can render at a few frames a second, and a cap of 100 ms then takes the
    // missing time out of your stride and makes the whole walk slow.
    const dt = Math.min((now - this.last) / 1000, 0.25);
    this.last = now;
    if (this.fall) {
      if (this.fall.ready) {
        this.fall.remaining = Math.max(0, this.fall.remaining - this.fall.speed * dt - 0.5 * 9.81 * dt * dt);
        this.fall.speed += 9.81 * dt;
        if (this.fall.remaining === 0) this.fall = undefined;
        this.apply();
      }
      return;
    }
    if (this.path) {
      // Touching a movement key takes the tour back off the route; aiming the view does not,
      // because looking about you while the route carries you on is the whole point of watching it.
      if (this.keys.size) this.cancelFollow();
      else return this.advance(dt);
    }
    if (!this.keys.size) return;
    const moved = stride(this.keys, this.heading, dt);
    this.heading = moved.heading;
    if (moved.step)
      this.position = unstick([this.position[0] + moved.step[0], this.position[1] + moved.step[1]], this.terrain.walls);
    const drop = this.terrain.dropAt?.(this.position);
    if (drop && this.on.onDrop) {
      this.cancelFollow();
      this.fall = { floorId: drop.floorId, remaining: drop.distance, speed: 0, ready: false };
      this.on.onDrop(drop.floorId);
      return;
    }
    this.apply();
  };

  /** One frame of being carried along a route. The heading is rate-limited towards a point further
   *  up the path rather than snapped to the segment underfoot, which is what turns a corner into a
   *  turn instead of a cut. */
  private advance(dt: number) {
    if (!this.path) return;
    this.travelled += TOUR_SPEED * dt;
    const step = alongPath(this.path, this.travelled);
    this.position = step.at;
    this.heading = easeHeading(this.heading, step.heading, TURN_RATE * dt);
    this.apply();
    if (step.done) {
      const arrived = this.arrive;
      this.cancelFollow();
      arrived?.();
    }
  }

  /** One camera write per frame. The eye is where the walker stands, `terrain.eye` metres up, facing
   *  `heading` and tilted `pitch`; eyeCamera() turns that into the ground point the camera looks at
   *  and how far away it is, which is all a MapLibre camera can be told. */
  private apply() {
    const map = this.map;
    if (!map) return;
    const bearing = wrap(this.heading + (this.origin[2] ?? 0));
    const eye = toLngLat(this.position, this.origin);
    const camera = eyeCamera(
      map.transform,
      [eye[0], eye[1]],
      this.terrain.eye + (this.fall?.ready ? this.fall.remaining : 0),
      bearing,
      this.pitch,
    );
    map.jumpTo({ center: camera.center, zoom: camera.zoom, bearing, pitch: this.pitch });
    this.on.onPose(this.pose);
  }
}
