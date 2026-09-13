import { add, centroid, distance, objectPosition } from './geometry';
import { stairGeometry } from './stairGeometry';
import { flightRun, flights, primaryShafts, shaftKey, stairModel } from './vertical';
import type { Point, ProjectDocument, SiteObject } from './types';

/** The tread/landing centreline shared with physical walking, in travel order. */
export function stairTraversal(project: ProjectDocument, object: SiteObject, from: string, to: string) {
  const primary = primaryShafts(project);
  const stair =
    project.objects.find(o => o.kind === 'stairs' && primary.has(o.id) && shaftKey(o) === shaftKey(object)) ?? object;
  const all = flights(project, stair);
  const index = all.findIndex(f => (f.from.id === from && f.to.id === to) || (f.from.id === to && f.to.id === from));
  if (index < 0) return null;
  const flight = all[index],
    model = stairModel(project, stair),
    run = flightRun(project, stair, flight.rise, model, index);
  const points: Point[] = [];
  if (model === 'escalator') {
    points.push(run.at(run.half + 0.35), run.at(run.footT), run.at(run.topT), run.at(-run.half - 0.35));
  } else if (model === 'spiral') {
    const radius = Math.max(0.8, Math.min(stair.width, stair.depth) / 2) * 0.65;
    for (let i = 0; i <= 160; i++) {
      const angle = 0.01 + ((Math.PI * 2 - 0.02) * i) / 160;
      points.push(add(objectPosition(project, stair), [Math.cos(angle) * radius, Math.sin(angle) * radius]));
    }
  } else {
    const geometry = stairGeometry(stair, run, flight.rise, model);
    for (const [i, lane] of geometry.lanes.entries()) {
      const length = distance(lane.foot, lane.head);
      if (!i)
        points.push([
          lane.foot[0] - ((lane.head[0] - lane.foot[0]) / length) * 0.35,
          lane.foot[1] - ((lane.head[1] - lane.foot[1]) / length) * 0.35,
        ]);
      else {
        const landing = geometry.landings.find(l => l.height === lane.base);
        if (landing) points.push(centroid(landing.ring));
      }
      points.push(lane.foot, lane.head);
    }
    const last = geometry.lanes.at(-1)!;
    const length = distance(last.foot, last.head);
    points.push([
      last.head[0] + ((last.head[0] - last.foot[0]) / length) * 0.35,
      last.head[1] + ((last.head[1] - last.foot[1]) / length) * 0.35,
    ]);
  }
  const up = flight.from.id === from;
  if (!up) points.reverse();
  return {
    points,
    up,
    escalator: model === 'escalator',
    speed: (0.5 * run.incline) / Math.hypot(run.incline, flight.rise),
  };
}
