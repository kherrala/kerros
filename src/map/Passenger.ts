import * as THREE from 'three';
import { REFLECTION_BODY } from './CabinMirror';

/** A small articulated passenger: tailored jacket, trousers, shoes and a recognisable face.
 * The view uses the lower body; reflections include the head and shoulders. All motion follows
 * the actual walker, so a mirror shows a passenger at the correct location, not a painted figure. */
export class Passenger extends THREE.Group {
  private head = new THREE.Group();
  private arms: THREE.Group[] = [];
  private elbows: THREE.Group[] = [];
  private legs: THREE.Group[] = [];
  private knees: THREE.Group[] = [];
  private previous?: THREE.Vector3;
  private phase = 0;
  private yaw?: number;
  private waveUntil = 0;
  constructor(environment: THREE.Texture) {
    super();
    this.name = 'POV passenger';
    this.userData.passenger = true;
    const material = (color: string, roughness = 0.8) =>
      new THREE.MeshStandardMaterial({ color, roughness, envMap: environment, envMapIntensity: 1.2 });
    const jacket = material('#425563'),
      shirt = material('#ddd7c7'),
      trousers = material('#29303b'),
      shoes = material('#242323', 0.48),
      skin = material('#bc8f73'),
      hair = material('#302823'),
      eye = material('#292b2b');
    const add = (
      parent: THREE.Object3D,
      geo: THREE.BufferGeometry,
      mat: THREE.Material,
      at: number[],
      scale?: number[],
    ) => {
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(at[0], at[1], at[2]);
      if (scale) mesh.scale.set(scale[0], scale[1], scale[2]);
      mesh.castShadow = mesh.receiveShadow = true;
      parent.add(mesh);
      return mesh;
    };
    const sphere = (parent: THREE.Object3D, mat: THREE.Material, at: number[], scale: number[]) =>
      add(parent, new THREE.SphereGeometry(1, 16, 12), mat, at, scale);
    const limb = (parent: THREE.Object3D, mat: THREE.Material, length: number, radius: number) =>
      add(parent, new THREE.CapsuleGeometry(radius, length - 2 * radius, 4, 10).rotateX(Math.PI / 2), mat, [
        0,
        0,
        -length / 2,
      ]);
    const torso = add(
      this,
      new THREE.CylinderGeometry(0.21, 0.17, 0.5, 12).rotateX(Math.PI / 2),
      jacket,
      [0, -0.06, 1.18],
      [1, 0.56, 1],
    );
    torso.layers.set(REFLECTION_BODY);
    const chest = add(this, new THREE.BoxGeometry(0.11, 0.015, 0.3), shirt, [0, 0.065, 1.29]);
    chest.layers.set(REFLECTION_BODY);
    const zipper = add(this, new THREE.BoxGeometry(0.012, 0.016, 0.43), trousers, [0, 0.072, 1.18]);
    zipper.layers.set(REFLECTION_BODY);
    const neck = sphere(this, skin, [0, -0.06, 1.48], [0.058, 0.055, 0.115]);
    neck.layers.set(REFLECTION_BODY);
    sphere(this, trousers, [0, -0.055, 0.88], [0.175, 0.125, 0.13]);
    this.head.position.set(0, -0.06, 1.51);
    this.add(this.head);
    sphere(this.head, skin, [0, 0, 0.16], [0.125, 0.11, 0.16]);
    sphere(this.head, hair, [0, -0.027, 0.24], [0.128, 0.106, 0.095]);
    sphere(this.head, skin, [0, 0.11, 0.145], [0.029, 0.034, 0.035]);
    for (const side of [-1, 1]) {
      sphere(this.head, shirt, [side * 0.047, 0.099, 0.194], [0.025, 0.014, 0.012]);
      sphere(this.head, eye, [side * 0.047, 0.112, 0.194], [0.009, 0.005, 0.009]);
      sphere(this.head, skin, [side * 0.126, -0.003, 0.16], [0.019, 0.023, 0.037]);
      const shoulder = new THREE.Group();
      shoulder.position.set(side * 0.225, -0.04, 1.41);
      this.add(shoulder);
      sphere(shoulder, jacket, [0, 0, -0.04], [0.073, 0.071, 0.077]);
      limb(shoulder, jacket, 0.29, 0.071);
      const elbow = new THREE.Group();
      elbow.position.z = -0.29;
      shoulder.add(elbow);
      sphere(elbow, jacket, [0, 0, 0], [0.06, 0.06, 0.06]);
      limb(elbow, jacket, 0.27, 0.06);
      sphere(elbow, skin, [0, 0, -0.3], [0.045, 0.034, 0.07]);
      this.arms.push(shoulder);
      this.elbows.push(elbow);
      const hip = new THREE.Group();
      hip.position.set(side * 0.105, -0.055, 0.87);
      this.add(hip);
      limb(hip, trousers, 0.4, 0.085);
      const knee = new THREE.Group();
      knee.position.z = -0.4;
      hip.add(knee);
      sphere(knee, trousers, [0, 0, 0], [0.066, 0.066, 0.066]);
      limb(knee, trousers, 0.39, 0.065);
      sphere(knee, shoes, [0, 0.06, -0.415], [0.085, 0.155, 0.055]);
      this.legs.push(hip);
      this.knees.push(knee);
    }
    this.head.traverse(o => o.layers.set(REFLECTION_BODY));
  }
  wave(now: number) {
    this.waveUntil = now + 2.8;
  }
  update(eye: THREE.Vector3, forward: THREE.Vector3, seconds: number, dt: number) {
    const moved = this.previous ? Math.min(0.15, eye.distanceTo(this.previous)) : 0;
    this.previous = eye.clone();
    this.phase += moved * 9;
    const target = Math.atan2(-forward.x, forward.y);
    this.yaw ??= target;
    const delta = Math.atan2(Math.sin(target - this.yaw), Math.cos(target - this.yaw));
    this.yaw += Math.max(-dt * 3.5, Math.min(dt * 3.5, delta));
    this.position.copy(eye);
    this.position.z -= 1.7;
    this.rotation.z = this.yaw;
    this.head.rotation.z = Math.max(-0.9, Math.min(0.9, delta));
    this.head.rotation.x = Math.max(-0.55, Math.min(0.55, Math.asin(forward.z)));
    const stride = moved > 0.0005 ? Math.sin(this.phase) * 0.36 : 0;
    for (let i = 0; i < 2; i++) {
      const step = stride * (i ? 1 : -1);
      this.legs[i].rotation.x = step;
      this.knees[i].rotation.x = Math.max(0, -step) * 1.1;
      this.arms[i].rotation.x = -step * 0.7;
      this.arms[i].rotation.y = (i ? -1 : 1) * 0.06;
      this.elbows[i].rotation.x = -0.13;
      this.elbows[i].rotation.y = 0;
    }
    const waving = seconds < this.waveUntil;
    if (waving) {
      this.arms[1].rotation.x = 0.2;
      this.arms[1].rotation.y = -2.4;
      this.elbows[1].rotation.y = Math.sin(seconds * 12) * 0.25;
    }
    this.userData.waving = waving;
    return waving || Math.abs(delta) > 0.01;
  }
}
