import type { FeatureCollection, Geometry } from 'geojson';
import type { Point, ProjectDocument, Ring, SiteObject } from './types';
import { centroid, closeRing, toLocal } from './geometry';
import { validateRings } from './validate';
import { createObject } from './factory';

/**
 * Import building/parcel footprints from GeoJSON. Coordinates are lng/lat (WGS84) by default; pass
 * `toLngLat` to convert from another projection first (the host supplies the converter — the core
 * carries no CRS knowledge).
 */
export function importFootprints(
  value: unknown,
  project: ProjectDocument,
  kind: 'building' | 'parcel',
  toLngLat?: (p: Point) => Point,
): SiteObject[] {
  if (!value || typeof value !== 'object')
    throw new Error('Choose a GeoJSON FeatureCollection, Feature, Polygon, or MultiPolygon.');
  const v = value as {
    type?: string;
    geometry?: Geometry;
    features?: FeatureCollection['features'];
    properties?: Record<string, unknown>;
  };
  const features =
    v.type === 'FeatureCollection'
      ? v.features
      : v.type === 'Feature'
        ? [{ geometry: v.geometry, properties: v.properties }]
        : [{ geometry: value as Geometry, properties: {} }];
  if (!Array.isArray(features) || !features.length) throw new Error('The GeoJSON contains no features.');
  const result: SiteObject[] = [];
  for (const f of features) {
    if (!f || !f.geometry || !['Polygon', 'MultiPolygon'].includes(f.geometry.type))
      throw new Error('Only Polygon and MultiPolygon footprint features are supported.');
    const geometry = f.geometry as GeoJSON.Polygon | GeoJSON.MultiPolygon;
    const polys = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
    for (const polygon of polys) {
      if (!Array.isArray(polygon)) throw new Error('Invalid polygon coordinates.');
      const rings: Ring[] = polygon.map(ring => {
        if (!Array.isArray(ring)) throw new Error('Invalid polygon ring.');
        return closeRing(
          ring.map(p => {
            if (!Array.isArray(p) || p.length < 2 || !p.slice(0, 2).every(Number.isFinite))
              throw new Error('Invalid coordinates.');
            const lngLat = toLngLat ? toLngLat([p[0], p[1]]) : ([p[0], p[1]] as Point);
            if (Math.abs(lngLat[0]) > 180 || Math.abs(lngLat[1]) > 85)
              throw new Error('Coordinates are outside WGS84 bounds — pick the projection the file uses.');
            return toLocal(lngLat, project.origin);
          }),
        );
      });
      const error = validateRings(rings);
      if (error) throw new Error(error);
      const o = createObject(
        kind,
        centroid(rings[0]),
        null,
        String(f.properties?.name ?? `${kind === 'building' ? 'Building' : 'Parcel'} ${result.length + 1}`),
      );
      o.width = Math.max(...rings[0].map(p => p[0])) - Math.min(...rings[0].map(p => p[0]));
      o.depth = Math.max(...rings[0].map(p => p[1])) - Math.min(...rings[0].map(p => p[1]));
      o.rings = rings;
      result.push(o);
    }
  }
  return result;
}
