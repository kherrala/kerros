import type { Point, Ring, SiteObject } from './types';
import { add, rectangle, rotate } from './geometry';
import { treads, type FlightRun, type StairModel } from './vertical';

export interface StairLane {
  foot: Point;
  head: Point;
  width: number;
  base: number;
  rise: number;
  steps: number;
}
export interface StairLanding {
  ring: Ring;
  height: number;
}

/** One description of the steps and landings, used by both rendering and walking support. */
export function stairGeometry(o: SiteObject, run: FlightRun, rise: number, model: StairModel) {
  const lanes: StairLane[] = [],
    landings: StairLanding[] = [];
  const center = run.at(0);
  const at = (p: Point) => add(center, rotate(p, run.rotation));
  const landing = (x: number, y: number, w: number, d: number, height: number) => {
    if (w > 0.001 && d > 0.001) landings.push({ ring: rectangle(at([x, y]), w, d, run.rotation), height });
  };
  const lane = (foot: Point, head: Point, width: number, base: number, climb: number) => {
    const length = Math.hypot(head[0] - foot[0], head[1] - foot[1]);
    lanes.push({ foot: at(foot), head: at(head), width, base, rise: climb, steps: treads(climb, length).steps });
  };
  const half = run.half;
  if (model === 'straight') {
    lane([0, -half], [0, -run.topT], o.width * 0.94, 0, rise);
    landing(0, (half - run.topT) / 2, o.width, half + run.topT, rise);
  } else if (model === 'dogleg') {
    const width = Math.min(o.width, run.length) * 0.45;
    const x = -o.width / 2 + width / 2,
      y = half - width / 2;
    const first = treads(rise / 2, run.length - width),
      second = treads(rise / 2, o.width - width);
    const firstRun = first.steps * first.going,
      secondRun = second.steps * second.going;
    const footY = half - width - firstRun,
      headX = -o.width / 2 + width + secondRun;
    lane([x, footY], [x, half - width], width * 0.94, 0, rise / 2);
    landing(x, (footY - half) / 2, width, footY + half, 0);
    landing(x, y, width, width, rise / 2);
    lane([-o.width / 2 + width, y], [headX, y], width * 0.94, rise / 2, rise / 2);
    landing((headX + o.width / 2) / 2, y, o.width / 2 - headX, width, rise);
  } else {
    const landingDepth = Math.min(Math.max(0.6, o.width / 2), run.length * 0.35);
    const { steps, going } = treads(rise / 2, run.length - landingDepth);
    const headY = -half + steps * going;
    lane([-o.width / 4, -half], [-o.width / 4, headY], o.width * 0.47, 0, rise / 2);
    landing(0, (headY + half) / 2, o.width, half - headY, rise / 2);
    lane([o.width / 4, headY], [o.width / 4, -half], o.width * 0.47, rise / 2, rise / 2);
  }
  return { lanes, landings };
}

/** The same wedge treads for the spiral mesh and its walkable support. */
export function spiralGeometry(o: SiteObject, position: Point, rise: number) {
  const outer = Math.max(0.8, Math.min(o.width, o.depth) / 2),
    inner = Math.min(0.16, outer / 5);
  const steps = Math.max(6, Math.min(30, Math.round(rise / 0.18)));
  const wedges = Array.from({ length: steps }, (_, i) => {
    const start = (i * Math.PI * 2) / steps,
      end = ((i + 1.04) * Math.PI * 2) / steps;
    const ring: Ring = [];
    for (const [r, from, to] of [
      [outer, start, end],
      [inner, end, start],
    ])
      for (let k = 0; k <= 4; k++) {
        const angle = from + ((to - from) * k) / 4;
        ring.push([position[0] + Math.cos(angle) * r, position[1] + Math.sin(angle) * r]);
      }
    return { ring, height: (rise * (i + 1)) / steps };
  });
  return { inner, wedges };
}
