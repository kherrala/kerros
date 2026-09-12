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
/** Below 60° the solved zoom runs away and the floor fills the screen; 85° is MapLibre's ceiling. */
export const MIN_PITCH = 60,
  MAX_PITCH = 85;
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
  position: Point = [0, 0];
  heading = 0;
  /** 85° is as level as MapLibre's camera goes, and level is where a person looks. Anything less and
   *  the floor fills the screen — which is a plan view with extra steps. */
  pitch = MAX_PITCH;

  constructor(private readonly on: WalkCallbacks) {}

  attach(map: GLMap, origin: Origin, start: { position: Point; heading: number; pitch?: number }) {
    this.map = map;
    this.origin = origin;
    this.position = start.position;
    this.heading = start.heading;
    this.pitch = clamp(start.pitch ?? MAX_PITCH, MIN_PITCH, MAX_PITCH);
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
    const keys = this.keys;
    if (!keys.size) return;
    if (keys.has('turnLeft') !== keys.has('turnRight'))
      this.heading = (((this.heading + (keys.has('turnRight') ? 1 : -1) * TURN_SPEED * dt) % 360) + 360) % 360;
    const ahead = (keys.has('ahead') ? 1 : 0) - (keys.has('back') ? 1 : 0);
    const side = (keys.has('right') ? 1 : 0) - (keys.has('left') ? 1 : 0);
    if (ahead || side) {
      const rad = (this.heading * Math.PI) / 180;
      // Plan +Y is the walker's forward at heading 0, so forward is [sin, cos] and right is its
      // perpendicular. Diagonals are normalised — strafing must not be faster than walking.
      const scale = (keys.has('fast') ? RUN_SPEED : WALK_SPEED) * dt * (ahead && side ? Math.SQRT1_2 : 1);
      const step: Point = [
        (ahead * Math.sin(rad) + side * Math.cos(rad)) * scale,
        (ahead * Math.cos(rad) - side * Math.sin(rad)) * scale,
      ];
      this.position = unstick([this.position[0] + step[0], this.position[1] + step[1]], this.terrain.walls);
    }
    this.apply();
  };

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
