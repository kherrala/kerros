import * as maplibregl from 'maplibre-gl';
import type { Map as GLMap } from 'maplibre-gl';
import type { Point, ProjectDocument } from '../model/types';
import { toLngLat } from '../model/geometry';
import { undergroundView } from './underground';

export function cameraToCenterDistance(map: GLMap): number {
  const halfFov = (map.getVerticalFieldOfView() * Math.PI) / 360;
  return (0.5 / Math.tan(halfFov)) * Math.max(1, map.getCanvas().clientHeight);
}

export function cameraPosition(map: GLMap) {
  const center = map.getCenter();
  const elevation = map.getCenterElevation();
  const pitch = (map.getPitch() * Math.PI) / 180;
  const bearing = (map.getBearing() * Math.PI) / 180;
  const target = maplibregl.MercatorCoordinate.fromLngLat(center, elevation);
  const mercatorUnitsPerMetre = target.meterInMercatorCoordinateUnits();
  const pixelsPerMetre = mercatorUnitsPerMetre * 512 * 2 ** map.getZoom();
  const distanceMetres = cameraToCenterDistance(map) / pixelsPerMetre;
  const horizontal = Math.sin(pitch) * distanceMetres * mercatorUnitsPerMetre;
  const eye = new maplibregl.MercatorCoordinate(
    target.x - Math.sin(bearing) * horizontal,
    target.y + Math.cos(bearing) * horizontal,
    target.z + Math.cos(pitch) * distanceMetres * mercatorUnitsPerMetre,
  );
  return { lngLat: eye.toLngLat(), altitude: eye.toAltitude() };
}

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

/** The map centre that brings a plan position on `floorId` under the crosshair. Anyone easing to a
 * point in the document wants this rather than the raw ground coordinate: the storey is drawn at its
 * presented elevation, and a pitched camera sees it displaced along the view bearing, so centring on
 * the ground beneath a basement leaves the thing you asked for a good ten metres off screen centre. */
export function floorAim(
  map: GLMap,
  project: ProjectDocument,
  position: Point,
  floorId: string | null,
  view: { threeD: boolean; stack: boolean },
): [number, number] {
  const ll = toLngLat(position, project.origin);
  const elev = view.threeD ? undergroundView(project, floorId, view.stack).focusElevation : 0;
  return aimCenter([ll[0], ll[1]], elev, map.getPitch(), map.getBearing());
}
