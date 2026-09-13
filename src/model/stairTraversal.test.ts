import { describe, expect, it } from 'vitest';
import { stairTraversal } from './stairTraversal';
import { newProject } from './testFixtures';
import { createObject } from './factory';
import { distance } from './geometry';
import { StairWalker, stairSurfaces } from '../map/stairSurfaces';
import type { Point } from './types';

describe('route traversal follows the rendered stairs', () => {
  it.each(['straight', 'dogleg', 'switchback', 'spiral', 'escalator'] as const)(
    'climbs and descends %s without jumping between floors',
    model => {
      for (const rotation of [0, 37, 90]) {
        const p = newProject();
        p.floors.push({ ...p.floors[0], id: 'upper', elevation: 3.2 });
        const stair = createObject('stairs', [0, 0], 'floor-ground', 'Stair');
        Object.assign(stair, {
          stairModel: model,
          width: 4,
          depth: 9,
          rotation,
          servedFloorIds: ['floor-ground', 'upper'],
        });
        p.objects.push(stair);
        const surfaces = stairSurfaces(p);
        for (const [from, to] of [
          ['floor-ground', 'upper'],
          ['upper', 'floor-ground'],
        ]) {
          const path = stairTraversal(p, stair, from, to)!;
          let floor = from,
            elevation = from === 'upper' ? 3.2 : 0,
            at = path.points[0];
          const walker = new StairWalker();
          walker.sync(floor, elevation);
          const heights: number[] = [];
          for (const end of path.points.slice(1)) {
            const start = at,
              count = Math.ceil(distance(start, end) / 0.04);
            for (let i = 1; i <= count; i++) {
              const target: Point = [
                start[0] + ((end[0] - start[0]) * i) / count,
                start[1] + ((end[1] - start[1]) * i) / count,
              ];
              at = walker.step(at, target, surfaces, floor, elevation);
              if (walker.pending) {
                floor = walker.pending;
                elevation = floor === 'upper' ? 3.2 : 0;
                walker.sync(floor, elevation);
              }
              heights.push(walker.height);
            }
            expect(distance(at, end)).toBeLessThan(0.05);
          }
          expect(floor).toBe(to);
          expect(heights.some(h => h > 0.5 && h < 2.5)).toBe(true);
        }
      }
    },
  );
});
