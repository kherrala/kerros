import { describe, expect, it } from 'vitest';
import { landmarks, sheetOffset, shiftEntities } from './register';
import type { PlanEntity } from './types';
import type { Point } from '../schema';

/** A stair core: treads filling a block of the given size at the given place. */
const core = (at: Point, w = 1.9, d = 2.0): PlanEntity[] =>
  Array.from({ length: 8 }, (_, i) => ({
    type: 'LINE' as const,
    layer: '82_PORTAAT',
    a: [at[0], at[1] + (i * d) / 7] as Point,
    b: [at[0] + w, at[1] + (i * d) / 7] as Point,
  }));

describe('registering sheets onto one frame', () => {
  it('finds the shift from the stair two storeys share', () => {
    const ground = core([10, 10]);
    // The same stair, drawn on a sheet whose origin sits elsewhere.
    const upper = shiftEntities(core([10, 10]), 3.25, -1.5);
    expect(sheetOffset(ground, upper)).toEqual([-3.25, 1.5]);
    // Applying it puts them in the same place.
    const fixed = landmarks(shiftEntities(upper, -3.25, 1.5), /^82_/)[0];
    expect(fixed.centre[0]).toBeCloseTo(landmarks(ground, /^82_/)[0].centre[0], 6);
  });
  it('offers nothing for a storey with no stair drawn on it', () => {
    // A cellar entered from outside. There is nothing to match, and guessing would be worse than
    // saying so: nothing downstream can tell a wrong registration from a right one.
    expect(sheetOffset(core([10, 10]), [])).toBeNull();
  });
  it('refuses when two candidate stairs disagree about the shift', () => {
    // Same-sized cores that are not the same core. One of the two pairings must be wrong, and there
    // is no way to tell which, so there is no answer.
    const ground = [...core([0, 0]), ...core([20, 0])];
    const other = [...core([0, 0]), ...core([20, 5])];
    expect(sheetOffset(ground, other)).toBeNull();
  });
  it('accepts several cores that agree', () => {
    const ground = [...core([0, 0]), ...core([20, 0])];
    const moved = shiftEntities(ground, 2, 2);
    expect(sheetOffset(ground, moved)).toEqual([-2, -2]);
  });
});
