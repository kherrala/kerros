import { centroid, pointInRing, ringArea } from '../model/geometry';
import type { Floor, ProjectDocument, Ring, SiteObject } from '../model/types';
import { flights, primaryShafts } from '../model/vertical';
import { rampFloors } from '../model/ramps';

/** Build the structural surroundings of both landings before a passenger starts climbing.
 * The selected floor remains the walking datum; these levels only supply visible context. */
export function walkConnectionContext(project: ProjectDocument, active: Floor, primary = primaryShafts(project)) {
  const levels = new Map<string, Floor>();
  for (const o of project.objects) {
    const pairs =
      o.kind === 'stairs' && primary.has(o.id)
        ? flights(project, o).map(f => [f.from, f.to])
        : o.slope
          ? [Object.values(rampFloors(project, o))]
          : [];
    for (const pair of pairs) {
      if (!pair.some(f => f?.id === active.id)) continue;
      for (const f of pair) if (f && f.id !== active.id) levels.set(f.id, f);
    }
  }
  return [...levels.values()];
}

/** Structural storeys seen through an authored atrium. Stops at a plate that closes the opening;
 * room fit-out is deliberately left on its own floor. A room nested in a zone adds no new void. */
export function walkVoidContext(project: ProjectDocument, active: Floor, ceilingFloor: Floor) {
  const levels = project.floors
    .filter(f => f.buildingId === active.buildingId)
    .sort((a, b) => a.elevation - b.elevation);
  const areas = new Map<string, SiteObject[]>();
  for (const floor of levels) {
    const own = project.objects.filter(o => o.floorId === floor.id && o.rings?.length && !o.slope);
    const zones = own.filter(o => o.kind === 'zone' && !o.parentId);
    areas.set(floor.id, zones.length ? zones : own.filter(o => o.kind === 'room'));
  }
  const covers = (floor: Floor, ring: Ring) => {
    const at = centroid(ring);
    return (areas.get(floor.id) ?? []).some(
      o => pointInRing(at, o.rings![0]) && !o.rings!.slice(1).some(h => pointInRing(at, h)),
    );
  };
  const holes = (floor: Floor) =>
    (areas.get(floor.id) ?? []).flatMap(o => o.rings!.slice(1)).filter(r => ringArea(r) > 0.01 && !covers(floor, r));
  const above = levels.filter(f => f.elevation >= ceilingFloor.elevation + ceilingFloor.height - 0.01);
  const ceilingOpenings = above.length ? holes(above[0]) : [];
  const ownOpenings = holes(active),
    upper = [...ownOpenings, ...ceilingOpenings];
  const context: Floor[] = [];
  let pending = upper;
  for (const floor of above) {
    if (!pending.length) break;
    context.push(floor);
    pending = pending.filter(r => !covers(floor, r));
  }
  const roof = pending.length ? context.at(-1) : undefined;
  pending = ownOpenings;
  for (const floor of levels.filter(f => f.elevation < active.elevation).reverse()) {
    if (!pending.length) break;
    context.push(floor);
    pending = pending.filter(r => !covers(floor, r));
  }
  return { levels: context, roof, ceilingOpenings };
}
