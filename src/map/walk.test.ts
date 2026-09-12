import { describe, expect, it } from 'vitest';
import { rectangle } from '../model/geometry';
import { BODY, EYE, eyeZoom, MAX_PITCH, unstick } from './walk';
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
