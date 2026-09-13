import { describe, expect, it } from 'vitest';
import { addFloor, newProject } from '../model/testFixtures';
import { createObject } from '../model/factory';
import { rectangle } from '../model/geometry';
import { floorDropAt, tallSpaceContext } from './walkSurfaces';

function levels() {
  const p = newProject(),
    top = p.floors[0];
  top.elevation = 4;
  const bottom = addFloor(p, 'lower', 0);
  const upper = createObject('room', [0, 0], top.id, 'Gallery');
  upper.rings = [rectangle([0, 0], 12, 12), rectangle([0, 0], 4, 6).reverse()];
  const lower = createObject('room', [0, 0], bottom, 'Double-height hall');
  lower.rings = [rectangle([0, 0], 12, 12)];
  lower.ceilingHeight = 7;
  p.objects.push(upper, lower);
  return { p, top, bottom, upper, lower };
}

describe('floor openings in POV', () => {
  it('drops through a rectangular hole to the nearest supporting floor, preserving plan coordinates', () => {
    const { p, top, bottom } = levels();
    expect(floorDropAt(p, top.id, [0.4, 1])).toEqual({ floorId: bottom, distance: 4 });
    expect(floorDropAt(p, top.id, [4, 1])).toBeUndefined();
    expect(floorDropAt(p, top.id, [20, 20])).toBeUndefined();
    expect(floorDropAt(p, bottom, [0.4, 1])).toBeUndefined();
  });
  it('does not fall through a hole covered by another real slab', () => {
    const { p, top } = levels();
    const cover = createObject('zone', [0, 0], top.id, 'Bridge');
    cover.rings = [rectangle([0, 0], 2, 8)];
    p.objects.push(cover);
    expect(floorDropAt(p, top.id, [0, 0])).toBeUndefined();
    expect(floorDropAt(p, top.id, [1.5, 0])?.distance).toBe(4);
  });
  it('skips another hole below and refuses an unsupported or unrelated building landing', () => {
    const { p, top, lower } = levels();
    lower.rings!.push(rectangle([0, 0], 4, 4).reverse());
    expect(floorDropAt(p, top.id, [0, 0])).toBeUndefined();
    const bottom = addFloor(p, 'lowest', -4);
    const room = createObject('room', [0, 0], bottom, 'Lowest hall');
    room.rings = [rectangle([0, 0], 12, 12)];
    p.objects.push(room);
    expect(floorDropAt(p, top.id, [0, 0])).toEqual({ floorId: bottom, distance: 8 });
    p.floors.find(f => f.id === bottom)!.buildingId = 'elsewhere';
    expect(floorDropAt(p, top.id, [0, 0])).toBeUndefined();
  });
  it('shows the lower hall through the upper hole and the upper gallery from below', () => {
    const { p, top, bottom, upper, lower } = levels();
    expect(tallSpaceContext(p, top.id)).toContain(lower);
    expect(tallSpaceContext(p, bottom)).toContain(upper);
  });
});
