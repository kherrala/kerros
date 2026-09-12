import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/** The scene renders on two layers. Everything is on OUTSIDE-or-INSIDE: the sun and the sky light
 *  both, but the building's own ceiling lighting is on INSIDE alone, so turning the lamps up to read
 *  a shop floor does not also floodlight the pavement at midnight. */
export const INSIDE = 0,
  OUTSIDE = 1;

interface Span {
  id: string;
  start: number;
  count: number;
}
interface Entry {
  geometry: THREE.BufferGeometry;
  id: string;
}

/** Batch static surfaces by material, retaining triangle ownership for picking/highlights. */
export class SurfaceBatch {
  private pending = new Map<string, { material: THREE.Material; outdoor: boolean; entries: Entry[] }>();
  private meshes: THREE.Mesh[] = [];
  /** Side of the square cells the batch is cut into, in scene metres; 0 batches a whole material
   *  into one mesh. Looking down on a floor from above, every part of it is in the frame and one
   *  mesh per material is the cheapest way to draw it. Standing on it, most of it is behind you or
   *  round a corner, and a lamp's shadow reaches twelve metres — but a mesh is culled whole or not
   *  at all, and one floor-sized mesh is never culled. Cut into cells, the frustum and every
   *  shadow pass keep only the cells they can see. */
  chunk = 0;

  /** `outdoor` puts the surface on the OUTSIDE layer, out of reach of the interior lighting. It is
   *  part of the bucket key as well as a property of the mesh: two surfaces that share a material
   *  but not a side of the wall cannot be merged into one mesh, because a mesh sits on one layer. */
  add(geometry: THREE.BufferGeometry, material: THREE.Material, id: string, outdoor = false) {
    let cell = '';
    if (this.chunk > 0) {
      geometry.computeBoundingBox();
      const box = geometry.boundingBox!;
      cell = `|${Math.floor((box.min.x + box.max.x) / 2 / this.chunk)},${Math.floor((box.min.y + box.max.y) / 2 / this.chunk)}`;
    }
    const key = `${material.uuid}|${outdoor ? 'out' : 'in'}${cell}`;
    const bucket = this.pending.get(key) ?? { material, outdoor, entries: [] };
    bucket.entries.push({ geometry, id });
    this.pending.set(key, bucket);
  }

  /** Fold a built object tree (a furniture group, a roof) into the batch, baking each mesh's world
   *  transform into its geometry. makeFixture emits one mesh per box, so a demo with a few hundred
   *  cars and columns was contributing thousands of draw calls and as many buffer uploads; merged by
   *  material they cost a handful. Instanced children are left alone — they are already batched. */
  addObject(root: THREE.Object3D, id: string, outdoor = false) {
    root.updateMatrixWorld(true);
    const leftovers: THREE.Object3D[] = [];
    root.traverse(o => {
      if (o instanceof THREE.Light) {
        const light = o.clone();
        if (o.parent) light.applyMatrix4(o.parent.matrixWorld);
        leftovers.push(light);
        return;
      }
      if (!(o instanceof THREE.Mesh)) return;
      if ((o as THREE.InstancedMesh).isInstancedMesh) {
        leftovers.push(o);
        return;
      }
      const material = Array.isArray(o.material) ? o.material[0] : o.material;
      if (!material) return;
      const geometry = o.geometry.clone();
      geometry.applyMatrix4(o.matrixWorld);
      this.add(geometry, material, id, outdoor);
    });
    return leftovers;
  }

  finish(scene: THREE.Scene) {
    for (const { material, outdoor, entries } of this.pending.values()) {
      const geometries = entries.map(({ geometry }) => (geometry.index ? geometry.toNonIndexed() : geometry));
      const spans: Span[] = [];
      let start = 0;
      entries.forEach(({ id }, i) => {
        const count = geometries[i].getAttribute('position').count;
        spans.push({ id, start, count });
        start += count;
      });
      const geometry = mergeGeometries(geometries)!;
      const mesh = new THREE.Mesh(geometry, material);
      if (outdoor) mesh.layers.set(OUTSIDE);
      mesh.userData.spans = spans;
      mesh.castShadow = mesh.receiveShadow = !material.transparent;
      if (material.transparent && !material.depthWrite) mesh.raycast = () => {};
      scene.add(mesh);
      this.meshes.push(mesh);
      geometries.forEach(g => g.dispose());
      entries.forEach(({ geometry }) => {
        if (geometry.index) geometry.dispose();
      });
    }
    this.pending.clear();
  }

  outline(id: string, color: string): THREE.LineSegments | null {
    const points: number[] = [];
    for (const mesh of this.meshes) {
      const position = mesh.geometry.getAttribute('position');
      for (const span of mesh.userData.spans as Span[])
        if (span.id === id) {
          for (let i = span.start; i < span.start + span.count; i++)
            points.push(position.getX(i), position.getY(i), position.getZ(i));
        }
    }
    if (!points.length) return null;
    const geometry = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
    const outline = new THREE.LineSegments(
      new THREE.EdgesGeometry(geometry, 35),
      new THREE.LineBasicMaterial({ color, depthTest: true, transparent: true, opacity: 0.95 }),
    );
    geometry.dispose();
    return outline;
  }

  clear() {
    this.pending.clear();
    this.meshes = [];
  }
}

export function hitEntity(hit: THREE.Intersection): string | null {
  if (hit.instanceId !== undefined && hit.object.userData.entityIds)
    return hit.object.userData.entityIds[hit.instanceId] ?? null;
  if (hit.object.userData.entityId) return hit.object.userData.entityId;
  const vertex = (hit.faceIndex ?? -1) * 3;
  const spans = hit.object.userData.spans as Span[] | undefined;
  // Ranges are ordered; a binary search avoids scanning every wall on every mouse move.
  if (spans) {
    let lo = 0,
      hi = spans.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1,
        span = spans[mid];
      if (vertex < span.start) hi = mid - 1;
      else if (vertex >= span.start + span.count) lo = mid + 1;
      else return span.id;
    }
  }
  return null;
}

/** Use distances along each face, not a world-axis projection that squashes diagonal façades. */
export function metricUVs(geometry: THREE.BufferGeometry) {
  const p = geometry.getAttribute('position'),
    n = geometry.getAttribute('normal');
  const uv = new Float32Array(p.count * 2);
  for (let i = 0; i < p.count; i++) {
    if (Math.abs(n.getZ(i)) > 0.5) {
      uv[i * 2] = p.getX(i);
      uv[i * 2 + 1] = p.getY(i);
    } else {
      let tx = -n.getY(i),
        ty = n.getX(i);
      if (tx < -0.001 || (Math.abs(tx) < 0.001 && ty < 0)) {
        tx = -tx;
        ty = -ty;
      }
      uv[i * 2] = p.getX(i) * tx + p.getY(i) * ty;
      uv[i * 2 + 1] = p.getZ(i);
    }
  }
  geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
}
