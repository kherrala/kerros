// Journey animator: drives the MapLibre camera along a routed path with chained linear easeTo per
// edge (bearing follows travel), asks the host to switch floors at vertical transitions, and
// cancels on any user gesture. Owned and instantiated by MapCanvas; the host controls it through
// the MapCanvas prop contract (playing / onJourneyStep / onJourneyEnd / onRequestFloor).
import maplibregl, { type Map as GLMap } from 'maplibre-gl';
import type { Origin, Point } from '../model/types';
import { distance, toLngLat } from '../model/geometry';
import type { Route } from '../model/navigation';
import { legStepIndices, pathHeading } from './route';

/** fit()'s depth-aim factored out and shared with the journey: with a pitched camera a plate at
 * elevation elev projects off-centre unless the ground target shifts by elev·tan(pitch) along the
 * view bearing. elev must already be the PRESENTED elevation (undergroundView().focusElevation). */
export function aimCenter(
  center: [number, number],
  elev: number,
  pitchDeg: number,
  bearingDeg: number,
): [number, number] {
  if (!elev) return center;
  const shift = elev * Math.tan((pitchDeg * Math.PI) / 180),
    bearing = (bearingDeg * Math.PI) / 180;
  const target = maplibregl.MercatorCoordinate.fromLngLat({ lng: center[0], lat: center[1] }),
    unit = target.meterInMercatorCoordinateUnits();
  target.x += shift * Math.sin(bearing) * unit;
  target.y -= shift * Math.cos(bearing) * unit;
  const ll = target.toLngLat();
  return [ll.lng, ll.lat];
}

export interface JourneyCallbacks {
  /** Ask the app to switch floors; the map rebuild follows via React. */
  requestFloor(floorId: string | null): void;
  /** Resolves once the app shows floorId and the view has rebuilt (implemented by MapCanvas). */
  waitForFloor(floorId: string | null): Promise<void>;
  /** Presented elevation of a floor: undergroundView(...).focusElevation in 3D, 0 in 2D. */
  focusElevation(floorId: string | null): number;
  onStep(index: number): void;
  onEnd(): void;
}

const SPEED = 4; // m/s along walk legs — presentation pace, not literal walking speed.
const MIN_EDGE_MS = 180,
  RIDE_MS = 1400,
  MERGE_DEG = 4;

/** Merge near-collinear vertices so consecutive edges read as one continuous ease. */
function mergeCollinear(points: Point[]): Point[] {
  const out = points.filter((p, i) => !i || distance(p, points[i - 1]) > 0.01);
  for (let i = 1; i < out.length - 1; ) {
    const turn =
      (Math.abs(
        Math.atan2(out[i + 1][1] - out[i][1], out[i + 1][0] - out[i][0]) -
          Math.atan2(out[i][1] - out[i - 1][1], out[i][0] - out[i - 1][0]),
      ) *
        180) /
      Math.PI;
    if (Math.min(turn, 360 - turn) < MERGE_DEG) out.splice(i, 1);
    else i++;
  }
  return out;
}

export class JourneyPlayer {
  private cancelled = false;
  private ended = false;
  private _playing = false;
  private origin!: Origin;
  constructor(
    private map: GLMap,
    private cb: JourneyCallbacks,
  ) {}
  get playing() {
    return this._playing;
  }
  private onGesture = () => this.stop();
  play(route: Route, ctx: { origin: Origin; startFloorId: string | null }) {
    if (this._playing || this.ended) return;
    this.origin = ctx.origin;
    this._playing = true;
    const el = this.map.getCanvasContainer();
    el.addEventListener('pointerdown', this.onGesture);
    el.addEventListener('wheel', this.onGesture);
    void this.run(route, ctx.startFloorId).finally(() => this.end());
  }
  /** Cancel: abort the current ease, detach listeners, fire onEnd exactly once. Never resets the
   * camera itself — the host re-runs fit if it wants to. */
  stop() {
    if (this.ended) return;
    this.cancelled = true;
    this.map.stop();
    this.end();
  }
  private end() {
    if (this.ended) return;
    this.ended = true;
    this.cancelled = true;
    this._playing = false;
    const el = this.map.getCanvasContainer();
    el.removeEventListener('pointerdown', this.onGesture);
    el.removeEventListener('wheel', this.onGesture);
    this.cb.onEnd();
  }
  private ease(point: Point, floorId: string | null, bearing: number, duration: number, zoom?: number): Promise<void> {
    if (this.cancelled) return Promise.resolve();
    const ll = toLngLat(point, this.origin);
    const center = aimCenter([ll[0], ll[1]], this.cb.focusElevation(floorId), this.map.getPitch(), bearing);
    return new Promise(resolve => {
      const done = () => {
        clearTimeout(timer);
        this.map.off('moveend', done);
        resolve();
      };
      const timer = setTimeout(done, duration + 600); // easeTo may short-circuit without moveend
      this.map.on('moveend', done);
      this.map.easeTo({
        center,
        bearing,
        duration,
        easing: t => t,
        essential: true,
        ...(zoom === undefined ? {} : { zoom }),
      });
    });
  }
  private async switchFloor(target: string | null, current: string | null): Promise<string | null> {
    if (target === current || this.cancelled) return current;
    this.cb.requestFloor(target);
    await this.cb.waitForFloor(target);
    return target;
  }
  private async run(route: Route, startFloor: string | null) {
    const stepOf = legStepIndices(route);
    let floor = startFloor,
      lastStep = -1;
    const fire = (i: number) => {
      if (i !== lastStep && !this.cancelled) {
        lastStep = i;
        this.cb.onStep(i);
      }
    };
    fire(0); // depart
    const first = route.nodes[0];
    if (first) {
      // Always align the view with the departure floor — an outdoor-origin route (egress reversed)
      // starts on the outdoor site, not on whatever floor the user happened to be browsing.
      floor = await this.switchFloor(first.floorId, floor);
      if (this.cancelled) return;
      const bearing =
        route.nodes.length > 1
          ? pathHeading(first.position, route.nodes[1].position, this.origin)
          : this.map.getBearing();
      await this.ease(first.position, first.floorId, bearing, 750, Math.max(this.map.getZoom(), 18.5));
    }
    for (let i = 0; i < route.legs.length && !this.cancelled; i++) {
      const leg = route.legs[i];
      if (leg.edge.kind === 'stairs' || leg.edge.kind === 'elevator') {
        fire(stepOf[i]);
        floor = await this.switchFloor(leg.to.floorId, floor);
        if (this.cancelled) break;
        await this.ease(leg.to.position, leg.to.floorId, this.map.getBearing(), RIDE_MS);
        continue;
      }
      // Chain the run of same-step walk/door legs (doors are their own steps, so a chain never
      // crosses a step boundary) and ease each merged edge with linear timing.
      const step = stepOf[i];
      const points: Point[] = [leg.from.position, leg.to.position];
      let fid = leg.to.floorId ?? leg.from.floorId;
      while (
        i + 1 < route.legs.length &&
        stepOf[i + 1] === step &&
        route.legs[i + 1].edge.kind !== 'stairs' &&
        route.legs[i + 1].edge.kind !== 'elevator'
      ) {
        i++;
        points.push(route.legs[i].to.position);
        fid = route.legs[i].to.floorId ?? fid;
      }
      fire(step);
      if (fid !== null) floor = await this.switchFloor(fid, floor); // entering through a door switches inside; stepping outside keeps the floor (outdoor legs read from any floor)
      if (this.cancelled) break;
      const merged = mergeCollinear(points);
      for (let k = 1; k < merged.length && !this.cancelled; k++) {
        const a = merged[k - 1],
          b = merged[k];
        await this.ease(
          b,
          floor,
          pathHeading(a, b, this.origin),
          Math.max(MIN_EDGE_MS, (distance(a, b) / SPEED) * 1000),
        );
      }
    }
    if (!this.cancelled) fire(route.steps.length - 1); // arrive
  }
}
