import type { Map as GLMap } from 'maplibre-gl';

// Deep links live in the URL fragment so a refresh restores the exact view — project, floor,
// 2D/3D mode and the full camera pose (centre, zoom, bearing, pitch). Format:
//   #p=<projectId>&f=<floorId|out>&v=2d|3d|stack|walk&c=<lng>,<lat>,<zoom>,<bearing>,<pitch>
// `walk` is a 3D mode, so a host that only knows about threeD still gets a sensible view from it.
// The pose precision is deliberate: reloading a drift repro must land on the identical camera.
export interface CameraPose {
  center: [number, number];
  zoom: number;
  bearing: number;
  pitch: number;
}
export interface ViewLink {
  project?: string;
  floor?: string | null;
  threeD?: boolean;
  stack?: boolean;
  /** First-person walk-through. Implies threeD and excludes stack. */
  walk?: boolean;
  camera?: CameraPose;
  /** Which map background: the host's basemap or the plain drawing ground. Not written to the
   *  link — it is a property of what is being opened, not of where the camera is. */
  basemap?: 'plan' | 'host';
}

export function parseViewLink(hash = location.hash): ViewLink {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const link: ViewLink = {};
  const p = params.get('p');
  if (p) link.project = p;
  const f = params.get('f');
  if (f !== null) link.floor = f === 'out' ? null : f;
  const v = params.get('v');
  if (v) {
    link.threeD = v !== '2d';
    link.stack = v === 'stack';
    link.walk = v === 'walk';
  }
  const c = params.get('c')?.split(',').map(Number);
  if (c?.length === 5 && c.every(Number.isFinite))
    link.camera = { center: [c[0], c[1]], zoom: c[2], bearing: c[3], pitch: c[4] };
  return link;
}

export function formatViewLink(link: ViewLink): string {
  const params = new URLSearchParams();
  if (link.project) params.set('p', link.project);
  if (link.floor !== undefined) params.set('f', link.floor ?? 'out');
  if (link.threeD !== undefined)
    params.set('v', link.walk ? 'walk' : link.threeD ? (link.stack ? 'stack' : '3d') : '2d');
  if (link.camera)
    params.set(
      'c',
      [
        link.camera.center[0].toFixed(7),
        link.camera.center[1].toFixed(7),
        link.camera.zoom.toFixed(3),
        link.camera.bearing.toFixed(2),
        link.camera.pitch.toFixed(2),
      ].join(','),
    );
  return `#${params.toString()}`;
}

export const cameraPose = (map: GLMap): CameraPose => {
  const c = map.getCenter();
  return { center: [c.lng, c.lat], zoom: map.getZoom(), bearing: map.getBearing(), pitch: map.getPitch() };
};
export function writeViewLink(link: ViewLink): void {
  history.replaceState(history.state, '', location.pathname + location.search + formatViewLink(link));
}
export function clearViewLink(): void {
  history.replaceState(history.state, '', location.pathname + location.search);
}
