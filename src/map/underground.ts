import polygonClipping from 'polygon-clipping';
import type { Floor, Point, ProjectDocument, Ring, SiteObject } from '../model/types';
import { closeRing, openRing, pointInRing, ringArea } from '../model/geometry';
import { floorOutline } from '../model/walls';
import { isVertical, primaryShafts, servedFloors } from '../model/vertical';

export const DEPTH_CAP = 96;
const SHALLOW_DEPTH = 24;
export const MAX_CAGE_LEVELS = 32;

/** The camera, model, overlays and depth label must use the same presentation transform. */
export function undergroundView(project: ProjectDocument, floorId: string | null, stack: boolean) {
  const active = project.floors.find(f => f.id === floorId);
  const levels = active ? project.floors.filter(f => f.buildingId === active.buildingId) : project.floors;
  const buried = (active?.elevation ?? 0) < 0 || (stack && levels.length > 0 && levels.every(f => f.elevation < 0));
  const deepest = levels.reduce((z, f) => Math.min(z, f.elevation), 0);
  // One building-wide mapping in both modes: selecting L50 must not reset it to the same
  // displayed depth as L100. Preserve shallow basements; compress only the deeper shaft.
  const depthScale = buried && deepest < -DEPTH_CAP ? (DEPTH_CAP - SHALLOW_DEPTH) / (-deepest - SHALLOW_DEPTH) : 1;
  const elevation = (z: number) =>
    buried && z < -SHALLOW_DEPTH ? -SHALLOW_DEPTH + (z + SHALLOW_DEPTH) * depthScale : z;
  const focusElevation = elevation(active?.elevation ?? 0);
  const compressed = depthScale < 1 && (stack || (active?.elevation ?? 0) < -SHALLOW_DEPTH);
  return { active, levels, buried, depthScale, elevation, focusElevation, compressed };
}
export type UndergroundView = ReturnType<typeof undergroundView>;

/** The excavated volume's plan outline(s). A below-grade complex is rarely just the tower footprint:
 * parking decks sprawl past it and driveway ramps reach out to the street. Scoping the pit to a single
 * floor plate left everything beyond it hanging in open air, so union the plates of every below-grade
 * level with the footprints of any ramps (which are few, and are what actually reach the surface).
 * Returns one outline per disjoint excavation; empty when there is nothing below ground. */
export function excavationRings(project: ProjectDocument, levels: Floor[]): Point[][] {
  const index = floorIndex(project);
  const below = levels.filter(f => f.elevation < 0);
  const polygons: Ring[][] = [];
  for (const f of below) {
    // The floor's whole footprint, not its biggest room. `outlines` picks the single largest area on
    // a level, which is the floor plate on a document drawn as one zone per storey — and is one room
    // among several on an imported one. The pit was then dug under part of the basement and stopped
    // in the middle of it, leaving the rest of the storey hanging in the air with a cut edge running
    // through the building.
    //
    // Merged per level first. A garage deck is one plate and three hundred bays drawn as zones on
    // it, and one union of every ring on every level is the input polygon-clipping's sweep line
    // gives up on — after which the old fallback dug a thousand pits, one per bay, and stacked them
    // up through every buried storey as a forest of translucent walls. A level's own rings are
    // few enough to merge, and anything left inside a bigger ring is dropped either way.
    const own: Ring[][] = [];
    for (const ring of floorOutline(project, f.id)) own.push([closeRing(ring)]);
    for (const o of index.objects.get(f.id) ?? []) if (o.slope && o.rings) own.push([closeRing(o.rings[0])]);
    for (const ring of merge(own)) polygons.push([closeRing(ring)]);
  }
  if (!polygons.length) return [];
  return merge(polygons);
}

/** Union polygons into their outer rings — a courtyard void in a plate is still excavated ground
 *  around the shaft — and, when the clipper cannot, keep only the rings that are not inside another. */
function merge(polygons: Ring[][]): Point[][] {
  if (!polygons.length) return [];
  let outer: Point[][];
  try {
    outer = (polygonClipping.union(polygons[0], ...polygons.slice(1)) as unknown as Ring[][]).map(pg =>
      openRing(pg[0]),
    );
  } catch {
    outer = polygons.map(pg => openRing(pg[0]));
  }
  return dropContained(outer);
}

/** Rings that lie wholly inside another ring in the list add nothing to an excavation outline. */
export function dropContained(rings: Point[][]): Point[][] {
  const byArea = rings
    .map(ring => ({ ring, area: ringArea(ring) }))
    .filter(r => r.area > 1e-6)
    .sort((a, b) => b.area - a.area);
  const kept: { ring: Point[]; area: number }[] = [];
  for (const candidate of byArea) {
    if (kept.some(k => candidate.ring.every(pt => pointInRing(pt, k.ring)))) continue;
    kept.push(candidate);
  }
  return kept.map(k => k.ring);
}

interface FloorIndex {
  floors: Map<string, Floor>;
  objects: Map<string | null, SiteObject[]>;
  outlines: Map<string, SiteObject>;
  /** Ids of the objects that stand for their shaft — see primaryShafts. Anything vertical NOT in
   *  here is a twin of one that is, and is left to it to draw. */
  primary: Set<string>;
  /** Shafts that reach a floor without being filed under it. A stair lives on one storey and climbs
   *  to another, and the storey it arrives at has to draw it or the flight appears to come from
   *  nowhere — which is exactly what it did. Kept apart from `objects` so that everything already
   *  counting a floor's own objects keeps counting the same ones. */
  reaching: Map<string, SiteObject[]>;
}
const indices = new WeakMap<ProjectDocument, FloorIndex>();

/** Project documents are immutable between edits. Floor navigation reuses this index. */
export function floorIndex(project: ProjectDocument): FloorIndex {
  const cached = indices.get(project);
  if (cached) return cached;
  const floors = new Map(project.floors.map(f => [f.id, f]));
  // Twins of one shaft draw once, from the lowest of them; the rest are the same lift seen again.
  const primary = primaryShafts(project);
  const objects = new Map<string | null, SiteObject[]>(),
    outlines = new Map<string, SiteObject>(),
    reaching = new Map<string, SiteObject[]>();
  for (const object of project.objects) {
    const group = objects.get(object.floorId) ?? [];
    group.push(object);
    objects.set(object.floorId, group);
    if (isVertical(object.kind) && primary.has(object.id))
      for (const f of servedFloors(project, object)) {
        if (f.id === object.floorId) continue;
        const arriving = reaching.get(f.id) ?? [];
        arriving.push(object);
        reaching.set(f.id, arriving);
      }
    if (object.floorId === null || !object.rings || !['zone', 'room'].includes(object.kind)) continue;
    const previous = outlines.get(object.floorId);
    if (
      !previous ||
      (object.kind === 'zone' && previous.kind !== 'zone') ||
      (object.kind === previous.kind && ringArea(object.rings[0]) > ringArea(previous.rings![0]))
    )
      outlines.set(object.floorId, object);
  }
  const result = { floors, objects, outlines, reaching, primary };
  indices.set(project, result);
  return result;
}
