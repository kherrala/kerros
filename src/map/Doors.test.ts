import { expect, it } from 'vitest';
import * as THREE from 'three';
import { makeDoor } from './Doors';
import { createObject } from '../model/factory';
import type { MaterialLibrary } from './materials';

const material = new THREE.MeshStandardMaterial({ side: THREE.DoubleSide });
const materials = { get: () => material, metal: () => material, solid: () => material } as unknown as MaterialLibrary;

it.each(['hinged', 'sliding', 'double'] as const)(
  '%s doors close the aperture and clear its centre when open, on both sides',
  doorType => {
    for (const doorHinge of ['left', 'right'] as const)
      for (const doorSwing of [1, -1] as const) {
        const door = createObject('door', [0, 0], 'floor');
        Object.assign(door, { doorType, doorHinge, doorSwing, width: doorType === 'double' ? 1.8 : 0.95 });
        const model = makeDoor(door, 0.3, 2.15, materials);
        expect(model.panels).toHaveLength(doorType === 'double' ? 2 : 1);
        const ray = new THREE.Raycaster(
          new THREE.Vector3(0.04, doorSwing * 3, 1.2),
          new THREE.Vector3(0, -doorSwing, 0),
          0,
          6,
        );
        const hit = (open: number) => {
          model.panels.forEach(panel => {
            panel.setOpen(open);
            panel.group.updateMatrixWorld(true);
          });
          return ray.intersectObjects(
            model.panels.map(p => p.group),
            true,
          );
        };
        expect(hit(0).length).toBeGreaterThan(0);
        expect(hit(1)).toHaveLength(0);
        expect(hit(0).length).toBeGreaterThan(0);
        for (const root of [model.frame, ...model.panels.map(p => p.group)])
          root.traverse(o => {
            if (o instanceof THREE.Mesh) {
              expect(o.userData.entityId).toBe(door.id);
              o.geometry.dispose();
            }
          });
      }
  },
);
