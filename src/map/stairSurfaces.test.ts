import { describe, expect, it } from 'vitest';
import { newProject } from '../model/testFixtures';
import { createObject } from '../model/factory';
import { flightRun } from '../model/vertical';
import { stairGeometry } from '../model/stairGeometry';
import { add, centroid, distance, rotate } from '../model/geometry';
import type { Point, SiteObject } from '../model/types';
import type { StatusReading } from '../model/live';
import { StairWalker, stairSurfaces, type StairSurface } from './stairSurfaces';

function setup(model: SiteObject['stairModel'], angle = 0) {
  const p = newProject();
  p.floors.push({ ...p.floors[0], id: 'upper', elevation: 3.2 });
  const o = createObject('stairs', [10, 7], p.floors[0].id);
  Object.assign(o, {
    stairModel: model,
    width: model === 'escalator' ? 1.8 : 4,
    depth: 9,
    rotation: angle,
    servedFloorIds: p.floors.map(f => f.id),
    feedId: 'machine',
  });
  p.objects.push(o);
  return { p, o, run: flightRun(p, o, 3.2, model!) };
}
function journey(points: Point[], surfaces: StairSurface[], down = false) {
  const walker = new StairWalker();
  let floor = down ? 'upper' : 'floor-ground',
    elevation = down ? 3.2 : 0;
  walker.sync(floor, elevation);
  let at = points[0];
  const heights: number[] = [elevation];
  for (const end of points.slice(1)) {
    const start = at,
      n = Math.ceil(distance(start, end) / 0.04);
    for (let i = 1; i <= n; i++) {
      const requested: Point = [start[0] + ((end[0] - start[0]) * i) / n, start[1] + ((end[1] - start[1]) * i) / n];
      at = walker.step(at, requested, surfaces, floor, elevation);
      if (walker.pending) {
        floor = walker.pending;
        elevation = floor === 'upper' ? 3.2 : 0;
        walker.sync(floor, elevation);
      }
      heights.push(walker.height);
    }
    expect(distance(at, end), `blocked on ${JSON.stringify(end)}, height ${walker.height}`).toBeLessThan(0.05);
  }
  expect(floor).toBe(down ? 'floor-ground' : 'upper');
  expect(walker.height).toBeCloseTo(down ? 0 : 3.2, 1);
  expect(heights.some(h => h > 0.5 && h < 2.5)).toBe(true);
  for (let i = 1; i < heights.length; i++) expect(Math.abs(heights[i] - heights[i - 1])).toBeLessThanOrEqual(0.301);
  return { walker, at };
}

describe('physical stair support', () => {
  it.each(['straight', 'dogleg', 'switchback'] as const)(
    'climbs and descends %s with connected landings, including rotated shafts',
    model => {
      for (const angle of [0, 37, 90, 225]) {
        const { p, o, run } = setup(model, angle);
        const shape = stairGeometry(o, run, 3.2, model),
          surfaces = stairSurfaces(p);
        const points: Point[] = [];
        for (const [i, lane] of shape.lanes.entries()) {
          if (!i) points.push(add(lane.foot, rotate([0, -0.2], angle)), lane.foot);
          else {
            const landing = shape.landings.find(l => l.height === lane.base)!;
            points.push(centroid(landing.ring), lane.foot);
          }
          points.push(lane.head);
        }
        const last = shape.lanes.at(-1)!;
        const length = distance(last.foot, last.head);
        const beyond: Point = [
          last.head[0] + ((last.head[0] - last.foot[0]) / length) * 0.3,
          last.head[1] + ((last.head[1] - last.foot[1]) / length) * 0.3,
        ];
        points.push(beyond);
        journey(points, surfaces);
        journey([...points].reverse(), surfaces, true);
      }
    },
  );
  it('follows spiral wedge treads in both directions without passing through the stair', () => {
    const { p, o } = setup('spiral');
    const surfaces = stairSurfaces(p);
    const path: Point[] = Array.from({ length: 161 }, (_, i) => {
      const a = 0.01 + ((Math.PI * 2 - 0.02) * i) / 160;
      return add(o.position, [Math.cos(a) * 1.3, Math.sin(a) * 1.3]);
    });
    path.unshift(add(o.position, [2.2, 0.013]));
    path.push(add(o.position, [2.2, -0.013]));
    journey(path, surfaces);
    journey([...path].reverse(), surfaces, true);
  });
  it('blocks entering a raised flight from the side and stepping off its middle', () => {
    const { p, o } = setup('straight');
    const surfaces = stairSurfaces(p),
      slope = surfaces.find(s => s.height(centroid(s.ring)) > 0 && s.height(centroid(s.ring)) < 3.2)!;
    const middle = centroid(slope.ring),
      from = add(middle, [3, 0]);
    const walker = new StairWalker();
    walker.sync('floor-ground', 0);
    expect(walker.step(from, middle, surfaces, 'floor-ground', 0)).toEqual(from);
    walker.active = slope;
    walker.height = slope.height(middle);
    expect(walker.step(middle, add(o.position, [10, 0]), surfaces, 'floor-ground', 0)).toEqual(middle);
  });
});

describe('escalator support and motor', () => {
  it('uses the rendered incline at every rotation, in both directions', () => {
    for (const angle of [0, 53, 180]) {
      const { p, run } = setup('escalator', angle);
      const surfaces = stairSurfaces(p);
      const points = [run.at(run.footT + 0.2), run.at(run.footT), run.at(run.topT), run.at(run.topT - 0.2)];
      journey(points, surfaces);
      journey([...points].reverse(), surfaces, true);
      const moving = surfaces.find(s => s.drive)!;
      const speed = Math.hypot(...moving.drive!);
      expect(speed).toBeCloseTo((0.5 * run.incline) / Math.hypot(run.incline, 3.2));
    }
  });
  it('updates an occupied escalator when live direction or running status changes', () => {
    const { p } = setup('escalator');
    const surfaces = stairSurfaces(p),
      active = surfaces.find(s => s.drive)!;
    const at = centroid(active.ring),
      walker = new StairWalker();
    walker.sync('floor-ground', 0);
    walker.active = active;
    walker.height = active.height(at);
    const refresh = (reading: Partial<StatusReading>) =>
      walker.refresh(stairSurfaces(p, new Map([['machine', reading as StatusReading]])), at);
    refresh({ running: false });
    expect(walker.active!.drive).toEqual([0, 0]);
    refresh({ running: true, travel: 'down' });
    expect(walker.active!.drive![1]).toBeLessThan(0);
    refresh({ running: true, travel: 'up' });
    expect(walker.active!.drive![1]).toBeGreaterThan(0);
  });
  it('blocks both rails at their actual height but lets a walker pass below a high rail', () => {
    const { p } = setup('escalator');
    const surfaces = stairSurfaces(p),
      active = surfaces.find(s => s.drive)!;
    const at = centroid(active.ring),
      walker = new StairWalker();
    walker.sync('floor-ground', 0);
    walker.active = active;
    walker.height = active.height(at);
    for (const rail of surfaces.filter(s => s.rail)) {
      expect(walker.step(at, centroid(rail.ring), surfaces, 'floor-ground', 0)).toEqual(at);
    }
  });
});
