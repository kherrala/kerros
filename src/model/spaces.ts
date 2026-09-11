// Space queries: which objects are places, and which place a point is in. A space is somewhere you
// can stand — the ringed area objects already on the plan, plus lifts and stairs — and everything
// the ontology says is said about these, so the questions "what counts?" and "where am I?" sit
// here, beneath both the described layer (ontology.ts) and the derived one (topology.ts).
import polygonClipping from 'polygon-clipping';
import {
  barrierEnds,
  centroid,
  closeRing,
  distance,
  footprint,
  objectArea,
  objectPosition,
  openRing,
  pointInRing,
  rectangle,
} from './geometry';
import { isSpace, type Point, type ProjectDocument, type Ring, type SiteObject } from './types';

/** The enclosed region a point stands in, read off the walls around it.
 *
 *  A floor's open area is its extent minus the bodies of its walls, and that difference falls apart
 *  into exactly the regions the walls divide it into — so the room under a click is whichever of
 *  those contains the click. No tracing, no flood fill, no tolerance to tune: the walls say where
 *  the rooms are, and this reads the answer.
 *
 *  Doorways do not leak, because a door is an object ON a continuous wall rather than a hole in the
 *  run of it. A doorless passage does leak, and should: the drawing said those two places flow into
 *  one another. Returns null when the point is not enclosed — outside the building, or inside a
 *  boundary with a gap in it, where the region reaches the edge of the extent. */
export function enclosedRegion(project: ProjectDocument, floorId: string | null, point: Point): Ring | null {
  for (const ring of enclosedRegions(project, floorId)) if (pointInRing(point, ring)) return ring;
  return null;
}

/** Every enclosed region on a floor, largest first.
 *
 *  The same difference as `enclosedRegion`, read whole rather than probed: one subtraction gives all
 *  the rooms the walls describe. Regions touching the extent are open to the outside and dropped,
 *  and slivers below `minArea` — the gap between two walls that nearly meet — with them. */
export function enclosedRegions(project: ProjectDocument, floorId: string | null, minArea = 1): Ring[] {
  const walls = project.barriers.filter(b => b.floorId === floorId);
  if (!walls.length) return [];
  const corners: Point[] = walls.flatMap(b => barrierEnds(project, b) as unknown as Point[]);
  const pad = 2;
  const x0 = Math.min(...corners.map(p => p[0])) - pad,
    x1 = Math.max(...corners.map(p => p[0])) + pad,
    y0 = Math.min(...corners.map(p => p[1])) - pad,
    y1 = Math.max(...corners.map(p => p[1])) + pad;
  const extent: Ring = [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
    [x0, y0],
  ];
  // Each wall as a solid: its centreline swept by its thickness, run on by half a thickness at each
  // end so corners close and no region leaks through the notch between two walls that meet.
  const solids = walls.map(b => {
    const [a, c] = barrierEnds(project, b);
    const len = distance(a, c) || 0.001;
    const angle = (Math.atan2(c[1] - a[1], c[0] - a[0]) * 180) / Math.PI;
    const mid: Point = [(a[0] + c[0]) / 2, (a[1] + c[1]) / 2];
    return [closeRing(rectangle(mid, len + b.thickness, b.thickness, angle))];
  });
  let open: Ring[][];
  try {
    open = polygonClipping.difference([extent], ...solids) as unknown as Ring[][];
  } catch {
    return []; // degenerate walls: no answer is better than a wrong one
  }
  const area = (ring: Ring) =>
    Math.abs(
      ring.reduce((sum, q, i) => {
        const r = ring[(i + 1) % ring.length];
        return sum + q[0] * r[1] - r[0] * q[1];
      }, 0) / 2,
    );
  // Clipping leaves vertices the document will not hold: a point repeated where two solids met, and
  // the collinear ones left along a straight edge that was cut and rejoined.
  const tidy = (ring: Ring): Ring => {
    const out: Ring = [];
    for (const q of ring) if (!out.length || distance(out[out.length - 1], q) > 1e-6) out.push(q);
    if (out.length > 1 && distance(out[0], out[out.length - 1]) <= 1e-6) out.pop();
    const straight: Ring = [];
    for (let i = 0; i < out.length; i++) {
      const prev = out[(i + out.length - 1) % out.length],
        here = out[i],
        next = out[(i + 1) % out.length];
      const cross = (here[0] - prev[0]) * (next[1] - prev[1]) - (here[1] - prev[1]) * (next[0] - prev[0]);
      if (Math.abs(cross) > 1e-7) straight.push(here);
    }
    return straight.length >= 3 ? straight : out;
  };
  return open
    .filter(pg => !pg[0].some(q => q[0] <= x0 + 1e-6 || q[0] >= x1 - 1e-6 || q[1] <= y0 + 1e-6 || q[1] >= y1 - 1e-6))
    .map(pg => tidy(openRing(pg[0])))
    .filter(ring => ring.length >= 3 && area(ring) >= minArea)
    .sort((a, b) => area(b) - area(a));
}

/** Spaces are objects you can stand in — the areas already in the document, plus lifts and stairs.
 *  Nothing new is stored for them: a room *is* a space, and zones and portals reference it by id. */
export const spaces = (project: ProjectDocument): SiteObject[] => project.objects.filter(o => isSpace(o.kind));

/** Where a space sits for routing. Its footprint's centroid, falling back to its placed position. */
export function spacePoint(project: ProjectDocument, space: SiteObject): Point {
  const ring = footprint(space)[0];
  return ring?.length ? centroid(ring) : objectPosition(project, space);
}

/** True when `point` falls inside a space's footprint — inside its outline and outside its holes. */
export function inSpace(space: SiteObject, point: Point): boolean {
  const [outline, ...holes] = footprint(space);
  return !!outline && pointInRing(point, outline) && !holes.some(hole => pointInRing(point, hole));
}

/** The space a point falls in: the *smallest* one containing it, since a room inside a zone inside a
 *  floor plate are all true and only the innermost is useful. */
export function spaceAt(project: ProjectDocument, floorId: string | null, point: Point): SiteObject | null {
  let best: SiteObject | null = null,
    bestArea = Number.POSITIVE_INFINITY;
  for (const space of project.objects) {
    if (space.floorId !== floorId || !isSpace(space.kind) || !inSpace(space, point)) continue;
    const area = objectArea(space);
    if (area >= bestArea) continue;
    bestArea = area;
    best = space;
  }
  return best;
}
