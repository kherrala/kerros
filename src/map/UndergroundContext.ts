import * as THREE from 'three';
import type { Point } from '../model/types';

/** A camera-facing cutaway cage. Rotating updates two existing buffers, never GPU resources. */
export class UndergroundCage extends THREE.Group {
  private rings: THREE.Vector3[][] = [];
  private columns: Point[] = [];
  private center: Point = [0, 0];
  private bottom = 0;
  private top = 0;
  private bearing = Number.NaN;
  private ringLines?: THREE.LineSegments;
  private columnLines?: THREE.LineSegments;

  configure(rings: THREE.Vector3[][], columns: Point[], bottom: number, top: number, evening: boolean) {
    this.dispose();
    this.rings = rings;
    this.columns = columns;
    this.bottom = bottom;
    this.top = top;
    let count = 0,
      x = 0,
      y = 0;
    const bounds = new THREE.Box3();
    for (const ring of rings)
      for (const p of ring) {
        count++;
        x += p.x;
        y += p.y;
        bounds.expandByPoint(p);
      }
    if (!count) return;
    for (const [cx, cy] of columns) {
      bounds.expandByPoint(new THREE.Vector3(cx, cy, bottom));
      bounds.expandByPoint(new THREE.Vector3(cx, cy, top));
    }
    this.center = [x / count, y / count];
    this.bearing = Number.NaN;
    const lines = (capacity: number, color: string, opacity: number) => {
      const geometry = new THREE.BufferGeometry();
      // The vertex buffers contain only the current half-cage. Stable full-cage bounds let
      // the scene fit its clipping range once, without rescanning buffers on every rotation.
      geometry.boundingBox = bounds.clone();
      geometry.setAttribute(
        'position',
        new THREE.BufferAttribute(new Float32Array(capacity * 6), 3).setUsage(THREE.DynamicDrawUsage),
      );
      geometry.setDrawRange(0, 0);
      const mesh = new THREE.LineSegments(
        geometry,
        new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false }),
      );
      mesh.frustumCulled = false;
      mesh.raycast = () => {};
      this.add(mesh);
      return mesh;
    };
    this.ringLines = lines(count, evening ? '#99a0b4' : '#aeb4c0', 0.5);
    this.columnLines = lines(columns.length, evening ? '#8b92a8' : '#a9afbd', 0.32);
  }

  setBearing(bearing: number) {
    if (!this.ringLines || !this.columnLines) return;
    const delta = ((bearing - this.bearing + 540) % 360) - 180;
    if (Number.isFinite(delta) && Math.abs(delta) < 1) return;
    this.bearing = bearing;
    const fx = Math.sin((bearing * Math.PI) / 180),
      fy = Math.cos((bearing * Math.PI) / 180);
    const far = (x: number, y: number) => (x - this.center[0]) * fx + (y - this.center[1]) * fy > 0;
    const rings = this.ringLines.geometry.getAttribute('position') as THREE.BufferAttribute;
    let n = 0;
    for (const ring of this.rings)
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i],
          b = ring[(i + 1) % ring.length];
        if (!far((a.x + b.x) / 2, (a.y + b.y) / 2)) continue;
        rings.setXYZ(n++, a.x, a.y, a.z);
        rings.setXYZ(n++, b.x, b.y, b.z);
      }
    rings.needsUpdate = true;
    this.ringLines.geometry.setDrawRange(0, n);
    const columns = this.columnLines.geometry.getAttribute('position') as THREE.BufferAttribute;
    n = 0;
    for (const [x, y] of this.columns)
      if (far(x, y)) {
        columns.setXYZ(n++, x, y, this.bottom);
        columns.setXYZ(n++, x, y, this.top);
      }
    columns.needsUpdate = true;
    this.columnLines.geometry.setDrawRange(0, n);
  }

  dispose() {
    for (const child of this.children as THREE.LineSegments[]) {
      child.geometry.dispose();
      (child.material as THREE.Material).dispose();
    }
    this.clear();
    this.ringLines = this.columnLines = undefined;
    this.rings = [];
    this.columns = [];
  }
}

// Excavated ground reads as depth only if the cut face is not one flat band. Dig anywhere in central
// Helsinki and you pass through the same sequence: made ground over post-glacial sand, the blue-grey
// Litorina clay the whole city is founded on, stony glacial till, then granite bedrock. Each layer
// gets its own colour, blended over a short transition so the face reads geological rather than CAD.
// Depths are metres below grade; the last entry runs to the bottom of the shaft.
const PROFILE: { until: number; color: THREE.Color }[] = [
  // Muted on purpose. These were the real colours of a Helsinki bore log — amber sand over Litorina
  // clay over till — and side by side at full chroma they read as a geology poster rather than as
  // ground: a band of teal and a band of yellow, competing with the building standing in them. Same
  // sequence, same order, a fraction of the saturation, so depth still reads as layers and the eye
  // stays on the plan.
  { until: -1.4, color: new THREE.Color('#6d6863') }, // made ground / pavement sub-base
  { until: -4.5, color: new THREE.Color('#968c7d') }, // sand & gravel
  { until: -11, color: new THREE.Color('#7d8891') }, // Litorina clay, the blue-grey one
  { until: -18, color: new THREE.Color('#877f75') }, // glacial till / moraine
  { until: Number.NEGATIVE_INFINITY, color: new THREE.Color('#79767b') }, // granite bedrock
];
const BLEND = 1.1; // metres of gradation between layers
const SLAB_LINE = new THREE.Color('#b7b2a9');
// Deterministic value noise — soil is mottled, and strata are horizontal, so it varies faster with
// depth than across the face. No assets and no dependency; the same point always shades the same.
const hash = (x: number, y: number, z: number) => {
  const s = Math.sin(x * 12.9898 + y * 78.233 + z * 37.719) * 43758.5453;
  return s - Math.floor(s);
};
const grain = (x: number, y: number, z: number) => {
  const fine = hash(Math.round(x * 0.9), Math.round(y * 0.9), Math.round(z * 2.4)) - 0.5;
  const broad = hash(Math.round(x * 0.16), Math.round(y * 0.16), Math.round(z * 0.5)) - 0.5;
  // Occasional darker stones sitting in the till.
  const stone = hash(Math.round(x * 1.7), Math.round(y * 1.7), Math.round(z * 1.7)) > 0.965 ? -0.13 : 0;
  return fine * 0.13 + broad * 0.16 + stone;
};
/** Only the shaft boundary needs vertical faces; no 1.8 km cap to triangulate or raycast. */
export function undergroundPit(ring: Point[], floor: number, bottom: number, strata: number[] = []): THREE.Group {
  const group = new THREE.Group();
  const layerAt = (z: number, target: THREE.Color) => {
    let index = PROFILE.findIndex(l => z >= l.until);
    if (index < 0) index = PROFILE.length - 1;
    target.copy(PROFILE[index].color);
    // Gradate into the layer below rather than cutting a hard line.
    const edge = PROFILE[index].until;
    if (index + 1 < PROFILE.length && Number.isFinite(edge) && z - edge < BLEND)
      target.lerp(PROFILE[index + 1].color, (1 - (z - edge) / BLEND) * 0.5);
    return target;
  };
  const shade = (x: number, y: number, z: number, target: THREE.Color) => {
    layerAt(z, target);
    // The exposed face is darker the deeper it sits — less bounced light reaches the bottom.
    const depth = bottom < 0 ? Math.min(1, Math.max(0, z / bottom)) : 0;
    target.multiplyScalar(1 + grain(x, y, z) - depth * 0.15);
    // A pale line of cut concrete where each deck slab meets the soil.
    for (const s of strata) if (Math.abs(z - s) < 0.35) target.lerp(SLAB_LINE, 0.5);
    return target;
  };
  // `fade` makes the face solid at `hi` and transparent at `lo`. The veil above the inspected level
  // uses it so the ground you are looking through thins out to nothing exactly where your floor is —
  // the geology stays readable near grade without anything standing over the floor being inspected.
  // It used to be the other way round, which put the densest band of soil across the near edge of
  // the plate you had come down to look at and left grade itself invisible.
  const sides = (lo: number, hi: number, opacity: number, detail: boolean, fade = false) => {
    if (hi <= lo) return;
    const positions: number[] = [];
    const colors: number[] = [];
    const c = new THREE.Color();
    const push = (x: number, y: number, z: number) => {
      positions.push(x, y, z);
      shade(x, y, z, c);
      colors.push(c.r, c.g, c.b);
      // Squared falloff keeps the soil near grade legible while clearing quickly toward the floor.
      if (fade) colors.push(((z - lo) / (hi - lo)) ** 2);
    };
    // Subdivide the face: vertex colours can only express strata and mottling if there are vertices
    // between the top and the bottom.
    const rows = detail ? Math.min(110, Math.max(2, Math.ceil((hi - lo) / 0.55))) : 2;
    const dz = (hi - lo) / rows;
    ring.forEach(([ax, ay], i) => {
      const [bx, by] = ring[(i + 1) % ring.length];
      const span = Math.hypot(bx - ax, by - ay);
      const cols = detail ? Math.min(64, Math.max(1, Math.round(span / 3.5))) : 1;
      for (let col = 0; col < cols; col++) {
        const t0 = col / cols,
          t1 = (col + 1) / cols;
        const x0 = ax + (bx - ax) * t0,
          y0 = ay + (by - ay) * t0;
        const x1 = ax + (bx - ax) * t1,
          y1 = ay + (by - ay) * t1;
        for (let r = 0; r < rows; r++) {
          const z0 = lo + dz * r,
            z1 = lo + dz * (r + 1);
          push(x0, y0, z0);
          push(x1, y1, z0);
          push(x1, y1, z1);
          push(x0, y0, z0);
          push(x1, y1, z1);
          push(x0, y0, z1);
        }
      }
    });
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, fade ? 4 : 3));
    geometry.computeVertexNormals();
    const mesh = new THREE.Mesh(
      geometry,
      new THREE.MeshStandardMaterial({
        vertexColors: true,
        roughness: 1,
        side: THREE.DoubleSide,
        transparent: opacity < 1,
        opacity,
        depthWrite: opacity === 1,
      }),
    );
    mesh.raycast = () => {};
    group.add(mesh);
  };
  sides(bottom, floor, 1, true);
  sides(floor, 0, 0.38, true, true);
  const shape = new THREE.Shape(ring.map(p => new THREE.Vector2(...p)));
  const base = new THREE.Mesh(
    new THREE.ShapeGeometry(shape),
    // The floor of the excavation is whatever the last layer is — bedrock, in a deep shaft.
    new THREE.MeshStandardMaterial({
      color: layerAt(bottom, new THREE.Color()).multiplyScalar(0.62),
      roughness: 1,
      side: THREE.DoubleSide,
    }),
  );
  base.position.z = bottom;
  base.raycast = () => {};
  group.add(base);
  return group;
}
