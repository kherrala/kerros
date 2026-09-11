import type { Feature, FeatureCollection, Geometry } from 'geojson';
import type { MaterialKind, Point, ProjectDocument, Ring, SiteObject } from '../model/types';
import type { StatusReading } from '../model/live';
import { statusTone } from '../adapters/status';
import { undergroundView } from './underground';
import type { MapStyleOptions } from '../theme';
import {
  add,
  closeRing,
  distance,
  footprint,
  openRing,
  ringArea,
  objectPosition,
  objectRotation,
  rectangle,
  rotate,
  toLngLat,
} from '../model/geometry';

export const COLORS: Record<string, string> = {
  wall: '#9298a2',
  fence: '#868c98',
  door: '#6a63d8',
  gate: '#5d6390',
  window: '#ccd4dd',
  zone: '#e0e3e6',
  room: '#f4f5f6',
  parcel: '#e4e6e3',
  building: '#dfe1e5',
  office: '#d3d9e2',
  container: '#bcc3cd',
  storage: '#e0e2d8',
  evacuation: '#cfe6c6',
  sensor: '#8fb7d4',
  alarm: '#e0524e',
  equipment: '#c3bda8',
};
export const visibleOnFloor = (object: { floorId: string | null }, floorId: string | null) =>
  object.floorId === null || (floorId !== null && object.floorId === floorId);
export const objectRings = footprint;
/** Roughly how wide a shape is on the plan, independent of its rotation. `width`/`depth` are an
 *  axis-aligned bounding box, which badly overstates anything drawn on a rotated site grid — a 2.5 m
 *  parking bay turned 55° measures nearly 5 m that way. 4·area/perimeter is the harmonic mean of a
 *  rectangle's sides (2wh/(w+h)), so it tracks the narrow dimension and does not care about angle. */
export function planWidth(o: SiteObject): number {
  const outer = o.rings?.[0];
  if (!outer) return Math.min(o.width, o.depth);
  const ring = openRing(outer);
  let perimeter = 0;
  for (let i = 0; i < ring.length; i++) perimeter += distance(ring[i], ring[(i + 1) % ring.length]);
  return perimeter > 0 ? (4 * ringArea(outer)) / perimeter : Math.min(o.width, o.depth);
}
export interface WallPiece {
  ring: Ring;
  base: number;
  height: number;
  id: string;
  color: string;
  floorId: string | null;
  material?: MaterialKind;
}
export function wallPieces(project: ProjectDocument, floorId: string | null, stack = false): WallPiece[] {
  const pieces: WallPiece[] = [];
  const junctions = new Map(project.junctions.map(j => [j.id, j.position]));
  const elevations = new Map(project.floors.map(f => [f.id, f.elevation]));
  const attached = new Map<string, SiteObject[]>();
  for (const o of project.objects)
    if (o.barrierId && ['door', 'window', 'gate'].includes(o.kind)) {
      const items = attached.get(o.barrierId) ?? [];
      items.push(o);
      attached.set(o.barrierId, items);
    }
  for (const barrier of project.barriers.filter(b => stack || visibleOnFloor(b, floorId))) {
    const a = junctions.get(barrier.startId),
      b = junctions.get(barrier.endId);
    if (!a || !b) continue;
    const length = distance(a, b);
    if (length < 0.01) continue;
    const angle = (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI;
    const elevation = stack ? (elevations.get(barrier.floorId ?? '') ?? 0) : 0;
    const openings = (attached.get(barrier.id) ?? []).sort((a, b) => (a.offset ?? 0) - (b.offset ?? 0));
    const piece = (start: number, end: number, base: number, height: number) => {
      if (end - start < 0.005 || height <= base) return;
      const center = add(a, rotate([(start + end) / 2, 0], angle));
      pieces.push({
        ring: rectangle(center, end - start, barrier.thickness, angle),
        base: elevation + base,
        height: elevation + height,
        id: barrier.id,
        color: barrier.color ?? COLORS[barrier.kind],
        floorId: barrier.floorId,
        material: barrier.material,
      });
    };
    let cursor = 0;
    for (const opening of openings) {
      const start = Math.max(0, (opening.offset ?? 0) - opening.width / 2),
        end = Math.min(length, (opening.offset ?? 0) + opening.width / 2);
      piece(cursor, start, 0, barrier.height);
      if (opening.kind === 'window') {
        piece(start, end, 0, 0.85);
        piece(start, end, Math.min(0.85 + opening.height, barrier.height), barrier.height);
      } else piece(start, end, Math.min(opening.height, barrier.height), barrier.height);
      cursor = end;
    }
    piece(cursor, length, 0, barrier.height);
  }
  return pieces;
}
export function makeFeatures(
  project: ProjectDocument,
  floorId: string | null,
  selected: string | null,
  coverage: boolean,
  statuses?: Map<string, StatusReading>,
  mapStyle?: MapStyleOptions,
): FeatureCollection {
  const features: Feature[] = [];
  const poly = (rings: Ring[], props: Record<string, unknown>) =>
    features.push({
      type: 'Feature',
      properties: props,
      geometry: { type: 'Polygon', coordinates: rings.map(r => closeRing(r).map(p => toLngLat(p, project.origin))) },
    });
  const line = (points: Point[], props: Record<string, unknown>) =>
    features.push({
      type: 'Feature',
      properties: props,
      geometry: { type: 'LineString', coordinates: points.map(p => toLngLat(p, project.origin)) },
    });
  // Below ground, outdoor geometry (the parcel, landscaping, site POIs) sits far above your head and
  // has nothing to do with the level you are standing on. The 3D scene already drops it when buried;
  // the plan has to agree, or a basement is drawn on top of the site plate.
  const buried = undergroundView(project, floorId, false).buried;
  for (const o of project.objects.filter(o => visibleOnFloor(o, floorId) && !(buried && o.floorId === null))) {
    const props = {
      id: o.id,
      kind: o.kind,
      floorId: o.floorId,
      category: o.category,
      selected: o.id === selected,
      // Narrow things (parking bays, parked cars, lockers, racks) are a few pixels across at building
      // zoom, where drawing every one turns a dense plan into a hatch of noise. Flagged here so the
      // plan can hold them back until you are close enough for them to mean something.
      small: planWidth(o) < 3.4,
      color:
        mapStyle?.objectColor?.(o) ??
        o.color ??
        (o.kind === 'room' ? mapStyle?.room : undefined) ??
        COLORS[o.kind] ??
        '#ccd8dc',
    };
    if (o.rings) poly(o.rings, props);
    else if (['office', 'container', 'storage', 'elevator', 'stairs', 'turnstile'].includes(o.kind))
      poly(objectRings(o), props);
    else if (o.kind === 'fixture') poly(objectRings(o), { ...props, kind: 'furniture' });
    else if (o.kind === 'landscape') {
      const circle: Point[] = [];
      for (let a = 0; a <= 360; a += 30) circle.push(add(o.position, rotate([o.width / 2, 0], a)));
      poly([closeRing(circle)], { ...props, kind: 'furniture' });
    }
    if (['door', 'window', 'gate'].includes(o.kind)) {
      const position = objectPosition(project, o),
        rotation = objectRotation(project, o);
      // Live status tints the leaf by tone: critical red, warning amber (incl. stale). Richer host
      // state (lock/contact/…) is not part of the contract and is not rendered here.
      const status = o.feedId ? statuses?.get(o.feedId) : undefined;
      const t = status ? statusTone(status) : undefined;
      const st = mapStyle?.statusTones;
      const tone =
        t === 'critical' ? (st?.critical ?? '#e0524e') : t === 'warning' ? (st?.warning ?? '#e2a13d') : undefined;
      poly(
        [rectangle(position, o.width, o.kind === 'window' ? 0.18 : 0.16, rotation)],
        tone ? { ...props, color: tone } : props,
      );
      if (t === 'critical') {
        const halo: Point[] = [];
        for (let a = 0; a <= 360; a += 20) halo.push(add(position, rotate([Math.max(1.1, o.width * 0.9), 0], a)));
        poly([closeRing(halo)], { id: o.id, kind: 'status-halo', color: '#e0524e' });
      }
      if (o.kind === 'door') {
        const hinge = add(position, rotate([-o.width / 2, 0], rotation));
        const arc: Point[] = [];
        for (let a = 0; a <= 90; a += 6) arc.push(add(hinge, rotate([o.width, 0], rotation + a)));
        line(arc, { ...props, decoration: true });
        // A door that reports its state draws that state: a leaf standing open swings clear of the
        // frame, a closed one sits in it. Without a reading the plan falls back to the architectural
        // swing symbol, which says "a door is here and this is the way it opens" rather than
        // claiming to know whether it is open — the two were previously the same drawing.
        const leafAngle = status?.open === undefined ? 90 : status.open ? 72 : 5;
        line([hinge, add(hinge, rotate([o.width, 0], rotation + leafAngle))], {
          ...props,
          color: tone ?? props.color,
          decoration: true,
        });
      }
    }
    if (o.kind === 'stairs')
      for (let i = 0; i < 10; i++)
        line(
          [
            add(o.position, rotate([-o.width / 2, -o.depth / 2 + (i * o.depth) / 10], o.rotation)),
            add(o.position, rotate([o.width / 2, -o.depth / 2 + (i * o.depth) / 10], o.rotation)),
          ],
          { color: '#9ba0ab', decoration: true },
        );
    // The coverage toggle shows every camera's field of view; selecting a camera always shows its own.
    if ((coverage || o.id === selected) && o.kind === 'camera') {
      const points: Point[] = [o.position];
      for (let i = -(o.coverageAngle ?? 70) / 2; i <= (o.coverageAngle ?? 70) / 2; i += 2)
        points.push(add(o.position, rotate([o.coverageRange ?? 12, 0], o.rotation + i)));
      poly([closeRing(points)], { id: o.id, kind: 'coverage', color: '#7b74dd' });
    }
  }
  // Top-down walls omit lintels so the opening stays visible.
  for (const piece of wallPieces(project, floorId).filter(p => p.base === 0))
    poly([piece.ring], {
      id: piece.id,
      kind: 'wall',
      floorId: piece.floorId,
      color: mapStyle?.wall ?? piece.color,
      selected: selected === piece.id,
    });
  return { type: 'FeatureCollection', features };
}
/** Edit-mode nav-graph overlay data (kerros-navgraph): nodes as points, edges as lines. Vertical edges
 * join twin shaft positions so they render as a marker-sized stub rather than a long line. */
export function navGraphFeatures(
  project: ProjectDocument,
  floorId: string | null,
  selected: string | null,
): FeatureCollection {
  const features: Feature[] = [];
  const nodes = project.navNodes ?? [],
    edges = project.navEdges ?? [],
    byId = new Map(nodes.map(n => [n.id, n]));
  for (const e of edges) {
    const a = byId.get(e.aId),
      b = byId.get(e.bId);
    if (!a || !b) continue;
    if (!visibleOnFloor(a, floorId) && !visibleOnFloor(b, floorId)) continue;
    features.push({
      type: 'Feature',
      properties: {
        id: e.id,
        kind: e.kind,
        vertical: e.kind === 'stairs' || e.kind === 'elevator',
        selected: e.id === selected,
      },
      geometry: {
        type: 'LineString',
        coordinates: [toLngLat(a.position, project.origin), toLngLat(b.position, project.origin)],
      },
    });
  }
  const verticalNodes = new Set(
    edges.filter(e => e.kind === 'stairs' || e.kind === 'elevator').flatMap(e => [e.aId, e.bId]),
  );
  for (const n of nodes)
    if (visibleOnFloor(n, floorId))
      features.push({
        type: 'Feature',
        properties: { id: n.id, bound: !!n.objectId, vertical: verticalNodes.has(n.id), selected: n.id === selected },
        geometry: { type: 'Point', coordinates: toLngLat(n.position, project.origin) },
      });
  return { type: 'FeatureCollection', features };
}
export function draftFeatures(
  project: ProjectDocument,
  points: Point[],
  hover: Point | null,
  tool: string,
): FeatureCollection {
  const coords = hover ? [...points, hover] : points;
  let geometry: Geometry;
  if (tool === 'rectangle' && coords.length >= 2) {
    const [a, b] = [coords[0], coords.at(-1)!];
    geometry = {
      type: 'Polygon',
      coordinates: [
        rectangle([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1])).map(p =>
          toLngLat(p, project.origin),
        ),
      ],
    };
  } else geometry = { type: 'LineString', coordinates: coords.map(p => toLngLat(p, project.origin)) };
  return {
    type: 'FeatureCollection',
    features: coords.length >= 2 ? [{ type: 'Feature', properties: {}, geometry }] : [],
  };
}
