import type { ElevatorControls } from '../model/host';
import type { StatusReading } from '../model/live';
import type { Route, RouteLeg } from '../model/navigation';
import type { Point, ProjectDocument } from '../model/types';
import { distance } from '../model/geometry';
import { stairTraversal } from '../model/stairTraversal';
import { elevatorLanding } from './elevators';
import { legStepIndices } from './route';

export interface WalkJourneyHost {
  project: ProjectDocument;
  floor(): string | null;
  changeFloor(id: string | null): Promise<void>;
  position(): Point;
  walk(points: Point[], options?: { speed?: number; physical?: boolean }): Promise<void>;
  controls(): ElevatorControls | undefined;
  status(feedId: string): StatusReading | undefined;
  ride(id: string | null): void;
  message(text: string): void;
  step(index: number): void;
}

/** Stateful playback uses the same lift commands/readings as a passenger. Vertical legs must not
 * disappear when a route is split into floor runs: that used to teleport straight past the ride. */
export class WalkJourney {
  private stopped = false;
  private timer?: ReturnType<typeof setTimeout>;
  private rejectWait?: (error: Error) => void;
  constructor(private host: WalkJourneyHost) {}
  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.rejectWait?.(new Error('Route playback stopped.'));
  }
  private async waitUntil(test: () => boolean) {
    const started = Date.now();
    while (!test()) {
      if (this.stopped) throw new Error('Route playback stopped.');
      if (Date.now() - started > 15_000)
        throw new Error('The elevator has not opened. Route playback paused at the landing.');
      await new Promise<void>((resolve, reject) => {
        this.rejectWait = reject;
        this.timer = setTimeout(resolve, 40);
      });
      this.rejectWait = undefined;
    }
    if (this.stopped) throw new Error('Route playback stopped.');
  }
  private object(leg: RouteLeg) {
    return this.host.project.objects.find(o => o.id === leg.edge.objectId && o.kind === leg.edge.kind);
  }
  private entry(leg: RouteLeg): Point {
    const o = this.object(leg);
    if (!o) throw new Error('This route needs a connection to its physical lift or stair.');
    if (o.kind === 'elevator') return elevatorLanding(o);
    return stairTraversal(this.host.project, o, leg.from.floorId!, leg.to.floorId!)?.points[0] ?? leg.from.position;
  }
  async play(route: Route) {
    const h = this.host,
      steps = legStepIndices(route);
    if (route.nodes[0] && h.floor() !== route.nodes[0].floorId) await h.changeFloor(route.nodes[0].floorId);
    let arrival: Point | undefined;
    for (let i = 0; i < route.legs.length && !this.stopped; i++) {
      const leg = route.legs[i];
      h.step(steps[i]);
      if (leg.edge.kind === 'elevator') {
        const o = this.object(leg),
          controls = h.controls();
        if (!o?.feedId || !controls) throw new Error('Connect elevator controls to play this lift journey.');
        const feed = o.feedId,
          from = leg.from.floorId!,
          to = leg.to.floorId!,
          landing = elevatorLanding(o);
        if (distance(h.position(), landing) > 0.01) await h.walk([h.position(), landing]);
        h.message(`Calling ${o.name}…`);
        await this.waitUntil(() => !h.status(feed)?.moving);
        const openHere = (floor: string) => {
          const s = h.status(feed);
          return !!s?.open && !s.moving && !s.targetFloorId && s.carFloorId === floor;
        };
        if (!openHere(from)) {
          controls.call(feed, from);
          await this.waitUntil(() => openHere(from));
        }
        h.message(`Entering ${o.name}`);
        await h.walk([landing, o.position], { physical: true });
        h.ride(o.id);
        h.message(`Taking ${o.name} to ${h.project.floors.find(f => f.id === to)?.name ?? to}`);
        controls.call(feed, to);
        await this.waitUntil(() => openHere(to));
        if (h.floor() !== to) await h.changeFloor(to);
        h.message(`Exiting ${o.name}`);
        await h.walk([o.position, landing], { physical: true });
        h.ride(null);
        arrival = landing;
      } else if (leg.edge.kind === 'stairs') {
        const o = this.object(leg);
        const path = o && stairTraversal(h.project, o, leg.from.floorId!, leg.to.floorId!);
        if (!o || !path) throw new Error('This stair route has no matching physical flight.');
        const status = o.feedId ? h.status(o.feedId) : undefined;
        if (path.escalator && status?.running !== false && ((status?.travel ?? o.travel ?? 'up') === 'up') !== path.up)
          throw new Error('The escalator is running the other way. Choose another route.');
        if (distance(h.position(), path.points[0]) > 0.01) await h.walk([h.position(), path.points[0]]);
        h.message(`${path.escalator ? 'Riding' : 'Walking'} ${o.name}`);
        await h.walk(path.points, {
          physical: true,
          speed: path.escalator && status?.running !== false ? path.speed : undefined,
        });
        if (h.floor() !== leg.to.floorId) await h.changeFloor(leg.to.floorId);
        arrival = path.points.at(-1)!;
      } else {
        h.message('');
        const points = [arrival ?? leg.from.position, leg.to.position];
        arrival = undefined;
        while (
          i + 1 < route.legs.length &&
          route.legs[i + 1].edge.kind !== 'elevator' &&
          route.legs[i + 1].edge.kind !== 'stairs' &&
          route.legs[i + 1].from.floorId === leg.from.floorId
        ) {
          i++;
          points.push(route.legs[i].to.position);
        }
        const next = route.legs[i + 1];
        if (next && (next.edge.kind === 'stairs' || next.edge.kind === 'elevator'))
          points[points.length - 1] = this.entry(next);
        await h.walk(points);
      }
    }
    if (!this.stopped) {
      h.message('Arrived');
      h.step(route.steps.length - 1);
    }
  }
}
