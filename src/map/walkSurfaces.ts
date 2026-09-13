import type { Point, ProjectDocument, SiteObject } from '../model/types';
import { pointInRing } from '../model/geometry';

const contains = (o: SiteObject, at: Point) =>
  !!o.rings?.length && pointInRing(at, o.rings[0]) && !o.rings.slice(1).some(hole => pointInRing(at, hole));

/** Only authored openings trigger a drop. Gaps outside the building, an undrawn floor, and
 * overlapping areas that still provide a slab are not floor holes. */
export function floorDropAt(project: ProjectDocument, floorId: string | null, at: Point) {
  const floor = project.floors.find(f => f.id === floorId);
  if (!floor) return;
  const spaces = project.objects.filter(o => (o.kind === 'room' || o.kind === 'zone') && o.rings?.length && !o.slope);
  const own = spaces.filter(o => o.floorId === floorId);
  if (own.some(o => contains(o, at)) || !own.some(o => o.rings!.slice(1).some(hole => pointInRing(at, hole)))) return;
  const below = project.floors
    .filter(f => f.buildingId === floor.buildingId && f.elevation < floor.elevation - 0.01)
    .sort((a, b) => b.elevation - a.elevation)
    .find(f => spaces.some(o => o.floorId === f.id && contains(o, at)));
  return below ? { floorId: below.id, distance: floor.elevation - below.elevation } : undefined;
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
