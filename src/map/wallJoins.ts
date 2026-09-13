import { distance } from '../model/geometry';
import type { Barrier, Point, ProjectDocument, Ring } from '../model/types';

type Ray = { wall: Barrier; direction: Point; length: number; angle: number };
const cross = (a: Point, b: Point) => a[0] * b[1] - a[1] * b[0];
const offset = (ray: Ray, side: number): Point => [
  (-ray.direction[1] * ray.wall.thickness * side) / 2,
  (ray.direction[0] * ray.wall.thickness * side) / 2,
];

/** Adjacent wall faces intersect once at each junction. Both walls use that same corner, so
 * oblique L, T and four-way joins close without rectangular end caps protruding through them. */
export function wallFootprints(project: ProjectDocument): Map<string, Ring> {
  const positions = new Map(project.junctions.map(j => [j.id, j.position]));
  const meeting = new Map<string, Ray[]>();
  for (const wall of project.barriers) {
    for (const [from, to] of [
      [wall.startId, wall.endId],
      [wall.endId, wall.startId],
    ]) {
      const a = positions.get(from),
        b = positions.get(to);
      if (!a || !b) continue;
      const length = distance(a, b);
      if (length < 1e-9) continue;
      const direction: Point = [(b[0] - a[0]) / length, (b[1] - a[1]) / length];
      const rays = meeting.get(from) ?? [];
      rays.push({ wall, direction, length, angle: Math.atan2(direction[1], direction[0]) });
      meeting.set(from, rays);
    }
  }
  const ends = new Map<string, { left: Point; right: Point }>();
  for (const [id, rays] of meeting) {
    rays.sort((a, b) => a.angle - b.angle);
    const origin = positions.get(id)!;
    const absolute = (p: Point): Point => [origin[0] + p[0], origin[1] + p[1]];
    // Each wedge has the left face of one ray and the right face of the next ray.
    const corners = rays.map((ray, i): Point => {
      const next = rays[(i + 1) % rays.length];
      const a = offset(ray, 1),
        b = offset(next, -1);
      const denominator = cross(ray.direction, next.direction);
      const halfway: Point = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      if (Math.abs(denominator) < 1e-6) return absolute(halfway);
      const t = cross([b[0] - a[0], b[1] - a[1]], next.direction) / denominator;
      const at: Point = [a[0] + ray.direction[0] * t, a[1] + ray.direction[1] * t];
      // Bound mitres at nearly parallel branches and on tiny returns. A shared bevel point
      // prevents spikes and inverted pieces while preserving one join for both participants.
      const limit = Math.min(
        4 * Math.max(ray.wall.thickness, next.wall.thickness),
        Math.min(ray.length, next.length) * 0.45,
      );
      return absolute(Math.hypot(...at) <= limit ? at : halfway);
    });
    for (let i = 0; i < rays.length; i++) {
      const ray = rays[i];
      ends.set(
        `${id}:${ray.wall.id}`,
        rays.length === 1
          ? { left: absolute(offset(ray, 1)), right: absolute(offset(ray, -1)) }
          : { left: corners[i], right: corners[(i + rays.length - 1) % rays.length] },
      );
    }
  }
  const result = new Map<string, Ring>();
  for (const wall of project.barriers) {
    const a = ends.get(`${wall.startId}:${wall.id}`),
      b = ends.get(`${wall.endId}:${wall.id}`);
    if (a && b) result.set(wall.id, [a.right, b.left, b.right, a.left]);
  }
  return result;
}

/** Cut an opening across the joined footprint, retaining the mitres on the wall's outside ends. */
export function wallSpan(ring: Ring, origin: Point, direction: Point, start: number | null, end: number | null): Ring {
  let result = ring;
  for (const [bound, sign] of [
    [start, 1],
    [end, -1],
  ] as const) {
    if (bound === null) continue;
    const next: Ring = [];
    const signed = (p: Point) => ((p[0] - origin[0]) * direction[0] + (p[1] - origin[1]) * direction[1] - bound) * sign;
    for (let i = 0; i < result.length; i++) {
      const a = result[i],
        b = result[(i + 1) % result.length],
        da = signed(a),
        db = signed(b);
      if (da >= 0) next.push(a);
      if (da >= 0 !== db >= 0) {
        const t = da / (da - db);
        next.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
      }
    }
    result = next;
  }
  return result;
}
