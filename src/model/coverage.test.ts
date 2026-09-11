import { describe, expect, it } from 'vitest';
import { coverageOf } from './coverage';
import { addBarrier, emptyProject, geoOrigin } from '../schema';
import { createObject } from './factory';
import type { Point, ProjectDocument } from './types';

/** Two 6 x 6 rooms side by side, divided by a wall at x = 6 with a door in it. */
function site(): ProjectDocument {
  const p = emptyProject(geoOrigin([24, 60]), 'Coverage');
  const f = p.floors[0].id;
  for (const [name, x] of [
    ['West', 0],
    ['East', 6],
  ] as [string, number][]) {
    const room = createObject('room', [x + 3, 3], f, name);
    room.rings = [
      [
        [x, 0],
        [x + 6, 0],
        [x + 6, 6],
        [x, 6],
      ] as Point[],
    ];
    p.objects.push(room);
  }
  addBarrier(p, [6, 0], [6, 6], f, 'wall');
  const door = createObject('door', [6, 3], f, 'Middle door');
  door.barrierId = p.barriers[0].id;
  door.offset = 3;
  door.width = 1;
  p.objects.push(door);
  return p;
}
const cam = (p: ProjectDocument, at: Point, rotation: number, range = 12, angle = 70) => {
  const c = createObject('camera', at, p.floors[0].id, 'Cam');
  c.rotation = rotation;
  c.coverageRange = range;
  c.coverageAngle = angle;
  p.objects.push(c);
  return c;
};

describe('coverageOf', () => {
  it('sees what is in front of it and not what is behind', () => {
    const p = site();
    const c = cam(p, [3, 3], 0); // in the west room, facing east
    const names = coverageOf(p, c).map(id => p.objects.find(o => o.id === id)!.name);
    expect(names).toContain('West');
    const back = cam(p, [3, 3], 180);
    expect(coverageOf(p, back).map(id => p.objects.find(o => o.id === id)!.name)).not.toContain('East');
  });
  it('does not see through a wall', () => {
    const p = site();
    // Facing east from the west room: the dividing wall stands between it and the east room.
    const c = cam(p, [2, 3], 0, 20, 60);
    const names = coverageOf(p, c).map(id => p.objects.find(o => o.id === id)!.name);
    expect(names).not.toContain('East');
  });
  it('stops at its reach', () => {
    const p = site();
    const door = p.objects.find(o => o.kind === 'door')!;
    // Five metres away down the room, so a 20 m lens reaches it and a 1 m one does not.
    expect(coverageOf(p, cam(p, [1, 3], 0, 20, 60))).toContain(door.id);
    expect(coverageOf(p, cam(p, [1, 3], 0, 1, 60))).not.toContain(door.id);
  });
  it('sees a door in the wall it is aimed at, which that wall cannot hide', () => {
    const p = site();
    const door = p.objects.find(o => o.kind === 'door')!;
    expect(coverageOf(p, cam(p, [3, 3], 0, 12, 60))).toContain(door.id);
  });
});
