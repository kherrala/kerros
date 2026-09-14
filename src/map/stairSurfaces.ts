import { BODY } from './walkDimensions';
import type { Point, ProjectDocument, Ring } from '../model/types';
import type { StatusReading } from '../model/live';
import { add, distance, pointInRing, rectangle, rotate, segmentProjection } from '../model/geometry';
import { flights, flightRun, primaryShafts, stairModel } from '../model/vertical';
import { spiralGeometry, stairGeometry } from '../model/stairGeometry';
import { supportedStep } from './walkSurfaces';

export interface StairSurface {
  flightId: string;
  fromFloor: string;
  toFloor: string;
  low: number;
  high: number;
  ring: Ring;
  height(at: Point): number;
  drive?: Point;
  rail?: true;
}

/** Build once per document/status/floor change, not once per walking frame. Heights are absolute
 * floor elevations so switching the scene's floor datum cannot change the passenger's support. */
export function stairSurfaces(project: ProjectDocument, statuses?: Map<string, StatusReading>): StairSurface[] {
  const primary = primaryShafts(project),
    surfaces: StairSurface[] = [];
  for (const o of project.objects) {
    if (o.kind !== 'stairs' || !primary.has(o.id)) continue;
    const model = stairModel(project, o);
    for (const [index, flight] of flights(project, o).entries()) {
      const run = flightRun(project, o, flight.rise, model, index);
      const common = {
        flightId: `${o.id}:${index}`,
        fromFloor: flight.from.id,
        toFloor: flight.to.id,
        low: flight.from.elevation,
        high: flight.to.elevation,
      };
      const flat = (ring: Ring, height: number) =>
        surfaces.push({ ...common, ring, height: () => common.low + height });
      const slope = (foot: Point, head: Point, width: number, base: number, rise: number, drive?: Point) => {
        const length = distance(foot, head);
        const rotation = (Math.atan2(head[1] - foot[1], head[0] - foot[0]) * 180) / Math.PI - 90;
        surfaces.push({
          ...common,
          ring: rectangle([(head[0] + foot[0]) / 2, (head[1] + foot[1]) / 2], width, length, rotation),
          height: at => common.low + base + segmentProjection(at, foot, head).t * rise,
          drive,
        });
      };
      if (model === 'spiral') {
        for (const step of spiralGeometry(o, o.position, flight.rise).wedges) flat(step.ring, step.height);
      } else if (model === 'escalator') {
        const foot = run.at(run.footT),
          head = run.at(run.topT);
        const reading = statuses?.get(o.feedId ?? '');
        const sign = (reading?.travel ?? o.travel ?? 'up') === 'up' ? 1 : -1;
        const speed = (reading?.running ?? true) ? 0.5 / Math.hypot(run.incline, flight.rise) : 0;
        slope(foot, head, o.width - 0.24, 0, flight.rise, [
          (head[0] - foot[0]) * speed * sign,
          (head[1] - foot[1]) * speed * sign,
        ]);
        flat(rectangle(run.at((run.footT + run.half) / 2), o.width - 0.24, run.half - run.footT, run.rotation), 0);
        flat(rectangle(run.at(run.topT - run.pad / 2), o.width - 0.24, run.pad, run.rotation), flight.rise);
        for (const sign of [-1, 1]) {
          const offset = rotate([sign * (o.width / 2 - 0.06), 0], run.rotation);
          surfaces.push({
            ...common,
            rail: true,
            ring: rectangle(
              add(run.at((run.footT + run.topT) / 2), offset),
              0.1 + BODY * 2,
              run.incline + BODY * 2,
              run.rotation,
            ),
            height: at => common.low + segmentProjection(at, foot, head).t * flight.rise,
          });
        }
      } else {
        const geometry = stairGeometry(o, run, flight.rise, model);
        for (const lane of geometry.lanes) slope(lane.foot, lane.head, lane.width, lane.base, lane.rise);
        for (const landing of geometry.landings) flat(landing.ring, landing.height);
      }
    }
  }
  return surfaces;
}

/** Continuous walking support on the shared flights. The ramp envelope smooths the small tread
 * risers; high side entries are solid, and leaving a flight sideways cannot step into mid-air. */
export class StairWalker {
  height = 0;
  active?: StairSurface;
  pending?: string;
  private floor: string | null = null;
  sync(floor: string | null, elevation: number) {
    if (floor !== this.floor) {
      if (floor !== this.pending) this.reset(elevation);
      this.floor = floor;
      this.pending = undefined;
    } else if (!this.active) this.height = elevation;
  }
  refresh(surfaces: StairSurface[], at: Point) {
    if (!this.active) return;
    this.active = surfaces
      .filter(s => !s.rail && s.flightId === this.active!.flightId && pointInRing(at, s.ring))
      .sort((a, b) => Math.abs(a.height(at) - this.height) - Math.abs(b.height(at) - this.height))[0];
  }
  reset(elevation: number) {
    this.active = undefined;
    this.pending = undefined;
    this.height = elevation;
  }
  step(
    from: Point,
    to: Point,
    surfaces: StairSurface[],
    floor: string | null,
    elevation: number,
    supports?: (at: Point, floorId: string | null) => boolean,
  ): Point {
    const previous = this.height;
    if (
      surfaces.some(
        s => s.rail && pointInRing(to, s.ring) && s.height(to) < previous + 1.7 && s.height(to) + 1 > previous + 0.15,
      )
    )
      return from;
    const hits = surfaces.filter(s => !s.rail && pointInRing(to, s.ring));
    const reachable = hits
      .filter(s => Math.abs(s.height(to) - previous) <= 0.3)
      .sort((a, b) => Math.abs(a.height(to) - previous) - Math.abs(b.height(to) - previous));
    const support = reachable.find(s => s.flightId === this.active?.flightId) ?? reachable[0];
    if (!support) {
      // The final riser may be crossed between frames (turning stairs have no top pad).
      if (this.active && this.active.high - previous <= 0.3 && floor !== this.active.toFloor) {
        if (supports && !supports(to, this.active.toFloor)) return from;
        this.height = this.active.high;
        this.pending = this.active.toFloor;
        return to;
      }
      // Side of a raised tread/truss, or a side exit from mid-flight: stay against its edge.
      if (
        (this.active && Math.abs(previous - elevation) > 0.3) ||
        hits.some(s => s.height(to) > previous + 0.3 && s.height(to) < previous + 1.9)
      )
        return from;
      this.reset(elevation);
      return supportedStep(from, to, at => supports?.(at, floor) ?? true);
    }
    this.active = support;
    this.height = support.height(to);
    if (this.height < previous - 1e-6 && floor !== support.fromFloor) this.pending = support.fromFloor;
    else if (this.height >= support.high - 0.005 && floor !== support.toFloor && this.height >= previous)
      this.pending = support.toFloor;
    return to;
  }
}
