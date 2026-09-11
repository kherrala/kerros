import * as THREE from 'three';
import type { BuildingRoof, Point, RoofSection, SiteObject } from '../model/types';
import { distance, openRing, pointInRing, rotate, segmentProjection } from '../model/geometry';
import { MaterialLibrary } from './materials';
import { metricUVs } from './surfaces';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

type ProjectXY = (point: Point) => Point;
const standard = (color: string, roughness = 0.8) => new THREE.MeshStandardMaterial({ color, roughness });
const box = (
  group: THREE.Group,
  w: number,
  d: number,
  h: number,
  x: number,
  y: number,
  z: number,
  material: THREE.Material,
) => {
  const geometry =
    w > 0.35 && d > 0.25 && h > 0.1
      ? new RoundedBoxGeometry(w, d, h, 1, Math.min(0.035, h * 0.12))
      : new THREE.BoxGeometry(w, d, h);
  metricUVs(geometry);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(x, y, z + h / 2);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  group.add(mesh);
  return mesh;
};
function cylinder(group: THREE.Group, a: THREE.Vector3, b: THREE.Vector3, r: number, material: THREE.Material) {
  const delta = b.clone().sub(a);
  if (delta.length() < 0.001) return;
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(r, r, delta.length(), 10), material);
  mesh.position.copy(a).add(b).multiplyScalar(0.5);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), delta.normalize());
  mesh.castShadow = true;
  group.add(mesh);
}

function tileGeometry() {
  const points: number[] = [],
    indices: number[] = [];
  for (let y = 0; y < 2; y++)
    for (let i = 0; i <= 10; i++) {
      const x = i / 10;
      points.push((x - 0.5) * 0.305, (y - 0.5) * 0.36, 0.02 + 0.025 * Math.sin(x * Math.PI * 2) + y * 0.012);
    }
  for (let i = 0; i < 10; i++) {
    indices.push(i, i + 1, i + 12, i, i + 12, i + 11);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
  g.setIndex(indices);
  g.computeVertexNormals();
  return g;
}

/** Convex eaves fan into a ridge. Each plane receives actual interlocking tile geometry. */
export function makeRoof(
  roof: BuildingRoof,
  projectXY: ProjectXY,
  id: string,
  materials: MaterialLibrary,
): THREE.Group {
  const group = new THREE.Group();
  group.userData.entityId = id;
  group.userData.roof = true;
  const area = roof.sections.reduce((sum, section) => {
    const ring = openRing(section.footprint);
    return (
      sum +
      Math.abs(
        ring.reduce((a, p, i) => {
          const q = ring[(i + 1) % ring.length];
          return a + p[0] * q[1] - q[0] * p[1];
        }, 0),
      ) /
        2
    );
  }, 0);
  const sheetMetal = area > 180;
  const roofMaterial = sheetMetal
    ? materials.get('roof', roof.color)
    : new THREE.MeshStandardMaterial({
        color: roof.color,
        roughness: 0.74,
        metalness: 0.03,
        side: THREE.DoubleSide,
      });
  const trim = materials.solid('#b7b3a7'),
    gutter = materials.metal('#4c5555'),
    tiles = tileGeometry();
  function plane(section: RoofSection, a: Point, b: Point) {
    const pa = projectXY(a),
      pb = projectXY(b),
      ra = projectXY(segmentProjection(a, ...section.ridge).point),
      rb = projectXY(segmentProjection(b, ...section.ridge).point);
    let points = [
      new THREE.Vector3(...pa, section.eave),
      new THREE.Vector3(...pb, section.eave),
      new THREE.Vector3(...rb, section.peak),
      new THREE.Vector3(...ra, section.peak),
    ];
    points = points.filter((p, i) => i === 0 || p.distanceTo(points[i - 1]) > 0.001);
    if (points.length > 2 && points.at(-1)!.distanceTo(points[0]) < 0.001) points.pop();
    if (points.length < 3) return;
    let normal = points[1].clone().sub(points[0]).cross(points[2].clone().sub(points[0])).normalize();
    if (normal.z < 0) {
      points.reverse();
      normal.negate();
    }
    const u = points[1].clone().sub(points[0]).normalize(),
      v = normal.clone().cross(u).normalize(),
      base = points[0];
    const polygon = points.map(p => [p.clone().sub(base).dot(u), p.clone().sub(base).dot(v)] as Point);
    const positions = points.flatMap(p => p.toArray()),
      indices: number[] = [];
    for (let i = 1; i < points.length - 1; i++) indices.push(0, i, i + 1);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(polygon.flat(), 2));
    const face = new THREE.Mesh(geometry, roofMaterial);
    face.castShadow = face.receiveShadow = true;
    group.add(face);
    const minX = Math.min(...polygon.map(p => p[0])),
      maxX = Math.max(...polygon.map(p => p[0])),
      minY = Math.min(...polygon.map(p => p[1])),
      maxY = Math.max(...polygon.map(p => p[1]));
    const matrices: THREE.Matrix4[] = [];
    // Clay tiles, fascia boards, gutters and ridge poles are all house-scale flourishes. On a large
    // roof the tile scan alone runs to hundreds of thousands of iterations — each with a point-in-ring
    // test — and emits as many instances; the trims meanwhile draw as bright seams straight across
    // what should read as one sheet. Past a modest budget the plane is left plain, which is what the
    // roof of a department store or a warehouse actually is.
    const detailed = !sheetMetal && ((maxX - minX) / 0.3) * ((maxY - minY) / 0.33) <= 1200;
    if (sheetMetal) {
      // Raised standing seams remain legible when texture mipmaps fade at city scale.
      const spacing = Math.max(0.6, Math.ceil((maxX - minX) / 108) * 0.6);
      for (let x = Math.ceil(minX / spacing) * spacing; x < maxX; x += spacing) {
        const cuts: number[] = [];
        polygon.forEach((a, i) => {
          const b = polygon[(i + 1) % polygon.length];
          if ((a[0] <= x && b[0] > x) || (b[0] <= x && a[0] > x))
            cuts.push(a[1] + ((b[1] - a[1]) * (x - a[0])) / (b[0] - a[0]));
        });
        cuts.sort((a, b) => a - b);
        for (let i = 0; i + 1 < cuts.length; i += 2) {
          const at = (y: number) =>
            base.clone().addScaledVector(u, x).addScaledVector(v, y).addScaledVector(normal, 0.025);
          cylinder(group, at(cuts[i]), at(cuts[i + 1]), 0.018, gutter);
        }
      }
    }
    if (detailed)
      for (let y = minY + 0.19; y < maxY; y += 0.33)
        for (let x = minX + 0.16; x < maxX; x += 0.3) {
          if (
            !(
              [
                [-0.153, -0.18],
                [0.153, -0.18],
                [0.153, 0.18],
                [-0.153, 0.18],
              ] as Point[]
            ).every(([dx, dy]) => pointInRing([x + dx, y + dy], polygon))
          )
            continue;
          matrices.push(
            new THREE.Matrix4()
              .makeBasis(u, v, normal)
              .setPosition(base.clone().addScaledVector(u, x).addScaledVector(v, y).addScaledVector(normal, 0.018)),
          );
        }
    if (matrices.length) {
      const batch = new THREE.InstancedMesh(tiles, roofMaterial, matrices.length);
      matrices.forEach((matrix, i) => {
        batch.setMatrixAt(i, matrix);
        const tone = new THREE.Color().setScalar(0.92 + (i % 11) * 0.015);
        batch.setColorAt(i, tone);
      });
      batch.instanceMatrix.needsUpdate = true;
      batch.castShadow = batch.receiveShadow = true;
      group.add(batch);
    }
    if (!detailed && !sheetMetal) return;
    // White fascia and rain gutter along the eave.
    const edgeA = new THREE.Vector3(...pa, section.eave - 0.08),
      edgeB = new THREE.Vector3(...pb, section.eave - 0.08);
    cylinder(group, edgeA, edgeB, 0.07, trim);
    cylinder(
      group,
      edgeA.clone().add(new THREE.Vector3(0, 0, -0.12)),
      edgeB.clone().add(new THREE.Vector3(0, 0, -0.12)),
      0.045,
      gutter,
    );
    if (detailed && ra[0] === rb[0] && ra[1] === rb[1])
      cylinder(
        group,
        new THREE.Vector3(...ra, section.peak + 0.05),
        new THREE.Vector3(...pa, section.eave + 0.05),
        0.09,
        roofMaterial,
      );
  }
  roof.sections.forEach(section => {
    const outline = openRing(section.footprint);
    // A section with no fall is a deck, not a pitch. Fanning it from the ridge the way a sloped plane
    // is fanned lays overlapping coplanar quads over each other, whose per-quad normals disagree just
    // enough to show as creases across what should be one flat surface. Triangulate it once instead.
    if (Math.abs(section.peak - section.eave) < 0.001) {
      const shape = new THREE.Shape(outline.map(pt => new THREE.Vector2(...projectXY(pt))));
      const geometry = new THREE.ExtrudeGeometry(shape, { depth: 0.14, bevelEnabled: false });
      geometry.translate(0, 0, -0.14);
      metricUVs(geometry);
      const deck = new THREE.Mesh(geometry, roofMaterial);
      deck.position.z = section.peak;
      deck.castShadow = deck.receiveShadow = true;
      group.add(deck);
      return;
    }
    outline.forEach((a, i) => plane(section, a, outline[(i + 1) % outline.length]));
    const ridgeLength = distance(section.ridge[0], section.ridge[1]);
    if (ridgeLength <= 26)
      cylinder(
        group,
        new THREE.Vector3(...projectXY(section.ridge[0]), section.peak + 0.08),
        new THREE.Vector3(...projectXY(section.ridge[1]), section.peak + 0.08),
        0.13,
        roofMaterial,
      );
  });
  group.traverse(o => {
    if (o instanceof THREE.Mesh) o.userData.entityId = id;
  });
  return group;
}

export function makeFixture(
  o: SiteObject,
  projectXY: ProjectXY,
  z: number,
  materials: MaterialLibrary,
  evening: boolean,
): THREE.Group {
  const group = new THREE.Group(),
    [x, y] = projectXY(o.position),
    direction = rotate([1, 0], o.rotation),
    along = projectXY([o.position[0] + direction[0], o.position[1] + direction[1]]);
  group.position.set(x, y, z);
  group.rotation.z = Math.atan2(along[1] - y, along[0] - x);
  const w = o.width,
    d = o.depth,
    h = o.height,
    paint = materials.solid(o.color ?? '#ddd7c8', o.model === 'car' ? 0.3 : 0.72),
    wood = materials.get('oak', '#bca27e'),
    white = materials.solid('#f1eee6'),
    dark = materials.solid('#3b4240'),
    metal = materials.metal('#858e8c');
  if (o.model === 'bed') {
    box(group, w, d, 0.25, 0, 0, 0.12, wood);
    box(group, w - 0.05, d - 0.05, 0.22, 0, 0, 0.37, white);
    box(group, w - 0.1, d * 0.67, 0.06, 0, -d * 0.12, 0.59, paint);
    box(group, w, 0.09, 0.85, 0, d / 2, 0.06, wood);
    for (const px of w > 1.3 ? [-w * 0.24, w * 0.24] : [0]) {
      const pillow = box(group, w > 1.3 ? w * 0.4 : w * 0.8, 0.43, 0.12, px, d * 0.32, 0.59, white);
      pillow.rotation.z = 0.02;
    }
  } else if (o.model === 'sofa') {
    box(group, w, d, 0.4, 0, 0, 0.1, paint);
    box(group, w, 0.19, 0.72, 0, d * 0.4, 0.1, paint);
    for (const x of [-w * 0.45, w * 0.45]) box(group, 0.15, d, 0.65, x, 0, 0.1, paint);
    for (let i = 0; i < 3; i++)
      box(group, (w - 0.38) / 3 - 0.025, d * 0.7, 0.15, -(w - 0.38) / 3 + (i * (w - 0.38)) / 3, -0.03, 0.5, paint);
  } else if (o.model === 'dining') {
    box(group, w, d, 0.065, 0, 0, h, wood);
    for (const x of [-w * 0.4, w * 0.4])
      for (const y of [-d * 0.35, d * 0.35]) box(group, 0.065, 0.065, h, x, y, 0, dark);
    if (h > 0.6)
      for (const x of [-w * 0.3, w * 0.3])
        for (const y of [-1, 1]) {
          box(group, 0.43, 0.43, 0.07, x, y * (d / 2 + 0.38), 0.44, wood);
          box(group, 0.43, 0.055, 0.43, x, y * (d / 2 + 0.59), 0.44, wood);
          for (const dx of [-0.15, 0.15]) box(group, 0.045, 0.3, 0.44, x + dx, y * (d / 2 + 0.38), 0, dark);
        }
  } else if (o.model === 'cabinet' || o.model === 'counter') {
    box(group, w, d, h, 0, 0, 0, paint);
    const panels = Math.max(1, Math.round(w / 0.55));
    for (let i = 0; i < panels; i++) {
      const x = -w / 2 + ((i + 0.5) * w) / panels;
      box(group, w / panels - 0.015, 0.025, h - 0.06, x, -d / 2 - 0.015, 0.03, paint);
      box(group, 0.018, 0.035, 0.18, x + (w / panels) * 0.32, -d / 2 - 0.045, h * 0.55, metal);
    }
    if (o.model === 'counter') box(group, w + 0.04, d + 0.035, 0.045, 0, 0, h, materials.get('tile', '#777b73'));
  } else if (o.model === 'toilet') {
    const bowl = new THREE.Mesh(new THREE.SphereGeometry(0.5, 16, 12), white);
    bowl.scale.set(w, d * 0.8, 0.3);
    bowl.position.z = 0.35;
    group.add(bowl);
    box(group, w * 0.75, 0.15, 0.63, 0, d * 0.35, 0, white);
    box(group, w * 0.55, d * 0.5, 0.3, 0, 0, 0, white);
  } else if (o.model === 'basin') {
    box(group, w, d, h - 0.12, 0, 0, 0, wood);
    box(group, w + 0.04, d + 0.04, 0.1, 0, 0, h - 0.1, white);
    const bowl = new THREE.Mesh(new THREE.SphereGeometry(0.2, 16, 8), standard('#b6c3c2'));
    bowl.scale.set(1, 0.8, 0.15);
    bowl.position.z = h + 0.005;
    group.add(bowl);
    cylinder(group, new THREE.Vector3(0, d * 0.3, h), new THREE.Vector3(0, d * 0.3, h + 0.2), 0.022, metal);
  } else if (o.model === 'sauna') {
    for (let i = 0; i < 8; i++) box(group, w, 0.09, 0.06, 0, -d / 2 + (i * d) / 8, 0.48, wood);
    for (let i = 0; i < 5; i++) box(group, w, 0.095, 0.06, 0, d / 2 - 0.5 + i * 0.1, 0.98, wood);
    box(group, 0.3, 0.3, 0.6, w / 2 - 0.25, -d / 2 + 0.2, 0, dark);
  } else if (o.model === 'shower') {
    const glass = new THREE.MeshStandardMaterial({
      color: '#bbdbde',
      transparent: true,
      opacity: 0.22,
      roughness: 0.15,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    box(group, w, 0.025, h, 0, d / 2, 0, glass);
    box(group, 0.025, d, h, w / 2, 0, 0, glass);
    cylinder(
      group,
      new THREE.Vector3(-w * 0.35, d * 0.4, 0.4),
      new THREE.Vector3(-w * 0.35, d * 0.4, h - 0.1),
      0.015,
      metal,
    );
    box(group, 0.22, 0.18, 0.025, -w * 0.35, d * 0.25, h - 0.1, metal);
  } else if (o.model === 'tree' || o.model === 'shrub') {
    if (o.model === 'tree')
      cylinder(
        group,
        new THREE.Vector3(0, 0, 0),
        new THREE.Vector3(0.12, 0, h * 0.73),
        0.085,
        materials.get('plaster', '#dedbd0'),
      );
    for (let i = 0; i < 9; i++) {
      const leaf = materials.shaded(
        materials.solid(i % 3 === 0 ? '#58764a' : i % 3 === 1 ? '#425f3b' : '#78945a', 0.95),
      );
      const geometry = new THREE.IcosahedronGeometry(1, 2);
      const vertices = geometry.getAttribute('position');
      const shades: number[] = [];
      for (let j = 0; j < vertices.count; j++) {
        const x = vertices.getX(j),
          y = vertices.getY(j),
          z = vertices.getZ(j);
        const r = 1 + Math.sin(x * 12 + i) * Math.sin(y * 9 - i) * Math.sin(z * 11) * 0.14;
        vertices.setXYZ(j, x * r, y * r, z * r);
        const shade = 0.66 + (z + 1) * 0.17;
        shades.push(shade, shade, shade);
      }
      geometry.setAttribute('color', new THREE.Float32BufferAttribute(shades, 3));
      geometry.computeVertexNormals();
      const mesh = new THREE.Mesh(geometry, leaf);
      const t = i * 2.399;
      mesh.position.set(
        Math.cos(t) * w * 0.24,
        Math.sin(t) * d * 0.24,
        o.model === 'tree' ? h * 0.64 + (i % 3) * 0.35 : h * 0.45,
      );
      mesh.scale.set(w * 0.35, d * 0.35, o.model === 'tree' ? h * 0.28 : h * 0.55);
      mesh.castShadow = mesh.receiveShadow = true;
      group.add(mesh);
    }
  } else if (o.model === 'lamp') {
    cylinder(group, new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, h), 0.035, dark);
    box(
      group,
      0.18,
      0.18,
      0.12,
      0,
      0,
      h - 0.15,
      new THREE.MeshStandardMaterial({ color: '#f4dfae', emissive: '#ffcf79', emissiveIntensity: evening ? 2 : 0.2 }),
    );
    if (evening) {
      const light = new THREE.PointLight('#ffd197', 9, 5, 2);
      light.position.z = h;
      group.add(light);
    }
  } else if (o.model === 'car') {
    box(group, w, d, 0.48, 0, 0, 0.35, paint);
    box(group, w * 0.82, d * 0.48, 0.5, 0, -0.1, 0.83, paint);
    const glass = materials.glass(evening);
    box(group, w * 0.83, 0.025, 0.4, 0, -d * 0.26, 0.88, glass);
    box(group, w * 0.83, 0.025, 0.4, 0, d * 0.22, 0.88, glass);
    for (const x of [-w * 0.48, w * 0.48])
      for (const y of [-d * 0.32, d * 0.32]) {
        const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.31, 0.31, 0.17, 16), dark);
        wheel.rotation.z = Math.PI / 2;
        wheel.position.set(x, y, 0.33);
        group.add(wheel);
      }
    for (const x of [-w * 0.31, w * 0.31]) box(group, 0.32, 0.04, 0.14, x, d / 2, 0.58, white);
  } else if (o.model === 'chimney') {
    box(group, w, d, h, 0, 0, 0, materials.get('brick', o.color ?? '#c0b8a7'));
    box(group, w + 0.16, d + 0.16, 0.12, 0, 0, h, metal);
  } else box(group, w, d, h, 0, 0, 0, paint);
  group.traverse(child => {
    if (child instanceof THREE.Mesh) {
      child.userData.entityId = o.id;
      child.castShadow = true;
      child.receiveShadow = true;
    }
  });
  return group;
}
