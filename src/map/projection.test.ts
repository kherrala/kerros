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

import { walkNearPlane } from './projection';

describe('POV wall clipping', () => {
  it('keeps a wall 28 cm from the eye visible at all viewports, pitches and FOVs', () => {
    for (const fov of [60, 100, 120])
      for (const pitch of [35, 86, 89])
        for (const scale of [0.1, 1, 19]) {
          const camera = new PerspectiveCamera(fov, 1.6, 2, 4000);
          camera.up.set(0, 0, 1);
          camera.position.set(10, 20, 2);
          const forward = new Vector3(0, Math.sin((pitch * Math.PI) / 180), -Math.cos((pitch * Math.PI) / 180));
          camera.lookAt(camera.position.clone().add(forward));
          camera.updateMatrixWorld(true);
          const matrix = camera.projectionMatrix.clone().multiply(camera.matrixWorldInverse).multiplyScalar(scale);
          const before = matrix.clone();
          walkNearPlane(matrix, 2 * scale, 4000 * scale);
          const wall = camera.position.clone().addScaledVector(forward, 0.28);
          const clip = wall.clone().applyMatrix4(matrix);
          expect(clip.z).toBeGreaterThan(-1);
          expect(clip.z).toBeLessThan(1);
          expect(clip.x).toBeCloseTo(wall.clone().applyMatrix4(before).x, 8);
          expect(clip.y).toBeCloseTo(wall.clone().applyMatrix4(before).y, 8);
          const recovered = new Camera();
          syncLightingCamera(recovered, matrix, matrix.clone().invert());
          expect(recovered.position.distanceTo(camera.position)).toBeLessThan(1e-8);
        }
  });
});
