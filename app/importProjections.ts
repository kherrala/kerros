// Reference-app import projections. The library core carries no CRS knowledge; a host offers the
// coordinate systems it cares about by converting to lng/lat. Here proj4 provides Finland's
// ETRS-TM35FIN (EPSG:3067) — the projection this app's MML basemap uses.
import proj4 from 'proj4';
import type { Point } from '@kerros/schema';
import type { ImportProjection } from '@kerros/editor';

proj4.defs('EPSG:3067', '+proj=utm +zone=35 +ellps=GRS80 +units=m +no_defs');

export const importProjections: ImportProjection[] = [
  { label: 'ETRS-TM35FIN · metres (EPSG:3067)', toLngLat: (p: Point) => proj4('EPSG:3067', 'EPSG:4326', p) as Point },
];
