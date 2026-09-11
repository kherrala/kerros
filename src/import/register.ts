// Putting several sheets of the same building into one frame.
//
// Floor plans are drawn one storey per sheet, and nothing says the sheets share an origin — they
// rarely do. Imported as they come, the storeys of a building land metres apart, and the only fix
// has been for a person to find something drawn on two sheets, measure the offset between them by
// hand, and type the numbers into an import script. Those numbers are the most fragile thing in such
// a script: they are correct for exactly one set of files, they cannot be checked by reading them,
// and a redrawn sheet silently invalidates them.
//
// The building can say it instead. A stair core is drawn on every storey it passes, in the same place
// on each, because that is what a stair is — so the offset between two sheets is the offset between
// the stair they share.
import { distance } from '../schema';
import type { Point } from '../schema';
import type { PlanEntity } from './types';
import { VERTEX_LAYERS, type PlanLayerMap } from './types';

/** Every entity moved by (dx, dy). Sheets are registered before import, not after: the reconstruction
 *  snaps and welds as it goes, and moving the result would mean re-deciding all of it. */
export function shiftEntities(entities: PlanEntity[], dx: number, dy: number): PlanEntity[] {
  const move = (p: Point | undefined) => (p ? ([p[0] + dx, p[1] + dy] as Point) : p);
  return entities.map(e => ({
    ...e,
    a: move(e.a),
    b: move(e.b),
    at: move(e.at),
    center: move(e.center),
    points: e.points?.map(p => [p[0] + dx, p[1] + dy] as Point),
  }));
}

export interface Landmark {
  centre: Point;
  width: number;
  height: number;
}

/** The blocks a layer's geometry falls into — a stair core on a plan, and nothing else on that layer.
 *  Single-link clustering: strokes of one stair touch, and two cores are metres apart. */
export function landmarks(entities: PlanEntity[], layer: RegExp): Landmark[] {
  const segments: [Point, Point][] = [];
  for (const e of entities) {
    if (!layer.test(e.layer)) continue;
    if (e.a && e.b) segments.push([e.a, e.b]);
    if (e.points) for (let i = 1; i < e.points.length; i++) segments.push([e.points[i - 1], e.points[i]]);
  }
  const groups: [Point, Point][][] = [];
  for (const seg of segments) {
    const near = groups.find(g => g.some(([a, b]) => seg.some(p => distance(p, a) < 1.5 || distance(p, b) < 1.5)));
    if (near) near.push(seg);
    else groups.push([seg]);
  }
  return groups
    .map(g => {
      const pts = g.flat();
      const xs = pts.map(p => p[0]),
        ys = pts.map(p => p[1]);
      const x0 = Math.min(...xs),
        x1 = Math.max(...xs),
        y0 = Math.min(...ys),
        y1 = Math.max(...ys);
      return { centre: [(x0 + x1) / 2, (y0 + y1) / 2] as Point, width: x1 - x0, height: y1 - y0 };
    })
    .filter(l => l.width > 0.5 && l.height > 0.5);
}

/** The shift that puts `sheet` into `reference`'s frame, or null when they share no landmark.
 *
 *  Matching is by SIZE: a stair core is a particular 1.87 x 2.05 m block and the one on the storey
 *  above is the same block, while a second core at the other end of the building is a different one.
 *  Two sheets whose stairs are the same size but in genuinely different places would register
 *  wrongly, so the answer is only offered when exactly one pairing is plausible — a registration
 *  that might be wrong is worse than none, because nothing downstream can tell.
 *
 *  Returns null for a sheet with no stair drawn on it, which a cellar entered from outside will not
 *  have. There is nothing to match there and the caller must say where that storey goes. */
export function sheetOffset(
  reference: PlanEntity[],
  sheet: PlanEntity[],
  layers: PlanLayerMap = VERTEX_LAYERS,
): Point | null {
  if (!layers.stairs) return null;
  const here = landmarks(reference, layers.stairs),
    there = landmarks(sheet, layers.stairs);
  if (!here.length || !there.length) return null;
  // 60 mm: two drawings of one stair differ by rounding, not by a step's worth.
  const same = (a: Landmark, b: Landmark) => Math.abs(a.width - b.width) < 0.06 && Math.abs(a.height - b.height) < 0.06;
  const pairs = here.flatMap(a => there.filter(b => same(a, b)).map(b => [a, b] as const));
  if (!pairs.length) return null;
  const offsets = pairs.map(([a, b]) => [a.centre[0] - b.centre[0], a.centre[1] - b.centre[1]] as Point);
  // Every core is tried against every other, so a building with two cores produces the right shift
  // twice — once per core, both agreeing — and the two cross-pairings once each, disagreeing. The
  // shift the most pairings vote for is the one where the whole building lines up.
  const votes = offsets.map(o => ({ o, n: offsets.filter(x => distance(x, o) <= 0.1).length }));
  const best = votes.reduce((a, b) => (b.n > a.n ? b : a));
  // A clear winner or nothing. Cores of the same size in genuinely different places give every
  // pairing one vote, and a registration that might be wrong is worse than none: nothing downstream
  // can tell the difference, and the storey lands metres out with no sign that it did.
  if (votes.some(v => v.n === best.n && distance(v.o, best.o) > 0.1)) return null;
  return [Math.round(best.o[0] * 1000) / 1000, Math.round(best.o[1] * 1000) / 1000];
}
