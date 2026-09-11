import type { ProjectDocument } from '../model/types';
import { barrierEnds, segmentProjection } from '../model/geometry';
import { floorOutline } from '../model/walls';

const cache = new WeakMap<ProjectDocument, Set<string>>();

/** Follow each floor's footprint, including stepped upper floors and courtyard edges. */
export function exteriorWalls(project: ProjectDocument): Set<string> {
  const cached = cache.get(project);
  if (cached) return cached;
  const result = new Set<string>();
  for (const floor of project.floors) {
    const rings = floorOutline(project, floor.id);
    for (const b of project.barriers.filter(b => b.floorId === floor.id && b.kind === 'wall')) {
      const [a, c] = barrierEnds(project, b),
        tolerance = Math.max(0.12, b.thickness * 0.75);
      if (
        rings.some(ring =>
          [0.15, 0.5, 0.85].every(t => {
            const point: [number, number] = [a[0] + (c[0] - a[0]) * t, a[1] + (c[1] - a[1]) * t];
            return ring.some((p, i) => segmentProjection(point, p, ring[(i + 1) % ring.length]).distance <= tolerance);
          }),
        )
      )
        result.add(b.id);
    }
  }
  cache.set(project, result);
  return result;
}
