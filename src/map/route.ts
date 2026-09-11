// Thin display adapter between the routing model (src/model/navigation.ts) and the map: GeoJSON
// for the 2D route layers, the chevron sprite for the line-placed arrow symbols, and geographic
// headings for the journey camera. No second display model — everything reads the model Route.
import type { Feature, FeatureCollection } from 'geojson';
import type { Origin, Point, ProjectDocument } from '../model/types';
import type { Route } from '../model/navigation';
import { toLngLat } from '../model/geometry';

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
        properties: { step: run.step, active: run.step === activeStep, onFloor: onFloor(run.floorId), vertical: false },
        geometry: { type: 'LineString', coordinates: run.points.map(pt => toLngLat(pt, project.origin)) },
      });
    run = null;
  };
  for (let i = 0; i < route.legs.length; i++) {
    const leg = route.legs[i],
      step = steps[i];
    if (leg.edge.kind === 'stairs' || leg.edge.kind === 'elevator') {
      flush();
      const dir = elev(project, leg.to.floorId) >= elev(project, leg.from.floorId) ? 'up' : 'down';
      features.push({
        type: 'Feature',
        properties: {
          step,
          active: step === activeStep,
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
  }
  flush();
  return { type: 'FeatureCollection', features };
}

/** 24×24 chevron sprite for the symbol-placement:'line' arrow layer (points +x; MapLibre rotates
 * it along the travel direction). Drawn on a canvas — no glyphs, no external assets. */
export function routeArrowImage(color = '#5b50e6'): ImageData {
  const size = 24;
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
    ctx.moveTo(8, 6);
    ctx.lineTo(16.5, 12);
    ctx.lineTo(8, 18);
    ctx.stroke();
  };
  chevron(6.5, 'rgba(255,255,255,.92)');
  chevron(3.2, color);
  return ctx.getImageData(0, 0, size, size);
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
