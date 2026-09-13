import * as THREE from 'three';
import type { SiteObject } from '../model/types';
import { elevatorDoorWidth, elevatorMirrorFace } from './elevators';
import { CabinMirror } from './CabinMirror';
import type { CabinMaterials } from './CabinMaterials';

export const FACE_TURN = { front: 0, right: 90, back: 180, left: 270 };

export function makeElevatorCabin(
  o: SiteObject,
  height: number,
  finish: CabinMaterials,
  floorCode: string,
  moving: boolean,
) {
  const group = new THREE.Group();
  group.name = 'Detailed elevator cabin';
  group.userData.cabin = true;
  const box = (
    parent: THREE.Object3D,
    w: number,
    d: number,
    h: number,
    x: number,
    y: number,
    z: number,
    material: THREE.Material,
  ) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, d, h), material);
    mesh.position.set(x, y, z);
    mesh.castShadow = mesh.receiveShadow = true;
    parent.add(mesh);
    return mesh;
  };
  const floor = box(group, o.width, o.depth, 0.08, 0, 0, -0.04, finish.floor);
  floor.name = 'Cabin stone floor';
  floor.userData.cabinFloor = true;
  box(group, o.width, o.depth, 0.07, 0, 0, height, finish.wall);
  // Stone floor panels, with dark narrow joints and a steel threshold.
  for (let x = -o.width / 2 + 0.6; x < o.width / 2; x += 0.6)
    box(group, 0.008, o.depth, 0.003, x, 0, 0.002, finish.dark);
  for (let y = -o.depth / 2 + 0.6; y < o.depth / 2; y += 0.6)
    box(group, o.width, 0.008, 0.003, 0, y, 0.002, finish.dark);
  for (const side of [-1, 1]) {
    box(group, 0.22, o.depth * 0.7, 0.025, side * o.width * 0.3, 0, height - 0.05, finish.trim);
    box(group, 0.17, o.depth * 0.67, 0.026, side * o.width * 0.3, 0, height - 0.065, finish.lamp);
  }
  for (let i = 0; i < 9; i++) box(group, 0.36, 0.015, 0.012, 0, (i - 4) * 0.045, height - 0.045, finish.dark);
  const mirrorFace = elevatorMirrorFace(o);
  for (const [face, turn] of Object.entries(FACE_TURN) as [keyof typeof FACE_TURN, number][]) {
    const wall = new THREE.Group();
    wall.rotation.z = (turn * Math.PI) / 180;
    group.add(wall);
    const across = turn % 180 ? o.depth : o.width,
      depth = turn % 180 ? o.width : o.depth;
    const y = depth / 2 - 0.045,
      inside = y - 0.055;
    const hasDoor = (o.doorSides ?? ['front']).includes(face),
      gap = elevatorDoorWidth(o, turn);
    if (hasDoor) {
      const jamb = Math.max(0.04, (across - gap) / 2);
      for (const side of [-1, 1]) {
        box(wall, jamb, 0.09, height, side * (gap / 2 + jamb / 2), y, height / 2, finish.steel);
        box(wall, 0.032, 0.045, 2.3, side * (gap / 2 + 0.025), inside - 0.01, 1.15, finish.trim);
      }
      box(wall, gap, 0.09, Math.max(0.05, height - 2.25), 0, y, (height + 2.25) / 2, finish.steel);
      box(wall, gap, 0.22, 0.015, 0, y - 0.045, 0.007, finish.trim);
      // Backlit floor display above the door; visible both directly and in the mirror.
      const canvas = document.createElement('canvas');
      canvas.width = 256;
      canvas.height = 80;
      const c = canvas.getContext('2d')!;
      c.fillStyle = '#101a1f';
      c.fillRect(0, 0, 256, 80);
      c.fillStyle = '#f8ce82';
      c.font = '500 48px monospace';
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.fillText(`${moving ? '↕ ' : ''}${floorCode}`, 128, 42);
      const texture = new THREE.CanvasTexture(canvas);
      texture.colorSpace = THREE.SRGBColorSpace;
      const display = new THREE.MeshBasicMaterial({ map: texture, toneMapped: false });
      display.userData.ownedMap = true;
      const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.42, 0.13), display);
      screen.position.set(0, inside - 0.02, Math.min(height - 0.1, 2.36));
      screen.rotation.x = Math.PI / 2;
      wall.add(screen);
      // A recessed control plate to one side of the entrance. Commands remain in the sidebar.
      const panelX = gap / 2 + jamb / 2;
      box(wall, Math.min(0.22, jamb * 0.85), 0.025, 0.78, panelX, inside - 0.025, 1.26, finish.trim);
      for (let i = 0; i < 5; i++) {
        const button = new THREE.Mesh(
          new THREE.CylinderGeometry(0.019, 0.019, 0.015, 16),
          i === 0 ? finish.display : finish.dark,
        );
        button.position.set(panelX, inside - 0.047, 1.48 - i * 0.105);
        wall.add(button);
      }
    } else {
      box(wall, across, 0.09, height, 0, y, height / 2, finish.wall);
      for (let x = -across / 2 + 0.55; x < across / 2; x += 0.55)
        box(wall, 0.012, 0.008, height - 0.16, x, inside, height / 2, finish.dark);
      box(wall, across, 0.014, 0.15, 0, inside, 0.075, finish.steel);
      if (face === mirrorFace) {
        const width = Math.max(0.35, across - 0.34),
          mirrorHeight = Math.min(1.93, height - 0.42),
          centerZ = 0.26 + mirrorHeight / 2;
        box(wall, width + 0.05, 0.035, mirrorHeight + 0.05, 0, inside - 0.018, centerZ, finish.trim);
        const mirror = new CabinMirror(width, mirrorHeight);
        mirror.position.set(0, inside - 0.041, centerZ);
        mirror.rotation.x = Math.PI / 2;
        wall.add(mirror);
      }
      const rail = new THREE.Mesh(
        new THREE.CylinderGeometry(0.025, 0.025, Math.max(0.25, across - 0.38), 12).rotateZ(Math.PI / 2),
        finish.trim,
      );
      rail.position.set(0, inside - 0.12, 0.94);
      wall.add(rail);
      for (const side of [-1, 1])
        box(wall, 0.035, 0.11, 0.035, side * (across / 2 - 0.28), inside - 0.065, 0.94, finish.trim);
    }
  }
  return group;
}

/** The visible portion of a leaf as it retracts behind the jamb. Clipping at the opening keeps
 * the concealed leaf inside its pocket even on shafts narrower than a full exposed door travel. */
export function doorLeafSlice(gap: number, sign: number, progress: number) {
  const half = gap / 2,
    remaining = half * (1 - Math.max(0, Math.min(1, progress)));
  return { width: Math.max(0, remaining - 0.004), center: sign * (half - remaining / 2) };
}
export function makeCabinDoor(gap: number, height: number, sign: number, finish: CabinMaterials) {
  const group = new THREE.Group();
  group.name = 'Recessed metallic elevator door';
  group.userData.cabinDoor = true;
  const leaf = new THREE.Mesh(new THREE.BoxGeometry(1, 0.065, height), finish.steel);
  leaf.position.z = height / 2;
  leaf.castShadow = leaf.receiveShadow = true;
  group.add(leaf);
  const edge = new THREE.Mesh(new THREE.BoxGeometry(0.006, 0.069, height), finish.trim);
  edge.position.z = height / 2;
  group.add(edge);
  const update = (progress: number) => {
    const slice = doorLeafSlice(gap, sign, progress);
    leaf.visible = edge.visible = slice.width > 0.001;
    leaf.scale.x = slice.width;
    leaf.position.x = slice.center;
    edge.position.x = slice.center - (sign * slice.width) / 2;
    group.userData.openFraction = progress;
  };
  update(0);
  return { group, update };
}
