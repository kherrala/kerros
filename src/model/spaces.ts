// Space queries: which objects are places, and which place a point is in. A space is somewhere you
// can stand — the ringed area objects already on the plan, plus lifts and stairs — and everything
// the ontology says is said about these, so the questions "what counts?" and "where am I?" sit
// here, beneath both the described layer (ontology.ts) and the derived one (topology.ts).
import { centroid, footprint, objectArea, objectPosition, pointInRing } from './geometry';
import { isSpace, type Point, type ProjectDocument, type SiteObject } from './types';

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
