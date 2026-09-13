import { expect, it } from 'vitest';
import * as THREE from 'three';
import { makePool } from './water';
import { createObject } from '../model/factory';
import { rectangle } from '../model/geometry';
import type { MaterialLibrary } from './materials';

it('keeps overview pool holes and depth without tessellation or a transmission pass', () => {
  const pool = createObject('zone', [0, 0], 'floor');
  pool.rings = [rectangle([0, 0], 20, 16), rectangle([0, 0], 2, 2)];
  pool.water = { depth: 2 };
  const material = new THREE.MeshStandardMaterial();
  const materials = { get: () => material, metal: () => material } as unknown as MaterialLibrary;
  const overview = makePool(pool, p => p, 0, materials, { value: 0 }, false);
  const detailed = makePool(pool, p => p, 0, materials, { value: 0 }, true);
  const surface = (group: THREE.Group) => group.children.find(o => o.userData.water) as THREE.Mesh;
  const flat = surface(overview),
    waves = surface(detailed);
  expect(flat.material).toBeInstanceOf(THREE.MeshBasicMaterial);
  expect((waves.material as THREE.MeshPhysicalMaterial).transmission).toBeGreaterThan(0.9);
  expect(flat.geometry.getAttribute('position').count).toBeLessThan(waves.geometry.getAttribute('position').count / 10);
  overview.updateMatrixWorld(true);
  const ray = new THREE.Raycaster(new THREE.Vector3(0, 0, 5), new THREE.Vector3(0, 0, -1));
  expect(ray.intersectObject(flat)).toHaveLength(0);
  ray.set(new THREE.Vector3(5, 0, 5), new THREE.Vector3(0, 0, -1));
  expect(ray.intersectObject(flat)[0].point.z).toBeCloseTo(-0.08);
  const bottom = overview.children[0] as THREE.Mesh;
  expect(ray.intersectObject(bottom)[0].point.z).toBeCloseTo(-2);
  for (const group of [overview, detailed])
    group.traverse(o => {
      if (o instanceof THREE.Mesh) {
        o.geometry.dispose();
        if (o.material !== material) o.material.dispose();
      }
    });
  material.dispose();
});
