import type { Point, ProjectDocument, Ring, SiteObject } from '../model/types';
import { objectArea, pointInRing } from '../model/geometry';
import { spacePoint } from '../model/spaces';
import { wallPieces } from './features';
import { wallFootprints } from './wallJoins';
import { HEAD_ROOM } from './walkDimensions';

const contains = (o: SiteObject, at: Point) =>
  !!o.rings?.length && pointInRing(at, o.rings[0]) && !o.rings.slice(1).some(hole => pointInRing(at, hole));

/** Evaluate wall solids in absolute building heights. A host wall may continue through a
 * mezzanine, while a low partition below it and a lintel overhead do not obstruct the walker. */
export function walkingWallRings(project: ProjectDocument, floorId: string | null): Ring[] {
  const active = project.floors.find(f => f.id === floorId);
  const floors = new Map(project.floors.map(f => [f.id, f]));
  const foot = active?.elevation ?? 0;
  return wallPieces(project, null, true)
    .filter(piece => {
      const floor = floors.get(piece.floorId ?? '');
      const relevant = active
        ? floor?.buildingId === active.buildingId || (piece.floorId === null && active.elevation >= 0)
        : piece.floorId === null;
      return relevant && piece.base < foot + HEAD_ROOM && piece.height > foot + 0.01;
    })
    .map(piece => piece.ring);
}

/** Build the support lookup when geometry changes, not for every walking frame. Open-air grade
 * and floors without authored plates stay traversable. Higher and buried plates have real edges. */
export function floorSupport(project: ProjectDocument) {
  const floors = new Map(project.floors.map(f => [f.id, f]));
  const areas = new Map<string | null, SiteObject[]>();
  for (const o of project.objects) {
    if ((o.kind !== 'room' && o.kind !== 'zone') || !o.rings?.length) continue;
    const own = areas.get(o.floorId) ?? [];
    own.push(o);
    areas.set(o.floorId, own);
  }
  // Rooms may end at the inner wall face. The slab beneath a wall also supports its doorway;
  // otherwise a valid room-to-room threshold would look like a narrow unsupported gap.
  const thresholds = new Map<string | null, Ring[]>();
  const footprints = wallFootprints(project);
  for (const wall of project.barriers) {
    const ring = footprints.get(wall.id);
    if (!ring) continue;
    const own = thresholds.get(wall.floorId) ?? [];
    own.push(ring);
    thresholds.set(wall.floorId, own);
  }
  const solid = (at: Point, id: string | null) =>
    (areas.get(id) ?? []).some(o => contains(o, at)) || (thresholds.get(id) ?? []).some(ring => pointInRing(at, ring));
  const hole = (at: Point, id: string | null) =>
    (areas.get(id) ?? []).some(o => !o.slope && o.rings!.slice(1).some(ring => pointInRing(at, ring)));
  const lower = new Map(
    project.floors.map(f => [
      f.id,
      project.floors
        .filter(b => b.buildingId === f.buildingId && b.elevation < f.elevation - 0.01)
        .sort((a, b) => b.elevation - a.elevation),
    ]),
  );
  const dropAt = (at: Point, id: string | null) => {
    const floor = floors.get(id ?? '');
    if (!floor || solid(at, id) || !hole(at, id)) return;
    const below = lower.get(floor.id)?.find(f => solid(at, f.id));
    return below ? { floorId: below.id, distance: floor.elevation - below.elevation } : undefined;
  };
  const supports = (at: Point, id: string | null): boolean => {
    const floor = floors.get(id ?? '');
    if (!floor || !areas.get(id)?.length || solid(at, id)) return true;
    if (hole(at, id)) return !!dropAt(at, id);
    // An exposed gallery edge is not an authored opening. At grade, the surrounding ground
    // supports an exit from the building; in the air or an excavation, keep the last supported point.
    return Math.abs(floor.elevation) < 0.01;
  };
  return { supports, dropAt };
}

/** Clip a small walking step at the last supported point; never snap it onto another island. */
export function supportedStep(from: Point, to: Point, supports: (at: Point) => boolean): Point {
  if (supports(to)) return to;
  if (!supports(from)) return from;
  let low = 0,
    high = 1;
  for (let i = 0; i < 16; i++) {
    const t = (low + high) / 2;
    const at: Point = [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t];
    if (supports(at)) low = t;
    else high = t;
  }
  return [from[0] + (to[0] - from[0]) * low, from[1] + (to[1] - from[1]) * low];
}

/** Keep a valid position across storeys, including a fall's landing. A floor picker can instead
 * select a smaller footprint: enter it at a dry navigation point, not in the void outside it. */
export function floorArrival(project: ProjectDocument, floorId: string | null, at: Point): Point {
  if (!floorId) return at;
  const rooms = project.objects.filter(o => o.floorId === floorId && (o.kind === 'room' || o.kind === 'zone'));
  if (rooms.some(o => contains(o, at))) return at;
  const pools = project.objects.filter(o => o.floorId === floorId && o.water);
  const dry = (p: Point) => rooms.some(o => contains(o, p)) && !pools.some(o => contains(o, p));
  const node = project.navNodes?.find(n => n.floorId === floorId && dry(n.position));
  if (node) return node.position;
  for (const room of rooms.sort((a, b) => objectArea(b) - objectArea(a))) {
    const point = spacePoint(project, room);
    if (dry(point)) return point;
  }
  return at;
}

/** Only authored openings trigger a drop. Gaps outside the building, an undrawn floor, and
 * overlapping areas that still provide a slab are not floor holes. */
export function floorDropAt(project: ProjectDocument, floorId: string | null, at: Point) {
  return floorSupport(project).dropAt(at, floorId);
}

/** Rooms which span the active storey bring the geometry inside their footprint along with them.
 * The same context supplies the lower plate seen through an opening and the gallery seen from below. */
export function tallSpaceContext(project: ProjectDocument, floorId: string | null): SiteObject[] {
  const active = project.floors.find(f => f.id === floorId);
  if (!active) return [];
  const floors = new Map(project.floors.map(f => [f.id, f]));
  const halls = project.objects.filter(o => {
    const floor = floors.get(o.floorId ?? '');
    return (
      floor?.buildingId === active.buildingId &&
      o.rings?.length &&
      o.ceilingHeight &&
      o.ceilingHeight > floor.height + 0.01 &&
      floor.elevation <= active.elevation &&
      floor.elevation + o.ceilingHeight > active.elevation
    );
  });
  return project.objects.filter(o => {
    if (o.floorId === floorId) return false;
    const floor = floors.get(o.floorId ?? '');
    return (
      floor?.buildingId === active.buildingId &&
      halls.some(hall => {
        const base = floors.get(hall.floorId!)!.elevation;
        return (
          floor.elevation >= base &&
          floor.elevation < base + hall.ceilingHeight! &&
          pointInRing(o.position, hall.rings![0])
        );
      })
    );
  });
}
