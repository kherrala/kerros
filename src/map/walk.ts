// First-person walk mode: drives the MapLibre camera as if it were a person standing on the active
// floor. MapLibre has no eye — it has a ground point it looks AT, a pitch and a zoom — so "standing
// two metres up" is a zoom solved from the pitch, and "looking ahead" is the centre pushed forward
// along the bearing. Both halves already existed (MapCanvas.fit() measures the altitude that way,
// journey.ts/aimCenter shifts a centre for elevation); this module inverts them and adds the part a
// map has never needed: a body that cannot walk through a wall.
//
// Deliberately free of React and of the document model: it takes plan-coordinate wall rectangles and
// gives back a pose, so the geometry is testable without a GL context.
import type { Map as GLMap } from 'maplibre-gl';
import type { Origin, Point, Ring } from '../model/types';
import { toLngLat } from '../model/geometry';
import { aimCenter } from './journey';

/** Eye above the slab it stands on. A constant, not the floor's height: a mezzanine and a hall are
 *  different rooms but the same visitor. */
export const EYE = 1.7;
/** Shoulder radius. Generous enough that you do not clip a corner, tight enough for a 0.9 m door. */
export const BODY = 0.28;
export const WALK_SPEED = 1.4; // m/s, an unhurried indoor pace
export const RUN_SPEED = 3.4; // Shift: covering a department without waiting for it
/** Following a route on its own. Brisker than a stroll, because nobody watches a demonstration at
 *  1.4 m/s, and well short of the 4 m/s the fly-over uses — at eye level that is a sprint. */
export const TOUR_SPEED = 2.4;
/** How fast the head can swing while a route is driving. A corner taken at the full rate still
 *  reads as a turn rather than as a cut, and anything quicker is the sharp turn this replaced. */
export const TURN_RATE = 120;
/** How far up the path to look while following it. Aiming at a point ahead rather than at the
 *  segment you are on is what makes the camera begin its turn before the corner instead of at it —
 *  it is also what a person does, which is why it looks right. */
export const LOOK_AHEAD = 2.6;
/** How far the head turns. 85° is MapLibre's hard ceiling and is as level as its camera goes, so
 *  "look up" can only mean "back towards level" — and the resting pitch has to sit below the ceiling
 *  or dragging up does nothing at all. Below 60° the zoom solved for eye height runs past what the
 *  map will give, which would quietly lift the eye off the floor. */
export const MIN_PITCH = 60,
  MAX_PITCH = 85;
/** Where the head rests: a few degrees off level, so there is somewhere to look in both directions
 *  and enough of the near floor in frame that walking reads as walking. */
export const REST_PITCH = 80;
/** The map's zoom ceiling, which is what bounds MIN_PITCH: looking down needs more zoom than looking
 *  level, and a solve that hits the ceiling lifts the eye off the floor without saying so. Kept here
 *  rather than in MapCanvas so the two cannot drift apart. */
export const MAX_MAP_ZOOM = 26;
export const LOOK_SPEED = 0.22; // degrees per pixel dragged
export const TURN_SPEED = 90; // degrees per second for Q/E and arrow turning
/** A wall piece whose underside clears this is a head-height lintel — the strip over a door — and you
 *  walk under it. Anything lower is something you walk into. */
export const HEAD_ROOM = 1.25;

export interface WalkPose {
  /** Where the walker stands, in plan metres. */
  position: Point;
  /** Clockwise from plan +Y, matching the plan's own grid rather than the compass. */
  heading: number;
  pitch: number;
  /** True while the mouse is held down and turning the view. */
  looking: boolean;
}

/* ------------------------------------------------------------------ geometry */

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

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

/** The zoom at which MapLibre's camera sits `eye` metres above the ground it is aimed at.
 *
 *  MapCanvas.fit() reads the altitude as cameraToCenterDistance · metresPerPixel · cos(pitch); this
 *  is that solved for zoom. Steeper pitch means a nearer target, so the same eye height needs less
 *  zoom — which is why pitch has to be decided before zoom every frame. */
export function eyeZoom(lat: number, screenDistance: number, pitchDeg: number, eye: number): number {
  const cos = Math.cos((pitchDeg * Math.PI) / 180);
  return Math.log2((156543.03392 * Math.cos((lat * Math.PI) / 180) * screenDistance * cos) / Math.max(eye, 0.2));
}

/** One frame of walking: what the held keys do to a heading and a position over `dt` seconds.
 *
 *  Pulled out of the controller because it is the part with an opinion in it — which key turns you
 *  and which key carries you — and that opinion is worth stating somewhere a test can read it.
 *  Returns the new heading and the step to take, in plan metres, before any wall gets a say. */
export function stride(keys: ReadonlySet<string>, heading: number, dt: number): { heading: number; step?: Point } {
  // Turning is a turn on the spot: the arrows swing you round your own axis and move you nowhere,
  // which is what a person does when they look down a different corridor. Strafing — sidling along
  // without turning — is A and D, and is a different thing that wants a different key.
  let facing = heading;
  if (keys.has('turnLeft') !== keys.has('turnRight'))
    facing = (((facing + (keys.has('turnRight') ? 1 : -1) * TURN_SPEED * dt) % 360) + 360) % 360;
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
  const aim = pick(Math.min(total, travelled + ahead));
  const dx = aim[0] - from[0],
    dy = aim[1] - from[1];
  const heading = Math.hypot(dx, dy) < 1e-6 ? 0 : ((((Math.atan2(dx, dy) * 180) / Math.PI) % 360) + 360) % 360;
  return { at, heading, done: travelled >= total, left: Math.max(0, total - travelled) };
}

/** Turn `from` towards `to` by at most `step` degrees, the short way round. */
export function easeHeading(from: number, to: number, step: number): number {
  const delta = ((((to - from + 540) % 360) + 360) % 360) - 180;
  return (((from + clamp(delta, -step, step)) % 360) + 360) % 360;
}

/* ------------------------------------------------------------------ controller */

export interface WalkTerrain {
  /** Solid wall bodies on the floor being walked, in plan metres. */
  walls: Ring[];
  /** Eye height above the presented ground plane: EYE plus whatever lifts the slab. */
  eye: number;
}

export interface WalkCallbacks {
  /** Fired once per frame in which anything changed — position, heading, pitch or pointer lock. */
  onPose(pose: WalkPose): void;
  /** The walker asked to change level (F, or Shift+F for down). The host decides whether there is
   *  anywhere to go from where they are standing. */
  onUse(down: boolean): void;
  /** Escape with no pointer lock to release: the host leaves walk mode. */
  onExit(): void;
}

const HANDLERS = ['dragPan', 'dragRotate', 'scrollZoom', 'keyboard', 'touchZoomRotate', 'doubleClickZoom'] as const;
type Handler = (typeof HANDLERS)[number];

const KEYS: Record<string, string> = {
  KeyW: 'ahead',
  ArrowUp: 'ahead',
  KeyS: 'back',
  ArrowDown: 'back',
  KeyA: 'left',
  KeyD: 'right',
  KeyQ: 'turnLeft',
  ArrowLeft: 'turnLeft',
  KeyE: 'turnRight',
  ArrowRight: 'turnRight',
  ShiftLeft: 'fast',
  ShiftRight: 'fast',
};

export class WalkController {
  private map?: GLMap;
  private origin: Origin = [0, 0];
  private terrain: WalkTerrain = { walls: [], eye: EYE };
  private keys = new Set<string>();
  private frame = 0;
  private last = 0;
  private dragging = false;
  private handlers: [Handler, boolean][] = [];
  private running = false;
  private drag: Point = [0, 0];
  private path: Point[] | null = null;
  private travelled = 0;
  private arrive?: () => void;
  position: Point = [0, 0];
  heading = 0;
  pitch = REST_PITCH;

  constructor(private readonly on: WalkCallbacks) {}

  attach(map: GLMap, origin: Origin, start: { position: Point; heading: number; pitch?: number }) {
    this.map = map;
    this.origin = origin;
    this.position = start.position;
    this.heading = start.heading;
    this.pitch = clamp(start.pitch ?? REST_PITCH, MIN_PITCH, MAX_PITCH);
    this.running = true;
    // MapLibre's own handlers would fight every jumpTo we make, and its keyboard handler eats the
    // very keys we walk with. Remember which were on rather than re-enabling a fixed list on the way
    // out: the host has its own opinions about dragRotate and doubleClickZoom, and handing back a
    // different map than we were given is how a mode leaves damage behind it.
    this.handlers = HANDLERS.map(h => [h, map[h]?.isEnabled() ?? false]);
    for (const [h] of this.handlers) map[h]?.disable();
    const canvas = map.getCanvas();
    canvas.addEventListener('pointerdown', this.grab);
    canvas.addEventListener('pointermove', this.look);
    canvas.addEventListener('pointerup', this.drop);
    canvas.addEventListener('pointercancel', this.drop);
    window.addEventListener('keydown', this.down, true);
    window.addEventListener('keyup', this.up, true);
    window.addEventListener('blur', this.release);
    this.last = performance.now();
    this.frame = requestAnimationFrame(this.tick);
    map.getCanvas().style.cursor = 'grab';
    this.apply();
  }

  detach() {
    const map = this.map;
    this.running = false;
    this.cancelFollow();
    cancelAnimationFrame(this.frame);
    this.keys.clear();
    if (!map) return;
    const canvas = map.getCanvas();
    canvas.removeEventListener('pointerdown', this.grab);
    canvas.removeEventListener('pointermove', this.look);
    canvas.removeEventListener('pointerup', this.drop);
    canvas.removeEventListener('pointercancel', this.drop);
    window.removeEventListener('keydown', this.down, true);
    window.removeEventListener('keyup', this.up, true);
    window.removeEventListener('blur', this.release);
    canvas.style.cursor = '';
    for (const [h, was] of this.handlers) if (was) map[h]?.enable();
    this.handlers = [];
    this.map = undefined;
  }

  /** The floor under the walker changed, or its walls were edited. */
  setTerrain(terrain: WalkTerrain) {
    this.terrain = terrain;
    if (this.running) this.apply();
  }

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
    this.position = position;
    this.heading = heading;
    if (this.running) this.apply();
  }

  get pose(): WalkPose {
    return {
      position: this.position,
      heading: this.heading,
      pitch: this.pitch,
      looking: this.dragging,
    };
  }

  /** Turning is drag, not pointer lock. Lock takes the cursor away from the rest of the app — the
   *  floor selector, the panels and the other view modes are all still there — and a mode you have
   *  to press Escape to get out of is a mode you get trapped in. Drag also asks the browser for no
   *  permission and needs no gesture it might refuse. */
  private grab = (e: PointerEvent) => {
    if (e.button !== 0) return;
    const canvas = this.map?.getCanvas();
    if (!canvas) return;
    this.dragging = true;
    this.drag = [e.clientX, e.clientY];
    canvas.setPointerCapture(e.pointerId);
    canvas.style.cursor = 'grabbing';
    this.on.onPose(this.pose);
  };

  private drop = (e: PointerEvent) => {
    if (!this.dragging) return;
    this.dragging = false;
    const canvas = this.map?.getCanvas();
    if (canvas?.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    if (canvas) canvas.style.cursor = 'grab';
    this.on.onPose(this.pose);
  };

  private release = () => this.keys.clear();

  private look = (e: PointerEvent) => {
    if (!this.dragging) return;
    const [px, py] = this.drag;
    this.drag = [e.clientX, e.clientY];
    // Mouse-look, not map-drag: the view follows the hand. Drag right and you turn right, drag up
    // and you look up — the same way round on both axes, which is the half of it that was wrong when
    // horizontal dragged the world and vertical dragged the head.
    this.heading = (((this.heading + (e.clientX - px) * LOOK_SPEED) % 360) + 360) % 360;
    // Looking up is a LARGER pitch: 85 is as level as MapLibre's camera goes and 0 is straight down,
    // so the sign is inverted relative to the usual "pitch up" reading.
    this.pitch = clamp(this.pitch - (e.clientY - py) * LOOK_SPEED, MIN_PITCH, MAX_PITCH);
    this.apply();
  };

  private down = (e: KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const target = e.target as HTMLElement | null;
    if (target && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))) return;
    if (e.code === 'Escape') {
      this.on.onExit();
      return;
    }
    if (e.code === 'KeyF' || e.code === 'Enter') {
      e.preventDefault();
      e.stopImmediatePropagation();
      this.on.onUse(e.shiftKey);
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
    const dt = Math.min((now - this.last) / 1000, 0.1); // a backgrounded tab must not teleport you
    this.last = now;
    if (this.path) {
      // Touching a movement key takes the tour back off the route; dragging to look around does not,
      // because looking about you while the route carries you on is the whole point of watching it.
      if (this.keys.size) this.cancelFollow();
      else return this.advance(dt);
    }
    if (!this.keys.size) return;
    const moved = stride(this.keys, this.heading, dt);
    this.heading = moved.heading;
    if (moved.step)
      this.position = unstick([this.position[0] + moved.step[0], this.position[1] + moved.step[1]], this.terrain.walls);
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

  /** One camera write per frame: pitch decides the zoom, the zoom decides how far ahead to aim. */
  private apply() {
    const map = this.map;
    if (!map) return;
    const bearing = (((this.heading + (this.origin[2] ?? 0)) % 360) + 360) % 360;
    const stand = toLngLat(this.position, this.origin);
    const screenDistance =
      (map as unknown as { transform?: { cameraToCenterDistance?: number } }).transform?.cameraToCenterDistance ??
      map.getCanvas().height * 1.5;
    const eye = this.terrain.eye;
    map.jumpTo({
      center: aimCenter(stand as [number, number], eye, this.pitch, bearing),
      zoom: eyeZoom(stand[1], screenDistance, this.pitch, eye),
      bearing,
      pitch: this.pitch,
    });
    this.on.onPose(this.pose);
  }
}
