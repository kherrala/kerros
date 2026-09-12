import * as THREE from 'three';
import type { Point, SiteObject } from '../model/types';
import { kelvinColor } from './lighting';
import type { MaterialLibrary } from './materials';

/** Occasional ballast dropouts, not a regular strobe. Stable per fixture and elapsed time. */
export function fixtureOutput(id: string, seconds: number, flicker = 0): number {
  if (flicker <= 0) return 1;
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (Math.imul(hash, 31) + id.charCodeAt(i)) | 0;
  const phase = (seconds + (hash >>> 0) / 1000) % 7.7;
  const dropout = phase < 0.09 || (phase > 0.18 && phase < 0.25);
  return 1 - flicker * (dropout ? 0.95 : 0.015 * (1 + Math.sin(seconds * 37 + hash)));
}
export const MAX_FIXTURE_LIGHTS = 4;

/** All fittings are two instanced draws. Only the nearest few cast light/shadows, keeping the
 * shader and shadow-map budget constant whether the document contains ten lamps or ten thousand. */
export class FixtureLights {
  private points: THREE.Vector3[];
  private colors: THREE.Color[];
  private emitters: THREE.InstancedMesh;
  private lights: THREE.PointLight[];
  private active: number[] = [];
  private lastFlicker = -Infinity;
  private flickering: boolean;
  constructor(
    scene: THREE.Scene,
    private fixtures: SiteObject[],
    xy: (p: Point) => Point,
    base: number,
    materials: MaterialLibrary,
  ) {
    this.points = fixtures.map(o => new THREE.Vector3(...xy(o.position), base + o.height));
    this.colors = fixtures.map(o => new THREE.Color(kelvinColor(o.light!.kelvin)));
    this.flickering = fixtures.some(o => !!o.light?.flicker);
    const housings = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 1, 1),
      materials.solid('#b6b4a6'),
      fixtures.length,
    );
    this.emitters = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshBasicMaterial({ color: '#ffffff', toneMapped: false }),
      fixtures.length,
    );
    for (const mesh of [housings, this.emitters]) {
      mesh.userData.entityIds = fixtures.map(o => o.id);
      mesh.castShadow = false;
      scene.add(mesh);
    }
    const transform = new THREE.Object3D();
    fixtures.forEach((o, i) => {
      const origin = xy(o.position),
        along = xy([
          o.position[0] + Math.cos((o.rotation * Math.PI) / 180),
          o.position[1] + Math.sin((o.rotation * Math.PI) / 180),
        ]);
      transform.position.copy(this.points[i]);
      transform.rotation.z = Math.atan2(along[1] - origin[1], along[0] - origin[0]);
      transform.scale.set(o.width + 0.08, o.depth + 0.08, 0.09);
      transform.updateMatrix();
      housings.setMatrixAt(i, transform.matrix);
      transform.position.z -= 0.052;
      transform.scale.set(o.width, o.depth, 0.018);
      transform.updateMatrix();
      this.emitters.setMatrixAt(i, transform.matrix);
      this.emitters.setColorAt(i, this.colors[i].clone().multiplyScalar(o.light!.intensity > 0 ? 1 : 0.08));
    });
    this.emitters.instanceColor!.setUsage(THREE.DynamicDrawUsage);
    this.lights = Array.from({ length: Math.min(MAX_FIXTURE_LIGHTS, fixtures.length) }, () => {
      const light = new THREE.PointLight('#fff', 0, 12, 2);
      light.castShadow = true;
      light.shadow.mapSize.set(256, 256);
      light.shadow.camera.near = 0.1;
      light.shadow.bias = -0.001;
      light.shadow.normalBias = 0.025;
      scene.add(light);
      return light;
    });
  }
  update(eye: THREE.Vector3, seconds: number) {
    const candidates = this.points
      .map((at, i) => ({ i, distance: at.distanceToSquared(eye) }))
      .filter(
        ({ i, distance }) => this.fixtures[i].light!.intensity > 0 && distance < this.fixtures[i].light!.range ** 2,
      )
      .sort((a, b) => a.distance - b.distance)
      .slice(0, this.lights.length)
      .map(c => c.i);
    let shadowsChanged = false;
    this.lights.forEach((light, slot) => {
      const i = candidates[slot];
      if (this.active[slot] !== i) shadowsChanged = true;
      if (i === undefined) {
        light.intensity = 0;
        return;
      }
      const o = this.fixtures[i],
        spec = o.light!;
      light.position.copy(this.points[i]);
      light.position.z -= 0.12;
      light.color.copy(this.colors[i]);
      light.distance = spec.range;
      light.intensity = spec.intensity * fixtureOutput(o.id, seconds, spec.flicker);
    });
    this.active = candidates;
    if (this.flickering && seconds - this.lastFlicker >= 0.04) {
      this.fixtures.forEach((o, i) => {
        if (o.light!.flicker)
          this.emitters.setColorAt(
            i,
            this.colors[i]
              .clone()
              .multiplyScalar(o.light!.intensity > 0 ? fixtureOutput(o.id, seconds, o.light!.flicker) : 0.08),
          );
      });
      this.emitters.instanceColor!.needsUpdate = true;
      this.lastFlicker = seconds;
    }
    return { shadowsChanged, animate: this.flickering };
  }
}
