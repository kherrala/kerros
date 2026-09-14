import { expect, it } from 'vitest';
import { balanceGraph, type GraphPoint } from './graphLayout';

it('separates coincident nodes without NaNs, bounds movement and respects a dragged node', () => {
  const points: GraphPoint[] = Array.from({ length: 500 }, () => ({ x: 0, y: 0, vx: 0, vy: 0 }));
  points[0].pinned = true;
  for (let tick = 0; tick < 100; tick++) {
    const before = points.map(p => [p.x, p.y]);
    balanceGraph(
      points,
      [
        [0, 1],
        [1, 2],
      ],
      tick,
    );
    points.forEach((p, i) => {
      expect(Number.isFinite(p.x + p.y + p.vx + p.vy)).toBe(true);
      expect(Math.abs(p.x - before[i][0])).toBeLessThanOrEqual(6.0001);
      expect(Math.abs(p.y - before[i][1])).toBeLessThanOrEqual(6.0001);
    });
  }
  expect(points[0]).toMatchObject({ x: 0, y: 0 });
  expect(Math.hypot(points[1].x, points[1].y)).toBeGreaterThan(1);
});
it('pulls connected nodes toward each other without changing topology', () => {
  const points = [
    { x: -500, y: 0, vx: 0, vy: 0 },
    { x: 500, y: 0, vx: 0, vy: 0 },
  ];
  const links: [number, number][] = [[0, 1]];
  for (let tick = 0; tick < 150; tick++) balanceGraph(points, links, tick);
  expect(Math.abs(points[0].x - points[1].x)).toBeLessThan(150);
  expect(links).toEqual([[0, 1]]);
});
