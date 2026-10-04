import { expect, it } from 'vitest';
import * as THREE from 'three';
import { fenceGeometry } from './fences';

it('keeps railing sightlines open while drawing posts and respecting the gate interval', () => {
  const geometry = fenceGeometry(
    [0, 0],
    [10, 0],
    [
      [2, -0.04],
      [5, -0.04],
      [5, 0.04],
      [2, 0.04],
    ],
    4,
    1.1,
    0.08,
  );
  geometry.computeBoundingBox();
  expect(geometry.boundingBox!.min.x).toBeCloseTo(2);
  expect(geometry.boundingBox!.max.x).toBeCloseTo(5);
  expect(geometry.boundingBox!.min.z).toBeCloseTo(4);
  expect(geometry.boundingBox!.max.z).toBeCloseTo(5.1);
  const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
  const ray = new THREE.Raycaster();
  const hits = (x: number, z: number) => {
    ray.set(new THREE.Vector3(x, -1, z), new THREE.Vector3(0, 1, 0));
    return ray.intersectObject(mesh).length;
  };
  expect(hits(2.07, 4.6)).toBe(0); // between the end post and first picket
  expect(hits(2.03, 4.6)).toBeGreaterThan(0);
  expect(hits(3, 5.08)).toBeGreaterThan(0); // handrail
  expect(hits(1, 4.6)).toBe(0); // opening removed by wallPieces
  geometry.dispose();
});
