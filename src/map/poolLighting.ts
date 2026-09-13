import type { ProjectDocument, SiteObject } from '../model/types';

export interface PoolBounce {
  room: SiteObject;
  pool?: SiteObject;
  strength: number;
  height: number;
}

/** A diffuse approximation for white tiled rooms. Pool chambers receive the submerged fixtures;
 * connecting chambers receive a weaker bounce through open portals. No light crosses a sealed
 * wall, and switching off the source removes its reflected light as well. */
export function poolBounces(project: ProjectDocument, floorId: string): PoolBounce[] {
  const objects = project.objects.filter(o => o.floorId === floorId);
  const rooms = new Map(objects.filter(o => o.kind === 'room' && o.material === 'tile').map(o => [o.id, o]));
  const lit = new Map<string, PoolBounce>();
  for (const pool of objects.filter(o => o.water && o.rings)) {
    const room = rooms.get(pool.parentId ?? '');
    if (!room) continue;
    const lamps = objects.filter(
      o =>
        o.kind === 'light' &&
        o.light &&
        (o.light.mountHeight ?? 0) < 0 &&
        Math.abs(o.position[0] - pool.position[0]) <= pool.width / 2 &&
        Math.abs(o.position[1] - pool.position[1]) <= pool.depth / 2,
    );
    const intensity = lamps.reduce((sum, lamp) => sum + lamp.light!.intensity, 0);
    if (!intensity) continue;
    const strength = Math.min(1.6, intensity / 650);
    if ((lit.get(room.id)?.strength ?? 0) >= strength) continue;
    lit.set(room.id, {
      room,
      pool,
      strength,
      height: lamps.reduce((sum, lamp) => sum + lamp.light!.mountHeight!, 0) / lamps.length,
    });
  }
  const direct = new Set(lit.keys());
  const links = (project.portals ?? []).filter(
    p => p.passage !== 'none' && !p.openingId && rooms.has(p.a) && rooms.has(p.b),
  );
  // Max-product propagation avoids counting the same light repeatedly around a portal cycle.
  // White tile is highly reflective, but each doorway loses light: caustics stay in the pool room.
  for (let pass = 0; pass < rooms.size; pass++) {
    let changed = false;
    for (const link of links)
      for (const [a, b] of [
        [link.a, link.b],
        [link.b, link.a],
      ]) {
        const source = lit.get(a),
          strength = (source?.strength ?? 0) * 0.72;
        if (!source || direct.has(b) || strength <= (lit.get(b)?.strength ?? 0) + 0.0001) continue;
        lit.set(b, { room: rooms.get(b)!, strength, height: source.height });
        changed = true;
      }
    if (!changed) break;
  }
  return [...lit.values()];
}
