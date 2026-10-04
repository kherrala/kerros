import {
  addBarrier,
  barrierEnds,
  distance,
  isVertical,
  normalizeBoundaries,
  openRing,
  pointInRing,
  rectangle,
} from '@kerros/schema';
import type { Point, ProjectDocument, Ring } from '@kerros/schema';

/** Guard the exposed plate edges, leaving existing walls, shafts and tunnel mouths clear. */
export function stockmannGuardrails(p: ProjectDocument, gallery: Ring, atrium: Ring) {
  for (const floor of p.floors.filter(f => f.mezzanine || f.elevation > 0)) {
    normalizeBoundaries(p, floor.id);
    const outlines = [atrium, ...(floor.mezzanine ? [gallery] : [])];
    const edges = outlines.flatMap(r =>
      openRing(r).map((a, i, ring) => [a, ring[(i + 1) % ring.length]] as [Point, Point]),
    );
    const clearances = p.objects
      .filter(o => isVertical(o.kind) && o.servedFloorIds?.includes(floor.id))
      .map(o => rectangle(o.position, o.width + 0.4, o.depth + 0.4, o.rotation));
    const passages = p.objects
      .filter(o => o.floorId === floor.id && o.kind === 'zone' && /tunnel/i.test(o.name))
      .flatMap(o => (o.rings ? [o.rings[0]] : []));
    const walls = p.barriers
      .filter(b => b.floorId === floor.id)
      .map(wall => {
        const [a, b] = barrierEnds(p, wall);
        return rectangle(
          [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2],
          distance(a, b) + 0.1,
          wall.thickness + 0.1,
          (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI,
        );
      });
    const exclusions = [...clearances, ...passages, ...walls];
    for (const [a, b] of edges) {
      const dx = b[0] - a[0],
        dy = b[1] - a[1];
      const stops = [0, 1];
      for (const ring of exclusions) {
        const points = openRing(ring);
        for (let i = 0; i < points.length; i++) {
          const c = points[i],
            d = points[(i + 1) % points.length];
          const ex = d[0] - c[0],
            ey = d[1] - c[1],
            cross = dx * ey - dy * ex;
          if (Math.abs(cross) < 1e-8) continue;
          const t = ((c[0] - a[0]) * ey - (c[1] - a[1]) * ex) / cross;
          const u = ((c[0] - a[0]) * dy - (c[1] - a[1]) * dx) / cross;
          if (t > 0 && t < 1 && u >= 0 && u <= 1) stops.push(t);
        }
      }
      stops.sort((a, b) => a - b);
      const at = (t: number): Point => [a[0] + dx * t, a[1] + dy * t];
      for (let i = 1; i < stops.length; i++) {
        if (exclusions.some(r => pointInRing(at((stops[i - 1] + stops[i]) / 2), r))) continue;
        const start = at(stops[i - 1]),
          end = at(stops[i]);
        if (distance(start, end) < 0.02) continue;
        const guard = addBarrier(p, start, end, floor.id, 'fence');
        if (guard) Object.assign(guard, { name: 'Gallery guardrail', height: 1.1, thickness: 0.08, color: '#55574e' });
      }
    }
    normalizeBoundaries(p, floor.id);
  }
}
