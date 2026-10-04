import polygonClipping from 'polygon-clipping';
import { closeRing } from '../model/geometry';
import { rampFloors } from '../model/ramps';
import type { Point, ProjectDocument, Ring, Slope } from '../model/types';

/** Clip in the slope's local frame. Clipping, rather than moving existing corner vertices, inserts
 * the break lines where an incline meets its flat aprons, including concave outlines and holes. */
export function rampBand(rings: Ring[], slope: Slope, from: number, to: number): Ring[][] {
  const [a, b] = slope.axis;
  const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (length < 1e-8 || !rings.length) return [];
  const ux = (b[0] - a[0]) / length,
    uy = (b[1] - a[1]) / length;
  const reach = Math.max(length, ...rings.flat().map(p => Math.hypot(p[0] - a[0], p[1] - a[1]))) + 1;
  const lo = Math.max(-reach, from * length),
    hi = Math.min(reach, to * length);
  if (hi <= lo) return [];
  const at = (x: number, y: number): Point => [a[0] + ux * x - uy * y, a[1] + uy * x + ux * y];
  return polygonClipping.intersection(rings.map(closeRing), [
    closeRing([at(lo, -reach), at(hi, -reach), at(hi, reach), at(lo, reach)]),
  ]) as Ring[][];
}

export const rampSections = (rings: Ring[], slope: Slope) =>
  [
    [-Infinity, 0],
    [0, 1],
    [1, Infinity],
  ].flatMap(([a, b]) => rampBand(rings, slope, a, b));

/** A descending ramp replaces the upper floor. The ceiling below also needs an opening wherever
 * the ramp comes within head height. Arrival aprons stay supported by their lower deck. */
export function rampVoids(project: ProjectDocument, floorId: string, through: 'floor' | 'ceiling' = 'floor'): Ring[] {
  const level = project.floors.find(f => f.id === floorId);
  if (!level) return [];
  return project.objects.flatMap(o => {
    if (!o.slope || !o.rings?.length) return [];
    const { low, high } = rampFloors(project, o);
    if (through === 'floor') return high?.id === floorId && o.floorId === floorId ? [closeRing(o.rings[0])] : [];
    if (low?.id !== floorId) return [];
    const rise = o.slope.high - o.slope.low;
    if (rise <= 0) return [];
    // Include slab thickness and finish offsets in addition to standing headroom.
    const end = (rise - level.height + 2.4) / rise;
    return rampBand(o.rings, o.slope, -Infinity, Math.min(1, end)).map(pg => pg[0]);
  });
}
