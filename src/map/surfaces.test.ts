import { expect, it } from 'vitest';
import * as THREE from 'three';
import { splitWallFace, metricUVs } from './surfaces';

it.each([0, 37, 123])(
  'assigns an oblique wall interior a finish with no duplicate or missing triangles (%s°)',
  angle => {
    const spin = (angle * Math.PI) / 180;
    const turn = ([x, y]: [number, number]): [number, number] => [
      x * Math.cos(spin) - y * Math.sin(spin),
      x * Math.sin(spin) + y * Math.cos(spin),
    ];
    // Mitred ends and multiple height steps exercise both corner and window/header pieces.
    const points: [number, number][] = [
      [-10.3, -0.3],
      [10.3, -0.3],
      [9.7, 0.3],
      [-9.7, 0.3],
    ];
    const geometry = new THREE.ExtrudeGeometry(new THREE.Shape(points.map(p => new THREE.Vector2(...turn(p)))), {
      depth: 5.42,
      steps: 16,
      bevelEnabled: false,
    });
    metricUVs(geometry);
    const count = geometry.getAttribute('position').count;
    const face = splitWallFace(geometry, [turn(points[2]), turn(points[3])])!;
    expect(face).not.toBeNull();
    const inner = Array.from(face.index!.array),
      outer = Array.from(geometry.index!.array);
    expect(inner.length).toBe(16 * 6);
    expect(inner.length + outer.length).toBe(count);
    expect(new Set([...inner, ...outer]).size).toBe(count);
    expect(face.getAttribute('uv').array).toEqual(geometry.getAttribute('uv').array);
    face.dispose();
    geometry.dispose();
  },
);
