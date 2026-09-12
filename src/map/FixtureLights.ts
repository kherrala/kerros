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
/** How many of those throw shadows. A shadowed lamp is six shadow passes when it moves and a cube
 *  of shadow taps on every pixel every frame; the two nearest carry the room, and the two beyond
 *  them light without shadow, which nobody notices past the first two. The count is held constant
 *  — an empty slot keeps its flag — because the shader is compiled for a number of shadowed lights
 *  and changing that number recompiles every material in the scene. */
export const SHADOWED_FIXTURE_LIGHTS = 2;

/** All fittings are two instanced draws. Only the nearest few cast light/shadows, keeping the
 * shader and shadow-map budget constant whether the document contains ten lamps or ten thousand. */
export class FixtureLights {
  private points: THREE.Vector3[];
  private colors: THREE.Color[];
  private emitters: THREE.InstancedMesh;
  private lights: THREE.PointLight[];
  private active: (number | undefined)[] = [];
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
      light.castShadow = false;
      // Each lamp's shadow is six passes over the scene, and they are redrawn only when the lamp
      // itself changes — see update(). Left on automatic, every one of them would be redrawn each
      // time anything at all asked for shadows, the sun included.
      light.shadow.autoUpdate = false;
      light.shadow.mapSize.set(256, 256);
      light.shadow.camera.near = 0.1;
      light.shadow.bias = -0.001;
      light.shadow.normalBias = 0.025;
      scene.add(light);
      return light;
    });
    this.lights.slice(0, SHADOWED_FIXTURE_LIGHTS).forEach(light => {
      light.castShadow = true;
    });
  }
  /** The shadows go to the nearest lamps, and stay with them until a lamp without one is clearly
   *  nearer — a swap redraws a shadow, so a walker straddling two lamps must not swap on every step.
   *  Always exactly SHADOWED_FIXTURE_LIGHTS flags are set, empty slots included: see the constant. */
  private assignShadows(eye: THREE.Vector3) {
    const active = this.lights.map((light, slot) => ({ light, slot, i: this.active[slot] }));
    const lit = active.filter(a => a.i !== undefined);
    const distance = (a: (typeof lit)[number]) => this.points[a.i!].distanceToSquared(eye);
    const nearest = [...lit].sort((a, b) => distance(a) - distance(b));
    const casters = new Set(lit.filter(a => a.light.castShadow));
    // Promote a lamp only when it is nearer than a current caster by a margin: 1.3 in squared
    // distance is about 14 % in metres, a clear step and not a wobble.
    for (const a of nearest.slice(0, SHADOWED_FIXTURE_LIGHTS)) {
      if (casters.has(a)) continue;
      const worst = [...casters].sort((x, y) => distance(y) - distance(x))[0];
      if (worst && distance(a) * 1.3 < distance(worst)) {
        casters.delete(worst);
        casters.add(a);
      } else if (casters.size < SHADOWED_FIXTURE_LIGHTS) casters.add(a);
    }
    // Pad with empty slots so the number of shadowed lights never changes.
    for (const a of active) if (casters.size < SHADOWED_FIXTURE_LIGHTS && a.i === undefined) casters.add(a);
    for (const a of active) {
      const cast = casters.has(a);
      if (cast && !a.light.castShadow) a.light.shadow.needsUpdate = true;
      a.light.castShadow = cast;
    }
  }
  /** Every lamp's shadow is stale — the scene changed under them. */
  invalidate() {
    for (const light of this.lights) light.shadow.needsUpdate = true;
  }
  update(eye: THREE.Vector3, seconds: number) {
    const ranked = this.points
      .map((at, i) => ({ i, distance: at.distanceToSquared(eye) }))
      .filter(
        ({ i, distance }) => this.fixtures[i].light!.intensity > 0 && distance < this.fixtures[i].light!.range ** 2,
      )
      .sort((a, b) => a.distance - b.distance)
      .map(c => c.i);
    // A lamp keeps its slot for as long as it is lit and near: swapping a lamp means redrawing its
    // shadow, six passes over everything it can reach, so the assignment has to be stable under a
    // walker's ordinary jitter. Re-sorting by distance every frame was not — two lamps at similar
    // range traded slots on every step and every step redrew both. A lamp stays while it ranks
    // within one place of the cut, so a lamp on the boundary does not flicker in and out either.
    const wanted = ranked.slice(0, this.lights.length);
    const keep = new Set(ranked.slice(0, this.lights.length + 1));
    const next: (number | undefined)[] = this.lights.map((_, slot) => {
      const i = this.active[slot];
      return i !== undefined && keep.has(i) ? i : undefined;
    });
    for (const i of wanted) {
      if (next.includes(i)) continue;
      const free = next.indexOf(undefined);
      if (free < 0) break;
      next[free] = i;
    }
    let shadowsChanged = false;
    this.lights.forEach((light, slot) => {
      const i = next[slot];
      if (this.active[slot] !== i) {
        shadowsChanged = true;
        light.shadow.needsUpdate = true;
      }
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
    this.active = next;
    this.assignShadows(eye);
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
