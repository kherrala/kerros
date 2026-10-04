import type { ProjectDocument, SiteObject } from './types';

export const rampJoins = (o: SiteObject, elevation: number) =>
  !!o.slope && [o.slope.low, o.slope.high].some(end => Math.abs(end - elevation) < 0.01);

/** Only the end levels in the ramp's building are connected, never a storey it passes through. */
export function rampFloors(project: ProjectDocument, o: SiteObject) {
  const own = project.floors.find(f => f.id === o.floorId);
  const end = (height: number) =>
    project.floors.find(f => f.buildingId === own?.buildingId && Math.abs(f.elevation - height) < 0.01);
  return { low: o.slope && end(o.slope.low), high: o.slope && end(o.slope.high) };
}
