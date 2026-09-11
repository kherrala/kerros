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
  ringArea,
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
  // The SMALLEST region containing the point, as spaceAt picks the smallest space: a walled island
  // — a sauna in a bathroom, a WC off a hall, a lift core in a lobby — sits inside the region around
  // it, and both contain a click in the island. The island is the one that was clicked.
  let best: Ring | null = null;
  for (const ring of enclosedRegions(project, floorId))
    if (pointInRing(point, ring) && (!best || Math.abs(ringArea(ring)) < Math.abs(ringArea(best)))) best = ring;
  return best;
}

/** Every enclosed region on a floor, largest first.
 *
 *  Outer rings only: a region with a walled island inside it comes back with the island filled in,
 *  so its area overstates the floor you could stand on by the island's footprint. Carrying the holes
 *  through as further rings is the complete answer and changes this signature; until then the island
 *  is its own region in the list, and enclosedRegion returns it for a click inside it.
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
    // 0.1 mm: finer than anything a floor plan means, coarse enough to swallow the near-duplicate a
    // clipped corner leaves behind. The document refuses a ring with repeated vertices.
    const EPS = 1e-4;
    const out: Ring = [];
    for (const q of ring) if (!out.length || distance(out[out.length - 1], q) > EPS) out.push(q);
    if (out.length > 1 && distance(out[0], out[out.length - 1]) <= EPS) out.pop();
    const straight: Ring = [];
    for (let i = 0; i < out.length; i++) {
      const prev = out[(i + out.length - 1) % out.length],
        here = out[i],
        next = out[(i + 1) % out.length];
      const ax = here[0] - prev[0],
        ay = here[1] - prev[1],
        bx = next[0] - here[0],
        by = next[1] - here[1];
      // The SINE of the turn, not the raw cross product: a cross product scales with the product of
      // the edge lengths, so a fixed threshold on it means something different on a 0.1 m edge than
      // on a 20 m one, and long collinear edges survive a cut-and-rejoin as false corners.
      const sine = Math.abs(ax * by - ay * bx) / (Math.hypot(ax, ay) * Math.hypot(bx, by) || 1);
      if (sine > 1e-4) straight.push(here);
    }
    return straight.length >= 3 ? straight : out;
  };
  return open
    .filter(pg => !pg[0].some(q => q[0] <= x0 + 1e-6 || q[0] >= x1 - 1e-6 || q[1] <= y0 + 1e-6 || q[1] >= y1 - 1e-6))
    .map(pg => tidy(openRing(pg[0])))
    .filter(ring => ring.length >= 3 && area(ring) >= minArea)
    .sort((a, b) => area(b) - area(a));
}

/** Re-fit the rooms that the walls were defining, after those walls have moved.
 *
 *  A room stores its own outline, which is what lets a space exist where no wall does — a zone over
 *  an open floor, a parcel, an area someone drew freehand. The cost is that moving a wall used to
 *  leave the room it bounded exactly where it was, so the two drifted apart and had to be kept in
 *  step by hand.
 *
 *  They do not have to be. Pass the regions as they stood BEFORE the edit: a room whose outline was
 *  one of them was being defined by the walls, so it takes the region that now stands in its place.
 *  A room that matched nothing was drawn rather than enclosed, and is left alone. Identity is never
 *  touched — the name, colour, bindings and id are the room; only its shape came from the walls. */
export function refitEnclosedRooms(project: ProjectDocument, floorId: string | null, before: Ring[]): number {
  if (!before.length) return 0;
  const after = enclosedRegions(project, floorId);
  // How much two outlines are the same outline. Overlap rather than centroid-in-ring: an L-shaped
  // room has its centroid outside itself, and a containment test quietly fails to match every such
  // room — of which a building with a bay or a wing has several.
  const sameness = (one: Ring, two: Ring) => {
    try {
      const inter = polygonClipping.intersection([closeRing(one)], [closeRing(two)]) as unknown as Ring[][];
      const union = polygonClipping.union([closeRing(one)], [closeRing(two)]) as unknown as Ring[][];
      const sum = (pg: Ring[][]) => pg.reduce((t, poly) => t + Math.abs(ringArea(poly[0])), 0);
      const u = sum(union);
      return u > 0 ? sum(inter) / u : 0;
    } catch {
      return 0;
    }
  };
  const matches = (ring: Ring, pool: Ring[]) => pool.find(r => sameness(ring, r) > 0.95);
  // Work out every room's claim first, then apply only the claims that are unambiguous. Removing a
  // wall merges two regions into one, and both of the rooms it separated then point at that same
  // region: growing both to fill it would draw two rooms over each other. Two claims on one region
  // means the edit changed what the rooms ARE, not merely their shape, and that is a question for
  // whoever made the edit — mergeSpaces, or leaving them be — not for a re-fit to answer.
  const claims: { room: SiteObject; ring: Ring }[] = [];
  for (const room of project.objects) {
    if (room.floorId !== floorId || room.kind !== 'room' || !room.rings?.length) continue;
    if (!matches(room.rings[0], before)) continue; // drawn, not enclosed — leave it be
    // The region that best stands where this room stood. Best overlap, not containment, for the
    // same concave reason.
    const now = after
      .map(r => ({ r, score: sameness(room.rings![0], r) }))
      .filter(x => x.score > 0.2)
      .sort((a, b) => b.score - a.score)[0]?.r;
    if (!now) continue; // its walls no longer enclose anything; keep the last good shape
    claims.push({ room, ring: now });
  }
  let refitted = 0;
  for (const { room, ring } of claims) {
    if (claims.some(other => other.room !== room && other.ring === ring)) continue; // contested
    // Holes are carried across untouched. A wall that bounded a courtyard rather than the room's
    // outside leaves its hole stale; rare enough to name rather than solve.
    const holes = room.rings!.slice(1);
    room.rings = [closeRing(ring), ...holes];
    room.position = centroid(ring);
    const xs = ring.map(p => p[0]),
      ys = ring.map(p => p[1]);
    room.width = Math.max(...xs) - Math.min(...xs);
    room.depth = Math.max(...ys) - Math.min(...ys);
    refitted++;
  }
  return refitted;
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
