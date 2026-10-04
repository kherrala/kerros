import polygonClipping from 'polygon-clipping';
import type { Floor, Point, ProjectDocument, Ring } from '../model/types';
import { closeRing, openRing, pointInRing, ringArea } from '../model/geometry';
import { floorOutline } from '../model/walls';
import { floorIndex } from './underground';

/** The excavated volume's plan outline(s). A below-grade complex is rarely just the tower footprint:
 * parking decks sprawl past it and driveway ramps reach out to the street. Scoping the pit to a single
 * floor plate left everything beyond it hanging in open air, so union the plates of every below-grade
 * level with the footprints of any ramps (which are few, and are what actually reach the surface).
 * Returns one outline per disjoint excavation; empty when there is nothing below ground. */
export function excavationRings(project: ProjectDocument, levels: Floor[], ceiling = Infinity): Point[][] {
  const index = floorIndex(project);
  // In a cutaway, a shallow tunnel must not become a shaft extending down past the deepest
  // garage. A full stack still requests the entire excavation by leaving ceiling unbounded.
  const below = levels.filter(f => f.elevation < 0 && f.elevation <= ceiling + 0.01);
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
  // Include the lower part of a ramp arriving from a floor above the selected cut. Clip its
  // footprint at the requested elevation rather than projecting the street mouth downwards.
  for (const f of levels.filter(f => f.elevation > ceiling)) {
    for (const o of index.objects.get(f.id) ?? []) {
      if (!o.slope || !o.rings || o.slope.low > ceiling || o.slope.high <= o.slope.low) continue;
      const { axis, high, low } = o.slope;
      const dx = axis[1][0] - axis[0][0],
        dy = axis[1][1] - axis[0][1];
      const length2 = dx * dx + dy * dy;
      if (!length2) continue;
      const cut = (high - ceiling) / (high - low);
      const signed = (p: Point) => ((p[0] - axis[0][0]) * dx + (p[1] - axis[0][1]) * dy) / length2 - cut;
      const input = openRing(o.rings[0]),
        clipped: Point[] = [];
      for (let i = 0; i < input.length; i++) {
        const a = input[i],
          b = input[(i + 1) % input.length],
          da = signed(a),
          db = signed(b);
        if (da >= 0) clipped.push(a);
        if (da < 0 !== db < 0) {
          const t = da / (da - db);
          clipped.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
        }
      }
      if (clipped.length >= 3) polygons.push([closeRing(clipped)]);
    }
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
