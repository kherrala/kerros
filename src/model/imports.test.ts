import { describe, expect, it } from 'vitest';
import { importFootprints } from './imports';
import { newProject } from './testFixtures';
import { rectangle, toLngLat } from './geometry';
import type { Point } from './types';

describe('footprint imports', () => {
  it('imports lng/lat and via a host projection converter to the same local geometry', () => {
    const project = newProject();
    const ring = rectangle([0, 0], 40, 30);
    // 1) plain lng/lat (no converter). 2) a made-up metric frame (offset by 1000,2000) with a converter
    //    that maps it back to lng/lat — the host-supplied projection path.
    const cases: [Point[], ((p: Point) => Point) | undefined][] = [
      [ring.map(p => toLngLat(p, project.origin)), undefined],
      [
        ring.map(p => [p[0] + 1000, p[1] + 2000] as Point),
        (q: Point) => toLngLat([q[0] - 1000, q[1] - 2000], project.origin),
      ],
    ];
    for (const [coordinates, toLngLatConv] of cases) {
      const [object] = importFootprints(
        { type: 'Polygon', coordinates: [coordinates] },
        project,
        'building',
        toLngLatConv,
      );
      expect(object.width).toBeCloseTo(40, 4);
      expect(object.depth).toBeCloseTo(30, 4);
      expect(object.position[0]).toBeCloseTo(0, 4);
      expect(object.rings?.[0][0][1]).toBeCloseTo(-15, 4);
    }
  });
  it('rejects out-of-range lng/lat, non-polygon data, and empty collections', () => {
    expect(() =>
      importFootprints(
        {
          type: 'Polygon',
          coordinates: [
            [
              [400000, 6000000],
              [400100, 6000000],
              [400100, 6000100],
            ],
          ],
        },
        newProject(),
        'building',
      ),
    ).toThrow(/bounds/);
    expect(() => importFootprints({ type: 'Point', coordinates: [24, 60] }, newProject(), 'parcel')).toThrow(/Polygon/);
    expect(() => importFootprints({ type: 'FeatureCollection', features: [] }, newProject(), 'parcel')).toThrow(
      /no features/,
    );
  });
});
