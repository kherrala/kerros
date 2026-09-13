import { describe, expect, it } from 'vitest';
import { doorGeometry, doorLeaves, doorSymbol, draggedDoorSwing } from './doors';
import { newProject } from './testFixtures';
import { createObject } from './factory';
import { add, addBarrier, rotate } from './geometry';
import { transact, validateProject } from './validate';

describe('door handing and opening side', () => {
  const setup = (rotation = 0) => {
    const p = newProject();
    const wall = addBarrier(p, rotate([-3, 0], rotation), rotate([3, 0], rotation), p.floors[0].id, 'wall')!;
    const door = createObject('door', [0, 0], wall.floorId);
    Object.assign(door, { barrierId: wall.id, offset: 3, width: 1 });
    p.objects.push(door);
    return { p, door };
  };
  it('keeps old doors unchanged and renders all four configurations about the chosen hinge', () => {
    for (const angle of [0, 15, 83, 180, 270]) {
      const { p, door } = setup(angle);
      for (const hand of ['left', 'right'] as const)
        for (const side of [1, -1] as const) {
          Object.assign(door, { doorHinge: hand, doorSwing: side });
          const shape = doorGeometry(p, door),
            sign = hand === 'left' ? 1 : -1;
          const hinge = rotate([-sign / 2, 0], angle);
          expect(shape.hinge[0]).toBeCloseTo(hinge[0]);
          expect(shape.hinge[1]).toBeCloseTo(hinge[1]);
          const end = add(hinge, rotate([0, side], angle));
          expect(shape.tip(90)[0]).toBeCloseTo(end[0]);
          expect(shape.tip(90)[1]).toBeCloseTo(end[1]);
          expect(shape.arc.at(-1)).toEqual(shape.tip(90));
          expect(Math.hypot(...shape.tip(0))).toBeCloseTo(0.5);
          validateProject(p);
        }
    }
  });
  it('flips across a rotated wall, preserves handing, and holds the side along its centreline', () => {
    const { p, door } = setup(37);
    door.doorHinge = 'right';
    door.doorSwing = -1;
    expect(draggedDoorSwing(p, door, rotate([1, 0.04], 37))).toBe(-1);
    expect(draggedDoorSwing(p, door, rotate([1, 0.6], 37))).toBe(1);
    expect(draggedDoorSwing(p, door, rotate([-1, -0.6], 37))).toBe(-1);
    expect(door.doorHinge).toBe('right');
  });
  it('preserves the mechanism through a document round trip and gives it the matching plan symbol', () => {
    const { p, door } = setup(37);
    for (const doorType of ['hinged', 'sliding', 'double'] as const) {
      door.doorType = doorType;
      validateProject(p);
      expect(JSON.parse(JSON.stringify(p)).objects.find((o: { id: string }) => o.id === door.id).doorType).toBe(
        doorType,
      );
      expect(doorSymbol(p, door)).toHaveLength(doorType === 'double' ? 4 : doorType === 'sliding' ? 3 : 2);
      if (doorType === 'double') {
        const leaves = doorLeaves(p, door);
        for (const leaf of leaves) {
          expect(leaf.tip(0)[0]).toBeCloseTo(0);
          expect(leaf.tip(0)[1]).toBeCloseTo(0);
        }
      }
      if (doorType === 'sliding') expect(doorLeaves(p, door)).toEqual([]);
    }
  });
  it('rejects malformed settings without changing the document', () => {
    const { p, door } = setup();
    const original = JSON.stringify(p);
    for (const patch of [
      { doorSwing: 0 },
      { doorHinge: 'middle' },
      { kind: 'window', doorSwing: 1 },
      { doorType: 'revolving' },
      { kind: 'window', doorType: 'sliding' },
    ]) {
      expect(transact(p, d => Object.assign(d.objects.find(o => o.id === door.id)!, patch)).ok).toBe(false);
      expect(JSON.stringify(p)).toBe(original);
    }
  });
});
