import polygonClipping from 'polygon-clipping';
import {
  addBarrier,
  barrierEnds,
  centroid,
  closeRing,
  distance,
  openRing,
  pointInRing,
  rectangle,
  ringArea,
  rotate,
  segmentProjection,
} from '../../src/model/geometry';
import { createObject as makeObject } from '../../src/model/factory';
import { normalizeBoundaries } from '../../src/model/boundaries';
import { fitOpening } from '../../src/model/walls';
import type { MaterialKind, Point, ProjectDocument, Ring, SiteObject } from '../../src/model/types';

export type Polygon = Ring[];
type MultiPolygon = Polygon[];
export type Use = 'circulation' | 'retail' | 'office' | 'meeting' | 'service' | 'lounge';
export interface Programme {
  name: string;
  use: Use;
  enclosed?: boolean;
  color?: string;
}
const colors: Record<Use, string> = {
  circulation: '#e4e4df',
  retail: '#eee4d4',
  office: '#dce5e9',
  meeting: '#dfe8dd',
  service: '#e3e0db',
  lounge: '#ece0ce',
};
export const areaOf = (rings: Polygon) => ringArea(rings[0]) - rings.slice(1).reduce((sum, r) => sum + ringArea(r), 0);
// Remove numerical duplicate points and zero-width retraced edges left by coincident clip lines.
// This tolerance is microscopic; architectural setbacks and narrow returns are preserved.
function cleanRing(ring: Ring): Ring {
  const points = openRing(ring).filter((p, i, all) => distance(p, all[(i + all.length - 1) % all.length]) > 1e-7);
  let changed = true;
  while (changed && points.length > 3) {
    changed = false;
    for (let i = 0; i < points.length; i++) {
      const a = points[(i + points.length - 1) % points.length],
        b = points[i],
        c = points[(i + 1) % points.length];
      const cross = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
      if (distance(a, c) < 1e-7 || Math.abs(cross) < 1e-7 * distance(a, c)) {
        points.splice(i, 1);
        changed = true;
        break;
      }
    }
  }
  return closeRing(points);
}
function clip(operation: 'intersection' | 'difference', a: MultiPolygon, b: MultiPolygon): MultiPolygon {
  if (!a.length || !b.length) return operation === 'intersection' ? [] : a;
  const scaled = (polygons: MultiPolygon) =>
    polygons.map(p => p.map(r => closeRing(r).map(([x, y]) => [x * 1000, y * 1000] as Point)));
  return (polygonClipping[operation](scaled(a), scaled(b)) as MultiPolygon)
    .map(p => p.map(r => cleanRing(r.map(([x, y]) => [x / 1000, y / 1000] as Point))))
    .filter(p => openRing(p[0]).length >= 3 && ringArea(p[0]) > 1e-8)
    .map(([outer, ...holes]) => [outer, ...holes.filter(r => openRing(r).length >= 3 && ringArea(r) > 1e-8)]);
}
export const intersection = (a: Polygon, b: Polygon) => clip('intersection', [a], [b]);
export const inPolygon = (at: Point, rings: Polygon) =>
  pointInRing(at, rings[0]) && !rings.slice(1).some(h => pointInRing(at, h));
export const box = (x0: number, y0: number, x1: number, y1: number): Ring =>
  closeRing([
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ]);
export function strip(a: Point, b: Point, width: number): Ring {
  const length = distance(a, b),
    nx = ((-(b[1] - a[1]) / length) * width) / 2,
    ny = (((b[0] - a[0]) / length) * width) / 2;
  return closeRing([
    [a[0] + nx, a[1] + ny],
    [b[0] + nx, b[1] + ny],
    [b[0] - nx, b[1] - ny],
    [a[0] - nx, a[1] - ny],
  ]);
}
export function wing(a: Point, b: Point) {
  const length = distance(a, b),
    dx = (b[0] - a[0]) / length,
    dy = (b[1] - a[1]) / length;
  const at = (along: number, inward: number): Point => [
    a[0] + dx * along + dy * inward,
    a[1] + dy * along - dx * inward,
  ];
  return {
    length,
    at,
    angle: (Math.atan2(dy, dx) * 180) / Math.PI,
    band: (start: number, end: number, near: number, far: number) =>
      closeRing([at(start, near), at(end, near), at(end, far), at(start, far)]),
  };
}

/** Split semantic rings with interior islands into adjacent simple faces. A department inside a
 * circulation loop is occupied floor, not a slab void; only the floor plate carries atrium holes. */
function simple(polygons: MultiPolygon): MultiPolygon {
  return polygons.flatMap(p => {
    if (p.length < 2) return [p];
    const xs = p[1].map(q => q[0]),
      cut = (Math.min(...xs) + Math.max(...xs)) / 2;
    return simple([
      ...clip('intersection', [p], [[box(-1000, -1000, cut, 1000)]]),
      ...clip('intersection', [p], [[box(cut, -1000, 1000, 1000)]]),
    ]);
  });
}
function labelPoint(rings: Polygon): Point {
  const middle = centroid(rings[0]);
  const clearance = (p: Point) =>
    !inPolygon(p, rings)
      ? -1
      : Math.min(
          ...rings.flatMap(r =>
            openRing(r).map((a, i, pts) => segmentProjection(p, a, pts[(i + 1) % pts.length]).distance),
          ),
        );
  let best = middle,
    score = clearance(middle);
  const xs = rings[0].map(q => q[0]),
    ys = rings[0].map(q => q[1]);
  const step = Math.max(0.5, Math.min(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) / 18);
  for (let x = Math.min(...xs) + step / 2; x < Math.max(...xs); x += step)
    for (let y = Math.min(...ys) + step / 2; y < Math.max(...ys); y += step) {
      const value = clearance([x, y]);
      if (value > score) {
        best = [x, y];
        score = value;
      }
    }
  return best;
}

/** Allocate a complete programme, circulation first. Claims subtract from the remaining floor,
 * so named departments, corridors and support rooms cannot overlap or block a reserved landing. */
export class FloorProgramme {
  private available: MultiPolygon;
  readonly rooms: { object: SiteObject; spec: Programme; angle: number }[] = [];
  constructor(
    readonly project: ProjectDocument,
    readonly floorId: string,
    footprint: Polygon,
    readonly material: MaterialKind = 'terrazzo',
  ) {
    this.available = [footprint];
  }
  claim(spec: Programme, outline: Ring, angle = 0, minimum = 10): SiteObject[] {
    const pieces = simple(clip('intersection', this.available, [[outline]])).filter(
      p => p.every(r => openRing(r).length >= 3) && areaOf(p) >= minimum,
    );
    this.available = clip('difference', this.available, [[outline]]);
    return this.emit(spec, pieces, angle);
  }
  private emit(spec: Programme, pieces: MultiPolygon, angle: number) {
    return pieces.map((piece, i) => {
      // Stabilise serialised intersections without re-rounding inputs during polygon subtraction.
      // Micrometre precision avoids coincident-edge arithmetic failures in subsequent edits.
      const rings = piece.map(r =>
        cleanRing(r.map(([x, y]) => [Math.round(x * 1e6) / 1e6, Math.round(y * 1e6) / 1e6] as Point)),
      );

      const o = makeObject('room', labelPoint(rings), this.floorId, i ? `${spec.name} · ${i + 1}` : spec.name);
      const xs = rings[0].map(p => p[0]),
        ys = rings[0].map(p => p[1]);
      Object.assign(o, {
        rings,
        width: Math.max(...xs) - Math.min(...xs),
        depth: Math.max(...ys) - Math.min(...ys),
        height: this.project.floors.find(f => f.id === this.floorId)!.height - 0.18,
        color: spec.color ?? colors[spec.use],
        material: this.material,
        category: spec.use,
      });
      this.project.objects.push(o);
      this.rooms.push({ object: o, spec, angle });
      return o;
    });
  }
  path(name: string, points: Point[], width: number) {
    for (let i = 1; i < points.length; i++)
      this.claim({ name, use: 'circulation' }, strip(points[i - 1], points[i], width), 0, 1);
    for (const at of points.slice(1, -1)) this.claim({ name, use: 'circulation' }, rectangle(at, width, width), 0, 1);
  }
  remainder(spec: Programme) {
    this.emit(
      spec,
      simple(this.available).filter(p => p.every(r => openRing(r).length >= 3) && areaOf(p) >= 3),
      0,
    );
    this.available = [];
  }
  finish() {
    const p = this.project,
      f = this.floorId;
    const corridors = this.rooms.filter(r => r.spec.use === 'circulation').map(r => r.object);
    const frontage = (object: SiteObject) =>
      openRing(object.rings![0]).flatMap((a, i, pts) => {
        const b = pts[(i + 1) % pts.length],
          length = distance(a, b);
        if (length < 1.8) return [];
        const mid: Point = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        const reaches = [-1, 1].some(sign => {
          const q: Point = [
            mid[0] + ((sign * (b[1] - a[1])) / length) * 0.6,
            mid[1] - ((sign * (b[0] - a[0])) / length) * 0.6,
          ];
          const back: Point = [2 * mid[0] - q[0], 2 * mid[1] - q[1]];
          return inPolygon(back, object.rings!) && corridors.some(c => inPolygon(q, c.rings!));
        });
        return reaches ? [{ a, b, mid, length }] : [];
      });
    const enclosed = this.rooms.filter(r => r.spec.enclosed && frontage(r.object).length);
    for (const { object } of enclosed) {
      const ring = openRing(object.rings![0]);
      for (const [i, a] of ring.entries()) {
        const b = ring[(i + 1) % ring.length];
        if (distance(a, b) < 0.02) continue;
        if (
          p.barriers.some(
            e => e.floorId === f && [a, b].every(q => segmentProjection(q, ...barrierEnds(p, e)).distance < 0.002),
          )
        )
          continue;
        const wall = addBarrier(p, a, b, f, 'wall');
        if (wall)
          Object.assign(wall, {
            name: `${object.name} partition`,
            thickness: 0.16,
            height: object.height,
            material: 'plaster',
            color: '#d9d8cf',
          });
      }
    }
    normalizeBoundaries(p, f);
    for (const { object, spec } of enclosed) {
      const edges = frontage(object).sort((a, b) => b.length - a.length);
      let placed = false;
      for (const edge of edges) {
        const candidates = p.barriers.filter(
          b => b.floorId === f && segmentProjection(edge.mid, ...barrierEnds(p, b)).distance < 0.01,
        );
        const width = spec.use === 'retail' || spec.use === 'lounge' ? 1.8 : 1.1;
        const fit = fitOpening({ ...p, barriers: candidates }, f, 'door', edge.mid, width, 1);
        if (!fit) continue;
        const door = makeObject('door', fit.position, f, `${object.name} entrance`);
        Object.assign(door, {
          barrierId: fit.barrierId,
          offset: fit.offset,
          width,
          doorType: width > 1.2 ? 'double' : 'hinged',
        });
        p.objects.push(door);
        placed = true;
        break;
      }
      if (!placed) throw new Error(`No clear doorway for ${object.name} on ${f}`);
    }
    for (const { object, spec, angle } of this.rooms) {
      if (spec.use === 'circulation') continue;
      if (/washrooms/i.test(object.name)) {
        const at = labelPoint(object.rings!);
        for (const [model, x] of [
          ['toilet', -1.2],
          ['basin', 1.2],
        ] as const) {
          if (p.objects.some(o => o.floorId === f && o.model === model && inPolygon(o.position, object.rings!)))
            continue;
          const position: Point = [at[0] + x, at[1]];
          if (!rectangle(position, 1, 1).every(q => inPolygon(q, object.rings!))) continue;
          const fixture = makeObject('fixture', position, f, model === 'toilet' ? 'WC' : 'Washbasin');
          Object.assign(fixture, { model, width: 0.65, depth: 0.8, height: 0.8, color: '#eeeeea' });
          p.objects.push(fixture);
        }
        continue;
      }
      const points = object.rings![0].map(p => rotate(p, -angle));
      const xs = points.map(p => p[0]),
        ys = points.map(p => p[1]);
      let count = 0;
      const stride = spec.use === 'retail' ? 5.5 : 6;
      for (let x = Math.min(...xs) + 3; x < Math.max(...xs) - 2 && count < 18; x += stride)
        for (let y = Math.min(...ys) + 3; y < Math.max(...ys) - 2 && count < 18; y += stride) {
          const at = rotate([x, y], angle);
          const inset = rectangle(at, 4, 3.4, angle);
          if (!inset.every(q => inPolygon(q, object.rings!))) continue;
          if (p.objects.some(o => o.floorId === f && o.model === 'post' && distance(o.position, at) < 2.5)) continue;
          const item = makeObject(
            'fixture',
            at,
            f,
            spec.use === 'retail'
              ? 'Display island'
              : spec.use === 'lounge'
                ? 'Lounge seating'
                : spec.use === 'service'
                  ? 'Storage'
                  : 'Work table',
          );
          Object.assign(item, {
            model:
              spec.use === 'lounge' ? 'sofa' : spec.use === 'retail' || spec.use === 'service' ? 'cabinet' : 'dining',
            width: 2.4,
            depth: 1.1,
            height: spec.use === 'retail' ? 1.15 : 0.75,
            rotation: angle,
            color: spec.use === 'retail' ? '#c8bb9f' : '#c9c3b6',
          });
          p.objects.push(item);
          count++;
        }
    }
  }
}
