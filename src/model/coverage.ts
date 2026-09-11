// What a camera can see, read off the plan.
//
// A camera carries a facing, a reach and a field of view, and the plan already says where the walls
// and the rooms are — so which spaces and doorways fall inside that cone is a computation, not
// something anyone should be typing in by hand. `watchedIds` is the field it lands in; the library
// never interprets it, and what a host does with "this camera covers that door" is its own business.
//
// Deliberately coarse in one respect: a space counts by its centre, so a long corridor whose middle
// is out of reach does not count even though its near end is visible. Naming the rule is better than
// a partial-visibility fraction nobody can check by eye.
import { barrierEnds, distance, objectPosition, pointInRing, segmentsCross } from './geometry';
import { isOpening, isSpace, type ProjectDocument, type SiteObject } from './types';

export const DEFAULT_RANGE = 12;
export const DEFAULT_FOV = 70;

/** Ids of the spaces and openings inside `camera`'s cone with an unobstructed line to it.
 *
 *  Sightlines stop at walls, with one exception: the opening being tested is itself a hole in the
 *  wall it sits on, so that wall cannot be what hides it. */
export function coverageOf(project: ProjectDocument, camera: SiteObject): string[] {
  const range = camera.coverageRange ?? DEFAULT_RANGE;
  const half = (camera.coverageAngle ?? DEFAULT_FOV) / 2;
  const from = objectPosition(project, camera);
  const facing = camera.rotation ?? 0;
  const walls = project.barriers.filter(b => b.floorId === camera.floorId);
  const ends = new Map(walls.map(b => [b.id, barrierEnds(project, b)]));
  const seen: string[] = [];
  for (const o of project.objects) {
    if (o.id === camera.id || o.floorId !== camera.floorId) continue;
    if (!isSpace(o.kind) && !isOpening(o.kind)) continue;
    // The room the camera stands in is covered whatever the cone says — the camera is inside it,
    // and its centre may well be behind the lens.
    if (o.rings?.length && pointInRing(from, o.rings[0])) {
      seen.push(o.id);
      continue;
    }
    const to = objectPosition(project, o);
    const reach = distance(from, to);
    if (reach < 0.01 || reach > range) continue;
    const bearing = (Math.atan2(to[1] - from[1], to[0] - from[0]) * 180) / Math.PI;
    const off = Math.abs(((((bearing - facing) % 360) + 540) % 360) - 180);
    if (off > half) continue;
    const blocked = walls.some(b => {
      if (b.id === o.barrierId) return false; // the opening is the hole in this wall
      const [p, q] = ends.get(b.id)!;
      return segmentsCross(from, to, p, q);
    });
    if (!blocked) seen.push(o.id);
  }
  return seen;
}
