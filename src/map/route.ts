// Thin display adapter between the routing model (src/model/navigation.ts) and the map: GeoJSON
// for the 2D route layers, the chevron sprite for the line-placed arrow symbols, and geographic
// headings for the journey camera. No second display model — everything reads the model Route.
import type { Feature, FeatureCollection } from 'geojson';
import type { Origin, Point, ProjectDocument } from '../model/types';
import type { Route } from '../model/navigation';
import { toLngLat } from '../model/geometry';

/** The route's own colours. A wayfinding line is not a plan colour — it is a thing laid ON the plan
 *  for someone to follow, so it wants to be the one saturated element in a scene of pale rooms, and
 *  it wants a white edge so it reads over a dark floor as well as a light one. Green because green
 *  is what "this way" looks like on every floor of every building anyone has walked through. */
export const ROUTE_COLOR = '#16a34a';
/** Steps either side of the one being walked: the same green, not a different colour — the path is
 *  one path, and only emphasis separates the part you are on from the rest of it. */
export const ROUTE_SOFT = '#6fc98d';
export const ROUTE_EDGE = '#ffffff';

const elev = (p: ProjectDocument, id: string | null) =>
  id === null ? 0 : (p.floors.find(f => f.id === id)?.elevation ?? 0);

/** Step index owning each traversal leg, in leg order. Every walk/door/vertical step carries
 * nodeIds for the nodes it visits (one more than its legs); depart/arrive own no legs. */
export function legStepIndices(route: Route): number[] {
  const out: number[] = [];
  let leg = 0;
  for (let s = 0; s < route.steps.length; s++) {
    const step = route.steps[s];
    if (step.kind === 'depart' || step.kind === 'arrive') continue;
    for (let k = 1; k < step.nodeIds.length && leg < route.legs.length; k++) out[leg++] = s;
  }
  while (leg < route.legs.length) out[leg++] = Math.max(0, route.steps.length - 2);
  return out;
}

/** GeoJSON for the 2D route layers. Walk/door legs chain into per-step polylines (so dashes and
 * chevrons flow continuously); vertical legs become Point features at the shaft. Every feature
 * carries { step, active, onFloor, vertical, dir }. Outdoor legs count as on-floor everywhere,
 * mirroring visibleOnFloor — the outdoor tail of an egress route must stay readable. */
export function routeFeatures(
  project: ProjectDocument,
  route: Route,
  floorId: string | null,
  activeStep: number | null,
): FeatureCollection {
  const features: Feature[] = [];
  const steps = legStepIndices(route);
  const onFloor = (fid: string | null) => fid === null || fid === floorId;
  let run: { step: number; floorId: string | null; points: Point[] } | null = null;
  const flush = () => {
    if (run && run.points.length > 1)
      features.push({
        type: 'Feature',
        properties: {
          step: run.step,
          // Nothing being played means nothing is "later": the whole path is current, and dimming all
          // of it to the not-your-step tone leaves a route drawn in the colour of an afterthought.
          active: activeStep === null || run.step === activeStep,
          onFloor: onFloor(run.floorId),
          vertical: false,
        },
        geometry: { type: 'LineString', coordinates: run.points.map(pt => toLngLat(pt, project.origin)) },
      });
    run = null;
  };
  // A second, coarser tracing of the same path: one feature per unbroken stretch on one floor,
  // chained straight through the instruction boundaries the per-step features stop at. The travelling
  // highlight is a line-gradient over `line-progress`, and line-progress runs 0→1 within a single
  // feature — split the path per step and the band restarts at every "turn left", which reads as a
  // stutter rather than as motion towards somewhere.
  let flow: { floorId: string | null; points: Point[] } | null = null;
  const flushFlow = () => {
    if (flow && flow.points.length > 1 && onFloor(flow.floorId))
      features.push({
        type: 'Feature',
        properties: { flow: true, onFloor: true, vertical: false },
        geometry: { type: 'LineString', coordinates: flow.points.map(pt => toLngLat(pt, project.origin)) },
      });
    flow = null;
  };
  for (let i = 0; i < route.legs.length; i++) {
    const leg = route.legs[i],
      step = steps[i];
    if (leg.edge.kind === 'stairs' || leg.edge.kind === 'elevator') {
      flush();
      flushFlow(); // a flight is a break in the walk, not a place for the band to slide through
      const dir = elev(project, leg.to.floorId) >= elev(project, leg.from.floorId) ? 'up' : 'down';
      features.push({
        type: 'Feature',
        properties: {
          step,
          active: activeStep === null || step === activeStep,
          onFloor: onFloor(leg.from.floorId) || onFloor(leg.to.floorId),
          vertical: true,
          dir,
        },
        geometry: { type: 'Point', coordinates: toLngLat(leg.from.position, project.origin) },
      });
      continue;
    }
    // A door edge stepping outside draws on its indoor floor; outdoor-only legs keep floorId null.
    const fid = leg.from.floorId === leg.to.floorId ? leg.from.floorId : (leg.from.floorId ?? leg.to.floorId);
    if (!run || run.step !== step || run.floorId !== fid) {
      flush();
      run = { step, floorId: fid, points: [leg.from.position] };
    }
    run.points.push(leg.to.position);
    if (!flow || flow.floorId !== fid) {
      flushFlow();
      flow = { floorId: fid, points: [leg.from.position] };
    }
    flow.points.push(leg.to.position);
  }
  flush();
  flushFlow();
  return { type: 'FeatureCollection', features };
}

/** A band of light travelling along the path, as a line-gradient over `line-progress`.
 *
 *  Built from stops at fixed, strictly ascending positions with the band expressed as an alpha
 *  falling off either side of `phase` — rather than by moving the stops, which is the obvious way
 *  and the wrong one: a moving window has to be clamped as it wraps past 0 and 1, and interpolate
 *  refuses stops that are not strictly ascending. This way there is nothing to clamp. */
export function routeFlowGradient(phase: number, color = ROUTE_EDGE, stops = 26): unknown[] {
  const out: unknown[] = ['interpolate', ['linear'], ['line-progress']];
  const [r, g, b] = [1, 3, 5].map(i => Number.parseInt(color.slice(i, i + 2), 16));
  for (let i = 0; i < stops; i++) {
    const at = i / (stops - 1);
    const gap = Math.abs(at - phase);
    // Wrapped distance: the head of the path is the tail's neighbour, so the band leaves one end and
    // arrives at the other without a seam.
    const reach = Math.max(0, 1 - Math.min(gap, 1 - gap) / 0.17);
    out.push(at, `rgba(${r},${g},${b},${(0.45 * reach ** 2).toFixed(3)})`);
  }
  return out;
}

/** 32×32 chevron sprite for the symbol-placement:'line' arrow layer (points +x; MapLibre rotates it
 * along the travel direction). White on a halo of the path's own colour: the arrow sits ON the green
 * track, so it has to be the light thing, and the halo is what keeps it legible where the track
 * passes over a pale floor. Drawn on a canvas — no glyphs, no external assets. */
export function routeArrowImage(color = ROUTE_COLOR): ImageData {
  const size = 32;
  const canvas = (
    typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(size, size)
      : Object.assign(document.createElement('canvas'), { width: size, height: size })
  ) as HTMLCanvasElement;
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
  ctx.clearRect(0, 0, size, size);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const chevron = (width: number, stroke: string) => {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo(10, 7);
    ctx.lineTo(22.5, 16);
    ctx.lineTo(10, 25);
    ctx.stroke();
  };
  chevron(9.5, color);
  chevron(5, ROUTE_EDGE);
  return ctx.getImageData(0, 0, size, size);
}

/** The track's repeating tile, for the 3D ribbon: a green band with white edges and a white chevron
 *  pointing along it, drawn once and tiled every `TRACK_TILE` metres of path.
 *
 *  One texture answers all of it. The ribbon is a constant width, so the tile's top and bottom edges
 *  ARE the track's edges — mitres and corners included, which is the part a separate outline geometry
 *  gets wrong. The chevron rides in the same tile, so the arrows are spaced in metres of walking
 *  rather than in pixels of screen. And scrolling the tile along the path is the animation: the
 *  arrows march towards the destination instead of sitting still and merely pointing at it. */
export const TRACK_TILE = 2.6;
/** The tile's own size in pixels, described in one place. Powers of two so it can carry mipmaps:
 *  at eye level most of the track is seen at a grazing angle, and that is exactly where an
 *  unmipmapped texture turns its chevrons into glitter. */
export const TRACK_PIXELS: [number, number] = [256, 128];
export function routeTrackImage(color = ROUTE_COLOR, active = true): ImageData {
  // Big enough to stay crisp with your nose a metre from it in walk mode, which is where a 128-wide
  // tile went soft — at that range one texel of the tile is a centimetre of floor.
  const [w, h] = TRACK_PIXELS;
  const canvas = (
    typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(w, h)
      : Object.assign(document.createElement('canvas'), { width: w, height: h })
  ) as HTMLCanvasElement;
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, w, h);
  // The white kerb, top and bottom. Thin enough to read as an edge rather than as a second stripe.
  const kerb = Math.round(h * 0.13);
  ctx.fillStyle = ROUTE_EDGE;
  ctx.fillRect(0, 0, w, kerb);
  ctx.fillRect(0, h - kerb, w, kerb);
  // A soft brightening across the tile, so the scroll reads as light travelling along the track and
  // not only as arrows sliding. Drawn before the chevron, which stays flat white.
  const sweep = ctx.createLinearGradient(0, 0, w, 0);
  sweep.addColorStop(0, 'rgba(255,255,255,0)');
  sweep.addColorStop(0.55, 'rgba(255,255,255,0.34)');
  sweep.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = sweep;
  ctx.fillRect(0, kerb, w, h - 2 * kerb);
  ctx.strokeStyle = ROUTE_EDGE;
  ctx.lineWidth = h * 0.16;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.globalAlpha = active ? 0.96 : 0.7;
  ctx.beginPath();
  ctx.moveTo(w * 0.4, h * 0.28);
  ctx.lineTo(w * 0.62, h * 0.5);
  ctx.lineTo(w * 0.4, h * 0.72);
  ctx.stroke();
  return ctx.getImageData(0, 0, w, h);
}

/** Heading in degrees from true north between two local points, computed in geographic space so a
 * rotated Origin yields the bearing the map camera actually needs. */
export function pathHeading(a: Point, b: Point, origin: Origin): number {
  const [lng1, lat1] = toLngLat(a, origin),
    [lng2, lat2] = toLngLat(b, origin);
  const heading =
    (Math.atan2((lng2 - lng1) * Math.cos((((lat1 + lat2) / 2) * Math.PI) / 180), lat2 - lat1) * 180) / Math.PI;
  return (heading + 360) % 360;
}
