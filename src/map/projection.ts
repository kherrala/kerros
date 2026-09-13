import type { Box3, Camera, Matrix4 } from 'three';

/** Split the map's combined matrix so PBR shading sees the same eye as projection and picking.
 * Keeping the camera axes in world space avoids decomposing Mercator's reflected Y axis. */
export function syncLightingCamera(camera: Camera, worldToClip: Matrix4, clipToWorld: Matrix4) {
  const e = clipToWorld.elements;
  if (Math.abs(e[11]) < 1e-12) return;
  camera.position.set(e[8] / e[11], e[9] / e[11], e[10] / e[11]);
  camera.updateMatrixWorld(true);
  camera.projectionMatrix.copy(worldToClip).multiply(camera.matrixWorld);
  camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
}

/** Extend a Mercator scene's far plane without changing its screen position or near plane. */
export function includeSceneDepth(matrix: Matrix4, bounds: Box3, scaleZ: number, near: number, far: number) {
  if (bounds.isEmpty() || !(near > 0 && far > near)) return;
  const e = matrix.elements,
    { min, max } = bounds;
  // Perspective clip W is camera distance, in the same units as MapLibre's nearZ/farZ.
  // Maximise its linear expression over the cached box; no vertex scan while panning.
  const distance =
    e[15] +
    Math.max(e[3] * min.x, e[3] * max.x) +
    Math.max(e[7] * min.y, e[7] * max.y) +
    Math.max(e[11] * min.z * scaleZ, e[11] * max.z * scaleZ);
  const extendedFar = distance * 1.01;
  if (!Number.isFinite(extendedFar) || extendedFar <= far) return;

  // Z = A * viewZ + B, W = -viewZ. Replace only the depth row with k*Z + t*W.
  // Keeping X/Y/W untouched preserves the precise basemap alignment. A finite far plane
  // also keeps inverse-projected picking rays valid at NDC z=1.
  const oldA = -(far + near) / (far - near);
  const newA = -(extendedFar + near) / (extendedFar - near);
  const k = extendedFar / (extendedFar - near) / (far / (far - near));
  const t = k * oldA - newA;
  for (let i = 0; i < 16; i += 4) e[i + 2] = k * e[i + 2] + t * e[i + 3];
}

/** MapLibre's near distance follows viewport pixels and can cut away a wall before the walker
 * touches it. Give POV a 4 cm near plane in scene metres, preserving the eye, X/Y and far plane. */
export function walkNearPlane(matrix: Matrix4, near: number, far: number): number {
  const e = matrix.elements;
  const next = Math.min(near, 0.04 * Math.hypot(e[3], e[7], e[11]));
  if (!(next > 0 && near > 0 && far > near)) return near;
  const oldA = -(far + near) / (far - near),
    newA = -(far + next) / (far - next);
  const k = next / (far - next) / (near / (far - near));
  const t = k * oldA - newA;
  for (let i = 0; i < 16; i += 4) e[i + 2] = k * e[i + 2] + t * e[i + 3];
  return next;
}
