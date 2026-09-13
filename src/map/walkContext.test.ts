import { expect, it } from 'vitest';
import { walkVoidContext } from './walkContext';
import { createDemo } from '../../app/demo/demo';

it('traces the Stockmann atrium to supported plates and the roof, and opens the ground hall ceiling', () => {
  const p = createDemo(),
    floor = (id: string) => p.floors.find(f => f.id === id)!;
  const context = walkVoidContext(p, floor('floor-02'), floor('floor-02'));
  expect(context.levels.some(f => f.id === 'floor-ground')).toBe(true);
  expect(context.levels.some(f => f.id === 'floor-basement')).toBe(false);
  expect(context.roof?.id).toBe('floor-09');
  expect(context.ceilingOpenings.length).toBeGreaterThan(0);
  const ground = walkVoidContext(p, floor('floor-ground'), floor('floor-ground'));
  expect(ground.ceilingOpenings.length).toBeGreaterThan(0);
  expect(ground.levels.some(f => f.id === 'floor-entresol')).toBe(false); // carried directly by the hall renderer
});
