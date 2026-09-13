import { describe, expect, it } from 'vitest';
import { Camera, Matrix4, PerspectiveCamera, Vector3 } from 'three';
import { syncLightingCamera } from './projection';
import { mirrorViewCamera } from './CabinMirror';
import { doorLeafSlice } from './ElevatorCabin';
import { cabinDimensions, cabinFloorVoids } from './elevators';
import { newProject } from '../model/testFixtures';
import { createObject } from '../model/factory';
import { ringArea } from '../model/geometry';

describe('elevator rendering geometry', () => {
  it('replaces the landing finish with the car floor at every served level, including the bottom', () => {
    const p = newProject();
    p.floors.push({ ...p.floors[0], id: 'basement', elevation: -5 });
    const lift = createObject('elevator', [3, 2], 'basement');
    lift.width = 2.4;
    lift.depth = 2.2;
    lift.rotation = 37;
    lift.servedFloorIds = p.floors.map(f => f.id);
    p.objects.push(lift);
    const size = cabinDimensions(lift);
    for (const floor of p.floors) {
      const cuts = cabinFloorVoids(p, floor.id, new Set([lift.id]));
      expect(cuts).toHaveLength(1);
      expect(ringArea(cuts[0])).toBeCloseTo(size.width * size.depth);
    }
    expect(cabinFloorVoids(p, 'unserved', new Set([lift.id]))).toEqual([]);
    expect(cabinFloorVoids(p, 'basement', new Set())).toEqual([]);
  });
  it('keeps the visible door leaf inside its pocket throughout opening', () => {
    for (const gap of [0.7, 1.2, 1.6])
      for (const sign of [-1, 1])
        for (let i = 0; i <= 100; i++) {
          const slice = doorLeafSlice(gap, sign, i / 100);
          expect(Math.abs(slice.center) + slice.width / 2).toBeLessThanOrEqual(gap / 2 + 1e-10);
          expect(slice.width).toBeGreaterThanOrEqual(0);
          if (i === 100) expect(slice.width).toBe(0);
        }
  });
  it.each([0, 35, 110, 270])(
    'preserves the map projection when giving the mirror an oriented camera at %s degrees',
    angle => {
      const source = new PerspectiveCamera(65, 1.6, 0.02, 300);
      source.up.set(0, 0, 1);
      source.position.set(0.3, -0.5, 2.03);
      source.lookAt(Math.sin((angle * Math.PI) / 180), Math.cos((angle * Math.PI) / 180), 1.8);
      source.updateMatrixWorld(true);
      // Mercator carries a non-unit homogeneous scale; this must not reach the mirror's
      // oblique near-plane formula (which assumes the perspective row ends in -1, 0).
      const combined = source.projectionMatrix.clone().multiply(source.matrixWorldInverse).multiplyScalar(0.00003);
      const mapCamera = new Camera();
      syncLightingCamera(mapCamera, combined, combined.clone().invert());
      const oriented = new PerspectiveCamera();
      mirrorViewCamera(mapCamera, oriented);
      const restored = oriented.projectionMatrix.clone().multiply(oriented.matrixWorldInverse);
      for (const p of [new Vector3(0, 1, 0.5), new Vector3(-2, 0, 1.8), new Vector3(2, 2, 3)])
        expect(p.clone().applyMatrix4(restored).distanceTo(p.clone().applyMatrix4(combined))).toBeLessThan(1e-8);
      expect(oriented.matrixWorld.determinant()).toBeCloseTo(1);
      expect(oriented.projectionMatrix.elements[2]).toBeCloseTo(0);
      expect(oriented.projectionMatrix.elements[6]).toBeCloseTo(0);
      expect(oriented.projectionMatrix.elements[11]).toBeCloseTo(-1);
      expect(
        new Matrix4().copy(oriented.projectionMatrixInverse).multiply(oriented.projectionMatrix).elements[0],
      ).toBeCloseTo(1);
    },
  );
});
