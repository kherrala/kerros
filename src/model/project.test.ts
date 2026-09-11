import { describe, expect, it } from 'vitest';
import { createObject } from './factory';
import { sampleProject } from './testFixtures';
import { distance, rectangle } from './geometry';
import { copyProject, openingFloorId, transformObject } from './project';

describe('project operations', () => {
  it('copies a project without altering its source or carrying feed bindings', () => {
    const source = sampleProject();
    const snapshot = JSON.stringify(source);
    const copy = copyProject(source);
    expect(copy.id).not.toBe(source.id);
    expect(copy.objects.every(o => !o.feedId)).toBe(true);
    expect(JSON.stringify(source)).toBe(snapshot);
  });
  it('resizes a rotated rectangle in its own axes and moves its holes with it', () => {
    const object = createObject('zone', [0, 0], 'floor-ground');
    object.width = 10;
    object.depth = 6;
    object.rotation = 90;
    object.rings = [rectangle([0, 0], 10, 6, 90), rectangle([0, 0], 2, 2, 90)];
    transformObject(object, { width: 20, position: [30, 20] });
    expect(distance(object.rings[0][0], object.rings[0][1])).toBeCloseTo(20);
    expect(distance(object.rings[0][1], object.rings[0][2])).toBeCloseTo(6);
    expect(distance(object.rings[1][0], object.rings[1][1])).toBeCloseTo(4);
    expect(object.position).toEqual([30, 20]);
  });
});

describe('opening floor', () => {
  it('honours the document’s own choice, and treats null as the outdoor site', () => {
    const p = sampleProject();
    const upper = p.floors.find(f => f.elevation !== 0) ?? p.floors[0];
    p.initialFloorId = upper.id;
    expect(openingFloorId(p)).toBe(upper.id);
    p.initialFloorId = null;
    expect(openingFloorId(p)).toBeNull();
  });
  it('falls back to the ground floor when unset or dangling', () => {
    const p = sampleProject();
    const ground = p.floors.find(f => f.elevation === 0)!;
    expect(openingFloorId(p)).toBe(ground.id);
    // A stale id must not strand a viewer on a floor that no longer exists.
    p.initialFloorId = 'floor-that-was-deleted';
    expect(openingFloorId(p)).toBe(ground.id);
  });
});
