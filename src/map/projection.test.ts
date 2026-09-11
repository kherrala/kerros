import { describe, expect, it } from 'vitest';
import { Camera, Matrix4, PerspectiveCamera, Vector3 } from 'three';
import { syncLightingCamera } from './projection';

describe('map camera lighting', () => {
  it.each([
    [0, -150, 120],
    [160, 80, 45],
    [-40, 10, 400],
  ])('recovers the eye and preserves projection at (%s, %s, %s)', (x, y, z) => {
    const source = new PerspectiveCamera(45, 1.6, 0.2, 4000);
    source.up.set(0, 0, 1);
    source.position.set(x, y, z);
    source.lookAt(12, 8, 0);
    source.updateMatrixWorld(true);
    // Mercator flips Y and scales metres. Lighting must work through that reflection too.
    const transform = new Matrix4().makeScale(0.7, -0.7, 0.7);
    const combined = source.projectionMatrix.clone().multiply(source.matrixWorldInverse).multiply(transform);
    const inverse = combined.clone().invert();
    const camera = new Camera();
    syncLightingCamera(camera, combined, inverse);
    const expectedEye = source.position.clone().applyMatrix4(transform.clone().invert());
    expect(camera.position.distanceTo(expectedEye)).toBeLessThan(1e-8);
    for (const point of [new Vector3(0, 0, 0), new Vector3(20, -10, 32), new Vector3(-40, 30, -15)]) {
      const expected = point.clone().applyMatrix4(combined);
      const actual = point.clone().applyMatrix4(camera.matrixWorldInverse).applyMatrix4(camera.projectionMatrix);
      expect(actual.distanceTo(expected)).toBeLessThan(1e-8);
      expect(expected.clone().applyMatrix4(inverse).distanceTo(point)).toBeLessThan(1e-8);
    }
  });
});
