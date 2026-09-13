import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { SiteObject } from '../model/types';
import type { MaterialLibrary } from './materials';
import { metricUVs } from './surfaces';

/** Local metres: X along the opening, Y toward side A, Z up. Hardware moves with its leaf. */
export function makeDoor(door: SiteObject, wallDepth: number, height: number, materials: MaterialLibrary) {
  const frame = new THREE.Group(),
    width = door.width,
    side = door.doorSwing ?? 1;
  const wood = materials.get('veneer', door.color ?? '#cab69a');
  const trim = materials.get('plaster', '#e1ded5'),
    metal = materials.metal('#aab0b2');
  const dark = materials.solid('#414448'),
    inset = materials.get('veneer', door.color ?? '#c0aa8d');
  const box = (
    parent: THREE.Group,
    w: number,
    d: number,
    h: number,
    x: number,
    y: number,
    z: number,
    material: THREE.Material,
  ) => {
    if (w <= 0 || d <= 0 || h <= 0) return;
    const geometry = new THREE.BoxGeometry(w, d, h);
    geometry.translate(x, y, z);
    metricUVs(geometry);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.castShadow = mesh.receiveShadow = true;
    mesh.userData.entityId = door.id;
    parent.add(mesh);
  };
  // Recessed jambs and architraves on both sides, with a metal threshold at floor level.
  for (const sign of [-1, 1]) {
    box(frame, 0.035, wallDepth + 0.025, height, sign * (width / 2 - 0.0175), 0, height / 2, trim);
    for (const face of [-1, 1])
      box(
        frame,
        0.07,
        0.025,
        height + 0.035,
        sign * (width / 2 + 0.005),
        face * (wallDepth / 2 + 0.012),
        (height + 0.035) / 2,
        trim,
      );
  }
  box(frame, width, wallDepth + 0.025, 0.035, 0, 0, height - 0.0175, trim);
  for (const face of [-1, 1]) box(frame, width + 0.08, 0.025, 0.07, 0, face * (wallDepth / 2 + 0.012), height, trim);
  box(frame, width, wallDepth + 0.04, 0.012, 0, 0, 0.006, metal);

  const panels: { group: THREE.Group; setOpen: (value: number) => void }[] = [];
  const sliding = door.doorType === 'sliding',
    double = door.doorType === 'double';
  const travel = door.doorHinge === 'right' ? 1 : -1;
  const leafWidth = (double ? width / 2 : width) - (double ? 0.025 : 0.045);
  for (let i = 0; i < (double ? 2 : 1); i++) {
    const hand = double ? (i ? -1 : 1) : door.doorHinge === 'right' ? -1 : 1;
    const group = new THREE.Group(),
      pivot = new THREE.Group();
    group.add(pivot);
    pivot.position.x = sliding ? 0 : (-hand * width) / 2;
    pivot.position.y = sliding ? side * (wallDepth / 2 + 0.045) : 0;
    const x = sliding ? 0 : hand * (leafWidth / 2 + 0.025),
      h = height - 0.06,
      bottom = 0.02;
    box(pivot, leafWidth, 0.045, h, x, 0, bottom + h / 2, wood);
    // A shallow inset panel, narrow stile borders and a kick plate give depth at eye level.
    for (const face of [-1, 1]) {
      box(
        pivot,
        Math.max(0.1, leafWidth - 0.16),
        0.006,
        Math.max(0.2, h - 0.38),
        x,
        face * 0.025,
        bottom + h / 2 + 0.03,
        inset,
      );
      box(pivot, Math.max(0.1, leafWidth - 0.1), 0.008, 0.13, x, face * 0.027, 0.13, metal);
      const latch = x + (sliding ? -travel : hand) * (leafWidth / 2 - 0.09);
      if (sliding) {
        box(pivot, 0.026, 0.035, 0.3, latch, face * 0.047, 1.03, metal);
      } else {
        box(pivot, 0.052, 0.012, 0.12, latch, face * 0.033, 1.03, metal);
        box(pivot, 0.11, 0.024, 0.021, latch - hand * 0.035, face * 0.067, 1.06, metal);
        box(pivot, 0.017, 0.012, 0.028, latch, face * 0.042, 1.0, dark);
      }
    }
    if (!sliding) for (const z of [0.25, h / 2, h - 0.22]) box(pivot, 0.025, 0.058, 0.09, hand * 0.025, 0, z, metal);
    mergeParts(pivot);
    group.traverse(child => {
      if (child instanceof THREE.Mesh) child.userData.entityId = door.id;
    });
    group.userData.doorType = door.doorType ?? 'hinged';
    group.userData.entityId = door.id;
    panels.push({
      group,
      setOpen: value => {
        if (sliding) pivot.position.x = travel * (width + 0.03) * value;
        else pivot.rotation.z = side * hand * THREE.MathUtils.degToRad(72) * value;
      },
    });
  }
  if (sliding) {
    const y = side * (wallDepth / 2 + 0.065);
    box(frame, width * 2 + 0.12, 0.05, 0.065, (travel * width) / 2, y, height + 0.12, metal);
    for (const x of [-width / 2, width / 2, travel * width]) box(frame, 0.045, 0.08, 0.13, x, y, height + 0.1, dark);
  }
  return { frame, panels };
}

/** Each articulated leaf costs one draw per finish, rather than one per handle or trim strip. */
function mergeParts(group: THREE.Group) {
  const buckets = new Map<THREE.Material, THREE.BufferGeometry[]>();
  for (const child of [...group.children]) {
    const mesh = child as THREE.Mesh<THREE.BufferGeometry, THREE.Material>;
    const list = buckets.get(mesh.material) ?? [];
    list.push(mesh.geometry);
    buckets.set(mesh.material, list);
    group.remove(mesh);
  }
  for (const [material, parts] of buckets) {
    const mesh = new THREE.Mesh(mergeGeometries(parts)!, material);
    mesh.castShadow = mesh.receiveShadow = true;
    group.add(mesh);
    parts.forEach(p => p.dispose());
  }
}
