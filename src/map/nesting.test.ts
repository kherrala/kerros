import { describe, expect, it } from 'vitest';
import { nestingLift } from './SceneLayer';
import { createDemo } from '../../app/demo/demo';
import { objectArea } from '../model/geometry';

describe('coplanar area stagger', () => {
  it('lifts smaller areas above the larger ones they sit inside', () => {
    const deck = nestingLift(9000); // a parking deck plate
    const lane = nestingLift(700); // a drive aisle on it
    const bay = nestingLift(12.5); // a bay off the aisle
    expect(deck).toBeLessThan(lane);
    expect(lane).toBeLessThan(bay);
    // Enough to beat depth precision, far too little to see: millimetres, not centimetres.
    expect(bay - deck).toBeLessThan(0.03);
    expect(bay - deck).toBeGreaterThan(0.005);
  });

  it('separates the real nested plates in the garage, which is what was z-fighting', () => {
    const p = createDemo();
    const on = (name: string) => p.objects.find(o => o.floorId === 'floor-p1' && o.name.startsWith(name))!;
    const lifts = [on('Parking deck'), on('Aisle'), on('Bay ')].map(o => nestingLift(objectArea(o)));
    // Three distinct heights: previously all three sat at exactly the same base and fought.
    expect(new Set(lifts).size).toBe(3);
    expect(lifts).toEqual([...lifts].sort((a, b) => a - b));
  });
});
