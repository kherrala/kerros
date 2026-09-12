import { describe, expect, it } from 'vitest';
import { rectangle } from '../model/geometry';
import {
  alongPath,
  BODY,
  easeHeading,
  EYE,
  eyeZoom,
  MAX_MAP_ZOOM,
  MAX_PITCH,
  MIN_PITCH,
  REST_PITCH,
  stride,
  unstick,
  WALK_SPEED,
} from './walk';
import { createDemo } from '../../app/demo/demo';
import { add, rotate } from '../model/geometry';
import { wallPieces } from './features';
import { spaceAt } from '../model/spaces';
import { HEAD_ROOM } from './walk';
import type { Point, Ring } from '../model/types';

/** A 6 m wall along the x axis at y = 0, 0.2 m thick — the shape wallPieces() emits. */
const WALL: Ring = rectangle([0, 0], 6, 0.2);

/** Walk from `from` towards `to` in 2 cm steps, resolving against the walls at every step, and
 *  report where you end up. Stepping matters: a single big move can tunnel through a thin wall, and
 *  the controller's per-frame step is what the collision is actually asked to handle. */
function walk(from: Point, to: Point, walls: Ring[]): Point {
  const span = Math.hypot(to[0] - from[0], to[1] - from[1]);
  const steps = Math.max(1, Math.ceil(span / 0.02));
  const step: Point = [(to[0] - from[0]) / steps, (to[1] - from[1]) / steps];
  let at = from;
  for (let i = 0; i < steps; i++) at = unstick([at[0] + step[0], at[1] + step[1]], walls);
  return at;
}

describe('walking into things', () => {
  it('stops at a wall instead of passing through it', () => {
    const end = walk([0, -2], [0, 2], [WALL]);
    expect(end[1]).toBeLessThan(0); // still on the near side
    expect(end[1]).toBeCloseTo(-(0.1 + BODY), 2); // against the face, a body's width off the centreline
  });

  it('slides along a wall taken at an angle', () => {
    // The component into the wall is cancelled; the component along it is not. Without this you
    // stick to every wall you brush, which is what makes a corridor unwalkable.
    const end = walk([-3, -2], [3, 2], [WALL]);
    expect(end[1]).toBeLessThan(0);
    expect(end[0]).toBeGreaterThan(1.5); // carried well along the wall, not halted at first contact
  });

  it('walks through a door-width gap', () => {
    // wallPieces() splits a wall at an opening, so a 1 m door is two pieces with a metre between
    // them. A 0.28 m body has to fit, and has to fit without being nudged back out.
    const left = rectangle([-2, 0], 2, 0.2),
      right = rectangle([2, 0], 2, 0.2);
    const end = walk([0, -2], [0, 2], [left, right]);
    expect(end[1]).toBeGreaterThan(1.5);
    expect(Math.abs(end[0])).toBeLessThan(0.2);
  });

  it('does not squeeze into an inside corner', () => {
    const along = rectangle([0, 0], 6, 0.2),
      across = rectangle([-3, 3], 0.2, 6);
    const end = walk([0, 2], [-4, -1], [along, across]);
    expect(end[1]).toBeGreaterThan(0); // above the horizontal wall
    expect(end[0]).toBeGreaterThan(-3); // and outside the vertical one
  });

  it('lets you out again if you start inside a wall', () => {
    const out = unstick([0, 0], [WALL]);
    expect(Math.abs(out[1])).toBeGreaterThan(0.1);
  });

  it('leaves you alone in open floor', () => {
    expect(unstick([10, 10], [WALL])).toEqual([10, 10]);
  });
});

describe('standing at eye height', () => {
  it('solves the zoom that MapCanvas.fit() would measure back', () => {
    // fit(): altitude = cameraToCenterDistance · metresPerPixel · cos(pitch). eyeZoom is that
    // inverted, so round-tripping it has to land on the eye height we asked for.
    const lat = 60.1684,
      screen = 1075.5,
      pitch = 82;
    const zoom = eyeZoom(lat, screen, pitch, EYE);
    const perPixel = (156543.03392 * Math.cos((lat * Math.PI) / 180)) / 2 ** zoom;
    expect(screen * perPixel * Math.cos((pitch * Math.PI) / 180)).toBeCloseTo(EYE, 6);
  });

  it('needs less zoom the steeper it looks', () => {
    // Steeper pitch aims nearer, so the same eye height sits at a lower zoom — the reason pitch has
    // to be decided before zoom on every frame rather than held as a constant.
    expect(eyeZoom(60, 1075.5, MAX_PITCH, EYE)).toBeLessThan(eyeZoom(60, 1075.5, 70, EYE));
  });

  it('never divides by an eye height of zero', () => {
    expect(Number.isFinite(eyeZoom(60, 1075.5, 80, 0))).toBe(true);
  });
});

describe('what the keys do', () => {
  const held = (...keys: string[]) => new Set(keys);

  it('turns on the spot, and does not walk you anywhere doing it', () => {
    // The arrows swing you round your own axis: a person looking down a different corridor turns,
    // they do not slide sideways. Strafing is A and D and is a different thing.
    const left = stride(held('turnLeft'), 90, 0.5);
    const right = stride(held('turnRight'), 90, 0.5);
    expect(left.step).toBeUndefined();
    expect(right.step).toBeUndefined();
    expect(left.heading).toBeLessThan(90); // anticlockwise
    expect(right.heading).toBeGreaterThan(90); // clockwise
    expect(right.heading - left.heading).toBeCloseTo(90, 5); // 90°/s, half a second each way
  });

  it('wraps the heading rather than running off the end of the circle', () => {
    expect(stride(held('turnLeft'), 5, 0.5).heading).toBeCloseTo(320, 5);
    expect(stride(held('turnRight'), 340, 0.5).heading).toBeCloseTo(25, 5);
  });

  it('turns and walks at once without the turn stealing the step', () => {
    // Holding forward while turning has to curve, not stop: the step is taken along the heading you
    // finish the frame on, so a corridor can be walked round a corner in one motion.
    const out = stride(held('ahead', 'turnRight'), 0, 0.5);
    expect(out.heading).toBeCloseTo(45, 5);
    expect(Math.hypot(...out.step!)).toBeCloseTo(WALK_SPEED * 0.5, 5);
    expect(out.step![0]).toBeGreaterThan(0); // carried off along the new heading, not the old one
  });

  it('walks forward along the heading and strafes across it', () => {
    const forward = stride(held('ahead'), 0, 1);
    expect(forward.step![0]).toBeCloseTo(0, 6);
    expect(forward.step![1]).toBeCloseTo(WALK_SPEED, 6); // plan +Y is forward at heading 0
    const right = stride(held('right'), 0, 1);
    expect(right.step![0]).toBeCloseTo(WALK_SPEED, 6);
    expect(right.step![1]).toBeCloseTo(0, 6);
  });

  it('does not let a diagonal outrun a straight line', () => {
    const diagonal = stride(held('ahead', 'right'), 0, 1);
    expect(Math.hypot(...diagonal.step!)).toBeCloseTo(WALK_SPEED, 6);
  });

  it('hurries only when told to', () => {
    const walked = Math.hypot(...stride(held('ahead'), 0, 1).step!);
    const hurried = Math.hypot(...stride(held('ahead', 'fast'), 0, 1).step!);
    expect(hurried).toBeGreaterThan(walked);
  });
});

describe('walking the building that is actually drawn', () => {
  // The fixtures above are two rectangles and a gap. This is the real thing: the demo office floor's
  // own walls, doors, thicknesses and junction overruns. A collision that passes the fixtures and
  // then traps you in the room you started in passes nothing worth having.
  const demo = createDemo();
  const floorId = 'floor-08';
  const walls = wallPieces(demo, floorId, false)
    .filter(p => p.base < HEAD_ROOM)
    .map(p => p.ring);
  const junctions = new Map(demo.junctions.map(j => [j.id, j.position]));

  /** Walk from `from` towards `to` in controller-sized steps, reporting where you end up.
   *
   *  A frame at 60 Hz is 23 mm, which over a sixty-metre office floor against a thousand wall pieces
   *  is a quarter of a million circle-rectangle tests per march. The step is capped at 8 cm — still
   *  far finer than the 0.28 m body, so nothing tunnels — because a test that takes half a minute
   *  gets deleted rather than fixed. */
  const march = (from: Point, to: Point) => {
    const span = Math.hypot(to[0] - from[0], to[1] - from[1]);
    const steps = Math.max(1, Math.ceil(span / 0.08));
    const dx = (to[0] - from[0]) / steps,
      dy = (to[1] - from[1]) / steps;
    let at = from;
    for (let i = 0; i < steps; i++) at = unstick([at[0] + dx, at[1] + dy], walls);
    return at;
  };

  /** Every door on the level, as the point in its opening and the direction through it. */
  const doorways = demo.objects.flatMap(o => {
    if (o.kind !== 'door' || !o.barrierId) return [];
    const barrier = demo.barriers.find(b => b.id === o.barrierId && b.floorId === floorId);
    if (!barrier) return [];
    const a = junctions.get(barrier.startId),
      b = junctions.get(barrier.endId);
    if (!a || !b) return [];
    const angle = (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI;
    const at = add(a, rotate([o.offset ?? 0, 0], angle));
    const through = rotate([0, 1], angle) as Point; // across the wall, either way
    return [{ at, through, width: o.width }];
  });

  it('has walls to walk into and doors to walk through', () => {
    expect(walls.length).toBeGreaterThan(100);
    expect(doorways.length).toBeGreaterThan(10);
  });

  it('goes through a doorway rather than bouncing off the wall it is in', () => {
    // The complaint this exists for. wallPieces splits a wall at its openings, so a door is a gap in
    // the collision list and nothing has to know what a door is — but only if the gap is wider than
    // the walker. Start a stride back on one side, walk straight through, and check which side you
    // come out on.
    const crossed = doorways.filter(d => {
      const from: Point = [d.at[0] - d.through[0] * 1.4, d.at[1] - d.through[1] * 1.4];
      const to: Point = [d.at[0] + d.through[0] * 1.4, d.at[1] + d.through[1] * 1.4];
      const end = march(from, to);
      // Positive projection on the wall normal means the walker finished on the far side.
      return (end[0] - d.at[0]) * d.through[0] + (end[1] - d.at[1]) * d.through[1] > 0.3;
    });
    expect(crossed.length / doorways.length).toBeGreaterThan(0.9);
  });

  it('will not walk through the solid part of a wall', () => {
    // The other half of the same claim: a gap that lets everything through is not a wall. Aim at the
    // middle of each wall piece, a metre off its face, and check you are stopped by it.
    const solid = walls.filter(r => r.length > 4).slice(0, 60);
    const blocked = solid.filter(ring => {
      const cx = ring.slice(0, 4).reduce((s, p) => s + p[0], 0) / 4,
        cy = ring.slice(0, 4).reduce((s, p) => s + p[1], 0) / 4;
      // Approach from outside along the piece's shortest axis, which for a wall body is its thickness.
      const dx = ring[1][0] - ring[0][0],
        dy = ring[1][1] - ring[0][1];
      const len = Math.hypot(dx, dy) || 1;
      const n: Point = [-dy / len, dx / len];
      const from: Point = [cx - n[0] * 1.2, cy - n[1] * 1.2];
      const end = march(from, [cx, cy]);
      return Math.hypot(end[0] - cx, end[1] - cy) > 0.05; // did not reach the centreline
    });
    expect(blocked.length).toBe(solid.length);
  });

  it('leaves the room it started in', () => {
    // Room centre to room centre, on the floor with a real fit-out. A straight line between two
    // offices will meet walls, and should — what it must not do is leave the walker where it began.
    const rooms = demo.objects.filter(o => o.floorId === floorId && o.kind === 'room' && o.rings?.length);
    const centre = (ring: Point[]): Point => [
      ring.reduce((s, p) => s + p[0], 0) / ring.length,
      ring.reduce((s, p) => s + p[1], 0) / ring.length,
    ];
    // A concave room's centroid can fall in its own notch, so start in one that contains its own
    // middle — the point of the test is the walking, not the geometry of the first room in the list.
    const home = rooms.find(o => spaceAt(demo, floorId, centre(o.rings![0]))?.id === o.id)!;
    const start = centre(home.rings![0]);
    const startSpace = spaceAt(demo, floorId, start)?.id;
    expect(startSpace).toBeTruthy();
    const elsewhere = rooms
      .filter(o => o !== home)
      .slice(0, 12)
      .map(o => spaceAt(demo, floorId, march(start, centre(o.rings![0])))?.id)
      .filter(id => id && id !== startSpace);
    expect(elsewhere.length).toBeGreaterThan(0);
  });
});

describe('the range the head can turn through', () => {
  it('leaves room to look up as well as down', () => {
    // MapLibre will not pitch past 85°, so "level" is as far up as the camera goes and the default
    // has to sit below it — parked at the ceiling, dragging up does nothing at all, which is what
    // made looking up feel broken rather than limited.
    expect(REST_PITCH).toBeLessThan(MAX_PITCH);
    expect(REST_PITCH).toBeGreaterThan(MIN_PITCH);
    expect(MAX_PITCH).toBe(85);
  });

  it('keeps the whole range inside the zoom the map will give it', () => {
    // Eye height is a zoom solved from the pitch, and looking down needs more zoom than looking
    // level. If the steepest downward look solves past the map's maxZoom the eye silently rises off
    // the floor, so the downward limit is set by the zoom ceiling, not by taste.
    const tallWindow = 1600 * 1.5; // cameraToCenterDistance on a tall display
    expect(eyeZoom(60, tallWindow, MIN_PITCH, EYE + 0.33)).toBeLessThan(MAX_MAP_ZOOM);
  });
});

describe('being carried along a route', () => {
  /** An L: 10 m north, then 10 m east. */
  const corner: Point[] = [
    [0, 0],
    [0, 10],
    [10, 10],
  ];

  it('walks the path at the distance asked for', () => {
    expect(alongPath(corner, 0).at).toEqual([0, 0]);
    expect(alongPath(corner, 5).at[1]).toBeCloseTo(5, 6);
    expect(alongPath(corner, 15).at[0]).toBeCloseTo(5, 6);
    expect(alongPath(corner, 15).at[1]).toBeCloseTo(10, 6);
  });

  it('stops at the end rather than running off it', () => {
    const past = alongPath(corner, 500);
    expect(past.at).toEqual([10, 10]);
    expect(past.done).toBe(true);
    expect(past.left).toBe(0);
    expect(alongPath(corner, 5).done).toBe(false);
  });

  it('starts turning before the corner, not at it', () => {
    // The whole reason the aim point runs ahead of the walker. Two metres short of the turn the
    // heading already has some east in it; on the straight before that it does not.
    const early = alongPath(corner, 4).heading; // well back on the straight
    const approaching = alongPath(corner, 9).heading; // a metre short of the corner
    expect(early).toBeCloseTo(0, 1); // due plan-north
    expect(approaching).toBeGreaterThan(10);
    expect(approaching).toBeLessThan(90);
  });

  it('finishes facing the way the path finishes', () => {
    // The aim point is capped at the end, so the last stretch is walked looking along it rather than
    // spinning as the look-ahead runs out of path to look at.
    expect(alongPath(corner, 19.9).heading).toBeCloseTo(90, 0);
    expect(alongPath(corner, 20).heading).toBeCloseTo(90, 0);
  });

  it('survives a path with a doubled point in it', () => {
    const doubled: Point[] = [
      [0, 0],
      [0, 0],
      [0, 6],
    ];
    expect(alongPath(doubled, 3).at[1]).toBeCloseTo(3, 6);
    expect(Number.isFinite(alongPath(doubled, 3).heading)).toBe(true);
  });
});

describe('easing the head round', () => {
  it('turns the short way round the circle', () => {
    expect(easeHeading(350, 10, 90)).toBeCloseTo(10, 6); // forwards through 0, not 340° backwards
    expect(easeHeading(10, 350, 90)).toBeCloseTo(350, 6);
  });

  it('never turns faster than it is allowed to', () => {
    // This is the difference between a turn and a cut, and it is the whole complaint about the
    // camera snapping at corners.
    expect(easeHeading(0, 170, 30)).toBeCloseTo(30, 6);
    expect(easeHeading(0, 190, 30)).toBeCloseTo(330, 6);
  });

  it('settles exactly on the target rather than oscillating past it', () => {
    let h = 0;
    for (let i = 0; i < 40; i++) h = easeHeading(h, 95, 10);
    expect(h).toBeCloseTo(95, 6);
  });
});
