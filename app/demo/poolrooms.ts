import { closeRing, type Point, type ProjectDocument, type SiteObject } from '@kerros/schema';
import { generateOfficeLayout, seedNumber } from './officeLayout';

/** Connected tiled chambers; one pool outline describes its basin, water and floor opening. */
export function addPoolrooms(p: ProjectDocument, seed: string, span: number) {
  // Compact bathing chambers surround two larger halls; the baths need not fill the office footprint.
  const cell = Math.min(span / 12, 8),
    bottom = Math.min(...p.floors.map(f => f.elevation));
  for (const [level, name] of ['The endless baths', 'Deep bath chambers'].entries()) {
    const floorId = `backrooms-pool-${level}`,
      layout = generateOfficeLayout(`${seed}/baths/${level}`, 12);
    const metric = ([x, y]: Point): Point => [(x - 6) * cell, (y - 6) * cell];
    const roomId = (i: number) => `${floorId}-room-${i}`;
    const nodeId = (i: number) => `${floorId}-room-node-${i}`;
    p.floors.push({
      id: floorId,
      buildingId: 'building-main',
      name,
      code: `B${level + 1}`,
      elevation: bottom - 12 * (level + 1),
      height: 10,
      // Only the submerged fittings light the baths; no luminous ceiling or ambient room lamps.
      light: { kelvin: 9500, level: 0 },
      ambience: { preset: 'baths', level: 0.55 },
    });
    const rectangle = (at: Point, width: number, depth: number) =>
      closeRing([
        [at[0] - width / 2, at[1] - depth / 2],
        [at[0] + width / 2, at[1] - depth / 2],
        [at[0] + width / 2, at[1] + depth / 2],
        [at[0] - width / 2, at[1] + depth / 2],
      ]);
    const routes = new Map<number, { id: string; position: Point }[]>();
    const rooms: SiteObject[] = layout.rooms.map((room, i) => {
      const at = metric([room.x + room.width / 2, room.y + room.depth / 2]);
      const o: SiteObject = {
        id: roomId(i),
        floorId,
        kind: 'room',
        name:
          i === 0
            ? 'Bath stair landing'
            : i <= 2
              ? `Tall pool chamber ${i}`
              : `Tiled chamber ${String(i).padStart(2, '0')}`,
        position: at,
        width: room.width * cell,
        depth: room.depth * cell,
        height: 0.05,
        rotation: 0,
        material: 'tile',
        color: '#f2f3ef',
        ceilingHeight: i === 1 || i === 2 ? 10 : 7,
        category: 'backrooms-baths',
        rings: [rectangle(at, room.width * cell, room.depth * cell)],
      };
      p.objects.push(o);
      p.navNodes!.push({
        id: nodeId(i),
        floorId,
        objectId: o.id,
        position: i === 0 ? [2, 0] : [at[0] - o.width / 2 + 1.5, at[1] - o.depth / 2 + 1.5],
      });
      if (i) {
        const corners = [
          [-1, -1],
          [1, -1],
          [1, 1],
          [-1, 1],
        ].map(([x, y], corner) => ({
          id: corner ? `${o.id}-corner-${corner}` : nodeId(i),
          position: [at[0] + x * (o.width / 2 - 1.5), at[1] + y * (o.depth / 2 - 1.5)] as Point,
        }));
        routes.set(i, corners);
        p.navNodes!.push(...corners.slice(1).map(corner => ({ ...corner, floorId })));
        for (let k = 0; k < 4; k++)
          p.navEdges!.push({
            id: `${o.id}-walkway-${k}`,
            kind: 'walk',
            aId: corners[k].id,
            bId: corners[(k + 1) % 4].id,
          });
      }
      return o;
    });
    p.zones!.push({ id: `${floorId}-zone`, name, spaceIds: rooms.map(o => o.id), purpose: 'baths' });
    const junctions = new Map<string, string>();
    const join = (position: Point) => {
      const key = position.join(',');
      let id = junctions.get(key);
      if (!id) {
        id = `${floorId}-junction-${junctions.size}`;
        junctions.set(key, id);
        p.junctions.push({ id, floorId, position });
      }
      return id;
    };
    const wall = (a: Point, b: Point, height: number) =>
      p.barriers.push({
        id: `${floorId}-wall-${p.barriers.length}`,
        floorId,
        kind: 'wall',
        startId: join(a),
        endId: join(b),
        name: 'White tiled bath wall',
        height: height - 0.18,
        thickness: 0.22,
        material: 'tile',
        color: '#f2f3ef',
      });
    layout.boundaries.forEach((edge, i) => {
      const a = metric(edge.start),
        b = metric(edge.end),
        height = Math.max(rooms[edge.a].ceilingHeight!, rooms[edge.b]?.ceilingHeight ?? 0);
      const along = (t: number): Point => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      if (!edge.passage) {
        wall(a, b, height);
        return;
      }
      const inset = (cell - 2.2) / (2 * cell);
      wall(a, along(inset), height);
      wall(along(1 - inset), b, height);
      const id = `${floorId}-passage-${i}`;
      // A human-sized doorway beneath the high ceiling. The lintel also closes the view into
      // the space above a neighbouring room's lower ceiling.
      p.objects.push({
        id: `${id}-lintel`,
        floorId,
        kind: 'fixture',
        name: 'Tiled doorway lintel',
        position: along(0.5),
        rotation: (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI,
        width: 2.24,
        depth: 0.22,
        baseHeight: 2.6,
        height: height - 2.78,
        material: 'tile',
        color: '#f2f3ef',
      });
      p.portals!.push({ id, a: roomId(edge.a), b: roomId(edge.b), name: 'Tiled doorway' });
      p.navNodes!.push({ id: `${id}-node`, floorId, position: along(0.5) });
      for (const room of [edge.a, edge.b]) {
        const at = along(0.5);
        const corner = routes
          .get(room)
          ?.slice()
          .sort(
            (a, b) =>
              Math.hypot(a.position[0] - at[0], a.position[1] - at[1]) -
              Math.hypot(b.position[0] - at[0], b.position[1] - at[1]),
          )[0];
        p.navEdges!.push({
          id: `${id}-edge-${room}`,
          kind: 'walk',
          aId: corner?.id ?? nodeId(room),
          bId: `${id}-node`,
        });
      }
    });
    const quiet = rooms
      .slice(3)
      .sort((a, b) => a.width * a.depth - b.width * b.depth)
      .slice(0, 4);
    for (const [i, room] of [rooms[1], rooms[2], ...quiet].entries()) {
      const at = room.position,
        width = Math.min(room.width - 3.6, room.width * (i === 1 ? 0.5 : 0.65)),
        depth = Math.min(room.depth - 3.6, room.depth * 0.55);
      const pool: SiteObject = {
        id: `${floorId}-pool-${i}`,
        floorId,
        kind: 'zone',
        name: i === 0 ? 'Stillwater pool' : i === 1 ? 'Slide pool' : `Quiet immersion pool ${i - 1}`,
        position: at,
        width,
        depth,
        height: 0.05,
        rotation: 0,
        rings: [rectangle(at, width, depth)],
        material: 'tile',
        color: '#f2f3ef',
        water: { depth: i >= 2 ? 1.2 : 1.8 + (seedNumber(seed) % 3) * 0.1, ripple: i === 1 ? 0.025 : 0.012 },
        parentId: room.id,
      };
      p.objects.push(pool);
      for (const side of [-1, 1])
        for (const fraction of [-0.3, 0, 0.3])
          p.objects.push({
            id: `${pool.id}-underwater-${side}-${fraction}`,
            floorId,
            kind: 'light',
            name: 'Underwater pool light',
            position: [at[0] + width * fraction, at[1] + side * (depth / 2 - 0.18)],
            width: 0.28,
            depth: 0.28,
            height: 0.28,
            rotation: side === 1 ? 0 : 180,
            light: { mountHeight: -0.7, kelvin: 9500, intensity: Math.min(180, width * depth * 3), range: 18 },
          });
      if (i === 1) {
        const scale = Math.min(room.width, room.depth) / 42;
        for (let side = 0; side < 2; side++) {
          const path: [number, number, number][] = [
            [0, -14 * scale, 6],
            [7 * scale, -12 * scale, 5.3],
            [9 * scale, -6 * scale, 3.8],
            [5 * scale, -2 * scale, 1.7],
            [0, 0, 0.05],
          ];
          if (side) for (const point of path) point[0] = -point[0] || 0;
          p.objects.push({
            id: `${floorId}-slide-${side}`,
            floorId,
            kind: 'fixture',
            name: side ? 'East tiled water slide' : 'West tiled water slide',
            position: [at[0] + (side ? 3 : -3) * scale, at[1] - depth * 0.2],
            width: 10 * scale,
            depth: 16 * scale,
            height: 7,
            rotation: 0,
            material: 'tile',
            color: '#f2f3ef',
            slide: { path, radius: Math.min(0.9, scale * 0.9) },
          });
        }
      }
      for (let vent = 0; vent < 3; vent++)
        p.objects.push({
          id: `${pool.id}-vent-${vent}`,
          floorId,
          kind: 'fixture',
          model: 'vent',
          name: 'Bath ventilation duct',
          position: [at[0] + (vent - 1) * 1.8, at[1] + room.depth / 2 - 0.2],
          width: 0.75,
          depth: 0.9,
          height: room.ceilingHeight! - 1.7,
          rotation: 0,
          color: '#394f48',
        });
    }
    const stairId = `${floorId}-stairs`;
    p.objects.push({
      id: stairId,
      floorId,
      kind: 'stairs',
      name: 'Bath stair',
      position: [-3, 0],
      width: 2.4,
      depth: 12,
      height: 10,
      rotation: 0,
      stairModel: 'switchback',
    });
    p.navNodes!.push({ id: `${floorId}-stair-node`, floorId, objectId: stairId, position: [-3, 0] });
    p.navEdges!.push(
      { id: `${floorId}-stair-access`, kind: 'walk', aId: `${floorId}-stair-node`, bId: nodeId(0) },
      {
        id: `${floorId}-flight`,
        kind: 'stairs',
        aId: `${level ? 'backrooms-pool-0' : 'backrooms-office-2'}-stair-node`,
        bId: `${floorId}-stair-node`,
        objectId: stairId,
      },
    );
  }
  // One shaft serves the whole building. Separate office/bath names previously made two
  // independent shafts claim every floor and render coincident flights through the baths.
  const stairs = p.objects.filter(o => o.kind === 'stairs');
  const stair = stairs.at(-1)!;
  stair.name = 'Office and bath stair';
  stair.servedFloorIds = p.floors.map(f => f.id);
  stair.depth = 12;
  stair.material = 'tile';
  stair.color = '#f2f3ef';
  const oldIds = new Set(stairs.map(o => o.id));
  p.objects = p.objects.filter(o => !oldIds.has(o.id) || o === stair);
  for (const node of p.navNodes ?? []) if (node.objectId && oldIds.has(node.objectId)) node.objectId = stair.id;
  for (const edge of p.navEdges ?? []) if (edge.objectId && oldIds.has(edge.objectId)) edge.objectId = stair.id;
}
