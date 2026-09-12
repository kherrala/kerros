import {
  closeRing,
  emptyProject,
  geoOrigin,
  type MaterialKind,
  type Point,
  type ProjectDocument,
  type SiteObject,
} from '@kerros/schema';
import { generateOfficeLayout, seedNumber } from './officeLayout';

import { BACKROOMS_ID } from './ids';
export { BACKROOMS_ID };
export const BACKROOMS_SEED = 'the-yellow-office';
export const OFFICE_CELL = 6;
export interface BackroomsOptions {
  seed?: string;
  size?: number;
}
// Theme data and generation stay in the reference app. More level families can supply their own
// layout and palette here without teaching the schema or renderer about a particular fictional world.
const OFFICES = [
  { name: 'Yellow offices', wall: '#c2b477', carpet: '#897d4e', kelvin: 3900, level: 0.66 },
  { name: 'Abandoned administration', wall: '#b5b49a', carpet: '#727567', kelvin: 4600, level: 0.53 },
  { name: 'Deep records', wall: '#b4a483', carpet: '#786b55', kelvin: 3400, level: 0.43 },
] as const;

export function createBackrooms(options: BackroomsOptions = {}): ProjectDocument {
  const seed = (options.seed ?? BACKROOMS_SEED).trim() || BACKROOMS_SEED;
  const size = options.size ?? 28;
  const p = emptyProject(geoOrigin([24.946, 60.185]), 'The Backrooms · Offices');
  p.id =
    seed === BACKROOMS_SEED && size === 28 ? BACKROOMS_ID : `${BACKROOMS_ID}-${seedNumber(seed).toString(36)}-${size}`;
  p.description = `Procedural offices · seed “${seed}” · ${size * OFFICE_CELL} × ${size * OFFICE_CELL} m per level`;
  p.referenceNote =
    'Fictional Backrooms-inspired sample. Seeded, dithered noise shapes the rooms; connected passages form loops and dead ends. Office levels only; spa and other level families can follow.';
  p.buildings[0].name = 'The office complex';
  p.floors = OFFICES.map((theme, i) => ({
    id: `backrooms-office-${i}`,
    buildingId: 'building-main',
    name: theme.name,
    code: `L${i}`,
    elevation: -4 - i * 3.6,
    height: 3.3,
    light: { kelvin: theme.kelvin, level: theme.level },
  }));
  p.initialFloorId = p.floors[0].id;
  p.zones = [];
  p.portals = [];
  p.navNodes = [];
  p.navEdges = [];
  const stairPosition: Point = [-3, 0];
  for (const [level, floor] of p.floors.entries()) {
    const theme = OFFICES[level],
      layout = generateOfficeLayout(`${seed}/office/${level}`, size);
    const prefix = floor.id;
    const metric = ([x, y]: Point): Point => [(x - size / 2) * OFFICE_CELL, (y - size / 2) * OFFICE_CELL];
    const roomId = (i: number) => `${prefix}-room-${i}`;
    const nodeId = (i: number) => `${prefix}-node-${i}`;
    const junctions = new Map<string, string>();
    const join = (at: Point) => {
      const key = at.join(','),
        existing = junctions.get(key);
      if (existing) return existing;
      const id = `${prefix}-j-${junctions.size}`;
      junctions.set(key, id);
      p.junctions.push({ id, floorId: prefix, position: at });
      return id;
    };
    const wall = (a: Point, b: Point) =>
      p.barriers.push({
        id: `${prefix}-wall-${p.barriers.length}`,
        floorId: prefix,
        kind: 'wall',
        startId: join(a),
        endId: join(b),
        name: 'Office partition',
        height: 3,
        thickness: 0.16,
        material: 'wallpaper',
        color: theme.wall,
      });
    const object = (
      id: string,
      name: string,
      position: Point,
      width: number,
      depth: number,
      material: MaterialKind,
    ): SiteObject => ({
      id,
      name,
      position,
      width,
      depth,
      height: 0.05,
      rotation: 0,
      kind: 'room',
      floorId: prefix,
      material,
    });
    const sectors = new Map<string, string[]>();
    layout.rooms.forEach((room, i) => {
      const { x, y, width, depth } = room;
      const at = metric([x + width / 2, y + depth / 2]);
      const sector = `${String.fromCharCode(65 + Math.min(2, Math.floor((x / size) * 3)))}${Math.min(2, Math.floor((y / size) * 3)) + 1}`;
      const name =
        i === 0
          ? 'Stair landing'
          : `${width * depth >= 4 ? 'Open office' : width * depth >= 2 ? 'Connecting office' : 'Office'} ${sector} · ${String(i).padStart(3, '0')}`;
      const o = object(roomId(i), name, at, width * OFFICE_CELL, depth * OFFICE_CELL, 'carpet');
      o.color = theme.carpet;
      o.rings = [
        closeRing(
          [
            [x, y],
            [x + width, y],
            [x + width, y + depth],
            [x, y + depth],
          ].map(pt => metric(pt as Point)),
        ),
      ];
      o.category = 'backrooms-office';
      o.metadata = { noise: Math.round(room.noise * 1000) / 1000, sector };
      p.objects.push(o);
      const members = sectors.get(sector) ?? [];
      members.push(o.id);
      sectors.set(sector, members);
      // Keep the landing's route anchor clear of the staircase footprint.
      p.navNodes!.push({ id: nodeId(i), floorId: prefix, position: i === 0 ? [2, 0] : at, objectId: o.id });
    });
    for (const [sector, spaceIds] of sectors)
      p.zones.push({
        id: `${prefix}-sector-${sector}`,
        name: `${floor.code} · Wing ${sector}`,
        spaceIds,
        purpose: 'office-wing',
      });
    layout.boundaries.forEach((edge, i) => {
      const a = metric(edge.start),
        b = metric(edge.end);
      if (!edge.passage) {
        wall(a, b);
        return;
      }
      // Leave a real full-height gap in the partition: a portal with no door leaf to block the view.
      const room = layout.rooms[edge.a],
        gap = room.noise > 0.58 ? 3 : 1.8;
      const t = (OFFICE_CELL - gap) / (2 * OFFICE_CELL);
      const along = (t: number): Point => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      wall(a, along(t));
      wall(along(1 - t), b);
      const id = `${prefix}-passage-${i}`;
      p.portals!.push({ id, a: roomId(edge.a), b: roomId(edge.b), name: 'Open passage' });
      p.navNodes!.push({ id: `${id}-node`, floorId: prefix, position: along(0.5) });
      for (const side of [edge.a, edge.b])
        p.navEdges!.push({ id: `${id}-to-${side}`, kind: 'walk', aId: nodeId(side), bId: `${id}-node` });
    });
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        p.objects.push({
          id: `${prefix}-light-${x}-${y}`,
          kind: 'light',
          floorId: prefix,
          name: 'Fluorescent ceiling panel',
          position: metric([x + 0.5, y + 0.5]),
          width: 1.2,
          depth: 0.3,
          height: 2.7,
          rotation: (x + y) % 2 ? 90 : 0,
          light: {
            kelvin: theme.kelvin,
            intensity: level === 2 ? 35 : 55,
            range: 13,
            flicker: (x * 7 + y * 13 + level) % 9 === 0 ? 0.8 : 0,
          },
        });
      }
    const stairId = `${prefix}-stairs`;
    p.objects.push({
      ...object(stairId, 'Office stair', stairPosition, 2.4, 4.8, 'plaster'),
      kind: 'stairs',
      height: 3.3,
      stairModel: 'switchback',
      servedFloorIds: p.floors.map(f => f.id),
    });
    p.navNodes.push({ id: `${prefix}-stair-node`, floorId: prefix, objectId: stairId, position: stairPosition });
    p.navEdges.push({ id: `${prefix}-stair-access`, kind: 'walk', aId: nodeId(0), bId: `${prefix}-stair-node` });
    if (level > 0)
      p.navEdges.push({
        id: `${prefix}-stair-flight`,
        kind: 'stairs',
        aId: `${p.floors[level - 1].id}-stair-node`,
        bId: `${prefix}-stair-node`,
        objectId: stairId,
      });
  }
  return p;
}
