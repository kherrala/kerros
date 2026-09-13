import * as THREE from 'three';
import type { Point, SiteObject } from '../model/types';
import { rotate } from '../model/geometry';
import type { MaterialLibrary } from './materials';
import { metricUVs } from './surfaces';

/** Original small-wave implementation informed by https://reakt.io/ocean.html:
 * sum directional Gerstner terms and differentiate them for normals. Pool wavelengths and
 * amplitudes are metres and centimetres; physical transmission supplies clear water and Fresnel. */
const waves = `
uniform float poolTime;
uniform float poolRipple;
varying vec2 poolXY;
vec3 poolWave(vec2 p) {
  vec3 wave = vec3(0.0);
  for (int i = 0; i < 4; i++) {
    float n = float(i);
    float angle = n * 2.399 + 0.35;
    vec2 direction = vec2(cos(angle), sin(angle));
    float k = 2.6 + n * 2.3;
    float amplitude = poolRipple / (1.0 + n * 1.6);
    float phase = k * dot(direction, p) - sqrt(9.81 * k) * poolTime * 0.45;
    wave.x += amplitude * sin(phase);
    wave.yz += amplitude * k * cos(phase) * direction;
  }
  return wave;
}
`;

/** Tessellate the authored shape without moving its boundary or closing its holes. */
function waveGeometry(shape: THREE.Shape, base: number): THREE.BufferGeometry {
  const flat = new THREE.ShapeGeometry(shape).toNonIndexed();
  const source = flat.getAttribute('position');
  const vertices: number[] = [];
  const split = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, depth: number) => {
    if (depth < 6 && Math.max(a.distanceToSquared(b), b.distanceToSquared(c), c.distanceToSquared(a)) > 2.25) {
      const ab = a.clone().add(b).multiplyScalar(0.5),
        bc = b.clone().add(c).multiplyScalar(0.5),
        ca = c.clone().add(a).multiplyScalar(0.5);
      split(a, ab, ca, depth + 1);
      split(ab, b, bc, depth + 1);
      split(ca, bc, c, depth + 1);
      split(ab, bc, ca, depth + 1);
    } else for (const p of [a, b, c]) vertices.push(p.x, p.y, base);
  };
  for (let i = 0; i < source.count; i += 3)
    split(
      new THREE.Vector3().fromBufferAttribute(source, i),
      new THREE.Vector3().fromBufferAttribute(source, i + 1),
      new THREE.Vector3().fromBufferAttribute(source, i + 2),
      0,
    );
  flat.dispose();
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  geometry.computeVertexNormals();
  metricUVs(geometry);
  return geometry;
}

export function makePool(
  o: SiteObject,
  xy: (p: Point) => Point,
  base: number,
  materials: MaterialLibrary,
  time: { value: number },
): THREE.Group {
  const group = new THREE.Group();
  const rings = o.rings!;
  const shape = new THREE.Shape(rings[0].map(p => new THREE.Vector2(...xy(p))));
  shape.holes = rings.slice(1).map(r => new THREE.Path(r.map(p => new THREE.Vector2(...xy(p)))));
  const depth = o.water!.depth;
  const add = (geometry: THREE.BufferGeometry, material: THREE.Material) => {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.userData.entityId = o.id;
    mesh.receiveShadow = !material.transparent;
    group.add(mesh);
    return mesh;
  };
  const tile = materials.get('tile', '#f2f3ef');
  const bottom = new THREE.ShapeGeometry(shape);
  bottom.translate(0, 0, base - depth);
  metricUVs(bottom);
  add(bottom, tile);
  // Four or more tiled retaining faces follow the same outline as the water, including islands.
  for (const ring of rings)
    for (let i = 1; i < ring.length; i++) {
      const a = xy(ring[i - 1]),
        b = xy(ring[i]);
      const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const wall = new THREE.BoxGeometry(length, 0.15, depth + 0.08);
      wall.rotateZ(Math.atan2(b[1] - a[1], b[0] - a[0]));
      wall.translate((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, base - depth / 2 + 0.04);
      metricUVs(wall);
      add(wall, tile);
    }
  const water = new THREE.MeshPhysicalMaterial({
    color: '#d4f3ef',
    roughness: 0.12,
    metalness: 0,
    transmission: 0.94,
    thickness: depth,
    ior: 1.333,
    attenuationColor: '#63bec5',
    attenuationDistance: 12,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    envMapIntensity: 0.8,
  });
  water.onBeforeCompile = shader => {
    shader.uniforms.poolTime = time;
    shader.uniforms.poolRipple = { value: o.water!.ripple ?? 0.015 };
    shader.vertexShader =
      waves +
      shader.vertexShader.replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\npoolXY = position.xy; transformed.z += poolWave(position.xy).x;',
      );
    shader.fragmentShader =
      waves +
      shader.fragmentShader.replace(
        '#include <normal_fragment_begin>',
        `#include <normal_fragment_begin>
      vec3 wave = poolWave(poolXY);
      normal = normalize(mat3(viewMatrix) * vec3(-wave.y, -wave.z, 1.0)) * faceDirection;`,
      );
  };
  water.customProgramCacheKey = () => 'pool-water-v1';
  const surface = add(waveGeometry(shape, base - 0.08), water);
  surface.userData.water = true;
  surface.renderOrder = 2;
  // Stainless rails curl over the edge; the rungs remain visible through the clear water.
  const a = xy(rings[0][0]),
    b = xy(rings[0][1]);
  const edge = new THREE.Vector2(b[0] - a[0], b[1] - a[1]).normalize();
  const inward = new THREE.Vector2(-edge.y, edge.x);
  const center = new THREE.Vector2(a[0], a[1]).lerp(new THREE.Vector2(b[0], b[1]), 0.22);
  const point = (side: number, inset: number, z: number) =>
    new THREE.Vector3(
      center.x + edge.x * side + inward.x * inset,
      center.y + edge.y * side + inward.y * inset,
      base + z,
    );
  const steel = materials.metal('#bfcfce');
  for (const side of [-0.3, 0.3]) {
    const curve = new THREE.CatmullRomCurve3([
      point(side, -0.5, 0.02),
      point(side, -0.5, 0.7),
      point(side, 0, 0.88),
      point(side, 0.4, 0.6),
      point(side, 0.4, -depth + 0.18),
    ]);
    add(new THREE.TubeGeometry(curve, 32, 0.035, 8, false), steel);
  }
  for (let z = -0.15; z > -depth + 0.2; z -= 0.28) {
    const left = point(-0.3, 0.4, z),
      right = point(0.3, 0.4, z);
    const rung = new THREE.CylinderGeometry(0.027, 0.027, left.distanceTo(right), 8);
    rung.applyQuaternion(
      new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), right.clone().sub(left).normalize()),
    );
    rung.translate((left.x + right.x) / 2, (left.y + right.y) / 2, left.z);
    add(rung, steel);
  }
  return group;
}

export function makeWaterSlide(o: SiteObject, xy: (p: Point) => Point, base: number, materials: MaterialLibrary) {
  const slide = o.slide!;
  const points = slide.path.map(([x, y, z]) => {
    const p = rotate([x, y], o.rotation),
      at = xy([o.position[0] + p[0], o.position[1] + p[1]]);
    return new THREE.Vector3(at[0], at[1], base + z + slide.radius);
  });
  const curve = new THREE.CatmullRomCurve3(points, false, 'centripetal');
  const vertices: number[] = [],
    indices: number[] = [];
  const steps = 96,
    sides = 16;
  for (let i = 0; i <= steps; i++) {
    const p = curve.getPointAt(i / steps),
      tangent = curve.getTangentAt(i / steps);
    const side = new THREE.Vector3(-tangent.y, tangent.x, 0).normalize();
    for (let j = 0; j <= sides; j++) {
      const angle = Math.PI + (Math.PI * j) / sides;
      vertices.push(
        p.x + side.x * slide.radius * Math.cos(angle),
        p.y + side.y * slide.radius * Math.cos(angle),
        p.z + slide.radius * Math.sin(angle),
      );
      if (i < steps && j < sides) {
        const a = i * (sides + 1) + j,
          b = a + sides + 1;
        indices.push(a, b, a + 1, b, b + 1, a + 1);
      }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  metricUVs(geometry);
  const group = new THREE.Group();
  const mesh = new THREE.Mesh(geometry, materials.polished(materials.get('tile', o.color ?? '#f2f3ef'), 0.22));
  mesh.userData.entityId = o.id;
  mesh.castShadow = mesh.receiveShadow = true;
  group.add(mesh);
  const support = materials.metal('#c6d5d6');
  for (const t of [0, 0.25, 0.5, 0.75]) {
    const p = curve.getPointAt(t),
      height = p.z - base - slide.radius;
    if (height < 0.2) continue;
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, height, 8).rotateX(Math.PI / 2), support);
    post.position.set(p.x, p.y, base + height / 2);
    group.add(post);
  }
  // A compact access stair alongside the launch platform.
  const start = points[0],
    rise = start.z - base - slide.radius,
    count = Math.ceil(rise / 0.2);
  for (let i = 1; i <= count; i++) {
    const step = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.27, 0.12), materials.get('tile', '#f2f3ef'));
    step.position.set(start.x - slide.radius - 0.7, start.y - (count - i) * 0.25, base + (rise * i) / count);
    group.add(step);
  }
  return group;
}

/** Moving blue caustics from lit pools, restricted to their containing tiled chambers. This
 * inexpensive projection approximates the focused light from small ripples; it is not ray tracing. */
export function applyPoolCaustics(
  scene: THREE.Scene,
  project: import('../model/types').ProjectDocument,
  floorId: string,
  xy: (point: Point) => Point,
  base: number,
  time: { value: number },
) {
  const pools = project.objects.filter(o => o.floorId === floorId && o.water && o.rings);
  const sources = pools.flatMap(pool => {
    const room = project.objects.find(o => o.id === pool.parentId);
    if (!room) return [];
    const lamps = project.objects.filter(
      o =>
        o.floorId === floorId &&
        o.kind === 'light' &&
        (o.light?.mountHeight ?? 0) < 0 &&
        Math.abs(o.position[0] - pool.position[0]) <= pool.width / 2 &&
        Math.abs(o.position[1] - pool.position[1]) <= pool.depth / 2,
    );
    const intensity = lamps.reduce((sum, lamp) => sum + lamp.light!.intensity, 0);
    if (!intensity) return [];
    const center = xy(pool.position),
      end = xy([pool.position[0] + 1, pool.position[1]]);
    const length = Math.hypot(end[0] - center[0], end[1] - center[1]);
    const height = lamps.reduce((sum, lamp) => sum + lamp.light!.mountHeight!, 0) / lamps.length;
    return [
      {
        frame: new THREE.Vector4(center[0], center[1], (end[0] - center[0]) / length, (end[1] - center[1]) / length),
        room: new THREE.Vector4(
          room.width / 2 + 0.25,
          room.depth / 2 + 0.25,
          base + height,
          Math.min(1.6, intensity / 650),
        ),
        pool: new THREE.Vector2(pool.width / 2, pool.depth / 2),
      },
    ];
  });
  if (!sources.length) return;
  const replacements = new Map<THREE.Material, THREE.MeshStandardMaterial>();
  scene.traverse(object => {
    if (!(object instanceof THREE.Mesh)) return;
    const replace = (source: THREE.Material) => {
      if (!(source instanceof THREE.MeshStandardMaterial) || source.userData.finish !== 'tile') return source;
      if (replacements.has(source)) return replacements.get(source)!;
      const material = source.clone();
      material.userData = { ...source.userData, shared: false, poolCaustics: true };
      material.onBeforeCompile = (shader, renderer) => {
        source.onBeforeCompile(shader, renderer);
        shader.uniforms.bathTime = time;
        shader.uniforms.bathFrames = { value: sources.map(s => s.frame) };
        shader.uniforms.bathRooms = { value: sources.map(s => s.room) };
        shader.uniforms.bathPools = { value: sources.map(s => s.pool) };
        shader.vertexShader =
          'varying vec3 bathWorld;\n' +
          shader.vertexShader.replace(
            '#include <worldpos_vertex>',
            '#include <worldpos_vertex>\nbathWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;',
          );
        shader.fragmentShader =
          `varying vec3 bathWorld; uniform float bathTime;
          uniform vec4 bathFrames[${sources.length}]; uniform vec4 bathRooms[${sources.length}];
          uniform vec2 bathPools[${sources.length}];\n` +
          shader.fragmentShader.replace(
            '#include <emissivemap_fragment>',
            `
          #include <emissivemap_fragment>
          #ifdef USE_MAP
            // Keep 15 cm tile joints legible at room scale. A 3 mm seam in a mipmapped image
            // otherwise averages away several metres from the wall. Widen subpixel seams only
            // while individual tiles remain resolvable, then fade to avoid distant moiré.
            vec2 tileCell = vMapUv * vec2(4.0, 6.0);
            vec2 tilePixel = max(fwidth(tileCell), vec2(0.0001));
            vec2 tileEdge = min(fract(tileCell), 1.0 - fract(tileCell));
            vec2 tileWidth = max(vec2(0.012), tilePixel * 0.35);
            vec2 tileLine = 1.0 - smoothstep(tileWidth - tilePixel * 0.5, tileWidth + tilePixel * 0.5, tileEdge);
            float grout = max(tileLine.x, tileLine.y) * (1.0 - smoothstep(0.35, 0.7, max(tilePixel.x, tilePixel.y)));
            diffuseColor.rgb *= 1.0 - grout * 0.62;
          #endif
          float bathGlow = 0.0;
          for (int i = 0; i < ${sources.length}; i++) {
            vec2 delta = bathWorld.xy - bathFrames[i].xy;
            vec2 local = vec2(dot(delta, bathFrames[i].zw), dot(delta, vec2(-bathFrames[i].w, bathFrames[i].z)));
            if (abs(local.x) > bathRooms[i].x || abs(local.y) > bathRooms[i].y) continue;
            vec2 outside = max(abs(local) - bathPools[i], vec2(0.0));
            float dz = bathWorld.z - bathRooms[i].z;
            float falloff = 1.0 / (1.0 + 0.012 * (dot(outside, outside) + dz * dz));
            // Two independent phases on vertical faces as well as horizontal ones: a flat XY
            // projection stretches the caustics into neon stripes up every wall.
            vec3 phase = vec3(local, bathWorld.z) * 7.0;
            float a = sin(phase.x + phase.z * 0.91 + sin(phase.y * 0.81 + phase.z * 0.73 + bathTime * 0.6));
            float b = sin(phase.y - phase.z * 1.13 - sin(phase.x * 0.93 + phase.z * 1.31 - bathTime * 0.47));
            float focus = pow(max(0.0, 1.0 - abs(a + b) * 0.75), 10.0);
            // Diffuse reflected pool light carries the tiles; focused ripples modulate it.
            float spread = 0.65 + 0.35 * sin(local.x * 0.27 + sin(local.y * 0.23) + bathTime * 0.18);
            bathGlow += (0.65 + focus * 0.14 * spread / (1.0 + abs(dz) * 0.05)) * falloff * bathRooms[i].w;
          }
          totalEmissiveRadiance += vec3(0.40, 0.66, 1.0) * min(bathGlow, 1.8) * diffuseColor.rgb;
        `,
          );
      };
      material.customProgramCacheKey = () => `${source.customProgramCacheKey()}/bath-caustics-${sources.length}`;
      replacements.set(source, material);
      return material;
    };
    object.material = Array.isArray(object.material) ? object.material.map(replace) : replace(object.material);
  });
}
