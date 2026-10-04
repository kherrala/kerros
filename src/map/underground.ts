import type { Floor, ProjectDocument, SiteObject } from '../model/types';
import { ringArea } from '../model/geometry';
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
