import * as THREE from 'three';
import { Reflector } from 'three/addons/objects/Reflector.js';

/** The head is visible in the mirror, but never surrounds the first-person camera. */
export const REFLECTION_BODY = 29;

/** MapLibre's camera encodes rotation in its projection matrix. Give the mirror a conventional
 * view frame while preserving the exact world-to-clip mapping, including the chosen POV lens. */
export function mirrorViewCamera(source: THREE.Camera, target: THREE.PerspectiveCamera) {
  const inverse = source.projectionMatrixInverse.clone().premultiply(source.matrixWorld);
  const ahead = new THREE.Vector3(0, 0, 0).applyMatrix4(inverse);
  const above = new THREE.Vector3(0, 0.5, 0).applyMatrix4(inverse);
  target.position.copy(source.position);
  target.up.copy(above).sub(ahead).normalize();
  target.lookAt(ahead);
  target.updateMatrixWorld(true);
  target.projectionMatrix
    .copy(source.projectionMatrix)
    .multiply(source.matrixWorldInverse)
    .multiply(target.matrixWorld);
  // The map's homogeneous matrix carries its metre-to-Mercator scale. Reflector's oblique
  // near-plane formula requires the conventional perspective row with P[3,2] = -1.
  const scale = -1 / target.projectionMatrix.elements[11];
  target.projectionMatrix.multiplyScalar(scale);
  target.projectionMatrixInverse.copy(target.projectionMatrix).invert();
  target.layers.mask = source.layers.mask;
  target.layers.enable(REFLECTION_BODY);
  target.far = 10000;
}

/** One live planar reflection, rendered only near a visible cabin. No recursive mirror passes. */
export class CabinMirror extends Reflector {
  private view = new THREE.PerspectiveCamera();
  private frames = 0;
  constructor(width: number, height: number) {
    super(new THREE.PlaneGeometry(width, height), {
      textureWidth: 768,
      textureHeight: 768,
      multisample: 0,
      color: '#c7d1d4',
      clipBias: 0.002,
    });
    this.name = 'Cabin mirror';
    this.userData.cabinMirror = true;
    const reflect = this.onBeforeRender;
    this.onBeforeRender = (renderer, scene, camera, geometry, material, group) => {
      if (camera.userData.cabinReflection) return;
      const at = new THREE.Vector3().setFromMatrixPosition(this.matrixWorld);
      if (at.distanceToSquared(camera.position) > 100) return;
      mirrorViewCamera(camera, this.view);
      this.camera.userData.cabinReflection = true;
      this.camera.layers.mask = this.view.layers.mask;
      const viewport = renderer.getViewport(new THREE.Vector4());
      try {
        reflect.call(this, renderer, scene, this.view, geometry, material, group);
        this.userData.reflectionFrames = ++this.frames;
      } finally {
        renderer.setViewport(viewport);
      }
    };
  }
}
