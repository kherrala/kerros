import * as THREE from 'three';
import type { Point, Ring } from '../model/types';

// One non-indexed box template avoids allocating an extrusion for every picket.
const box = new THREE.BoxGeometry(1, 1, 1).toNonIndexed();

/** Open railing geometry for one wall piece; the piece interval already excludes gates. */
export function fenceGeometry(a: Point, b: Point, ring: Ring, base: number, height: number, thickness: number) {
  const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const ux = (b[0] - a[0]) / length,
    uy = (b[1] - a[1]) / length;
  const along = ring.map(p => (p[0] - a[0]) * ux + (p[1] - a[1]) * uy);
  const start = Math.max(0, Math.min(...along)),
    end = Math.min(length, Math.max(...along));
  const positions: number[] = [],
    normals: number[] = [],
    uvs: number[] = [];
  const source = box.getAttribute('position'),
    normal = box.getAttribute('normal'),
    uv = box.getAttribute('uv');
  const add = (x: number, z: number, w: number, d: number, h: number) => {
    for (let i = 0; i < source.count; i++) {
      const sx = source.getX(i) * w + x,
        sy = source.getY(i) * d;
      positions.push(a[0] + sx * ux - sy * uy, a[1] + sx * uy + sy * ux, base + z + source.getZ(i) * h);
      normals.push(
        normal.getX(i) * ux - normal.getY(i) * uy,
        normal.getX(i) * uy + normal.getY(i) * ux,
        normal.getZ(i),
      );
      uvs.push(uv.getX(i), uv.getY(i));
    }
  };
  const width = end - start,
    post = Math.min(thickness, 0.065, width / 2),
    rail = Math.min(0.05, height / 4);
  if (width > 0 && height > 0) {
    for (const z of [rail / 2 + Math.min(0.08, height / 4), height - rail / 2])
      add((start + end) / 2, z, width, thickness, rail);
    const bays = Math.max(1, Math.ceil(width / 1.2));
    for (let i = 0; i <= bays; i++) add(start + post / 2 + ((width - post) * i) / bays, height / 2, post, post, height);
    const pickets = Math.max(1, Math.ceil(width / 0.13));
    for (let i = 1; i < pickets; i++)
      add(start + (width * i) / pickets, height / 2, Math.min(0.018, post), Math.min(0.025, thickness), height - rail);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  return geometry;
}
