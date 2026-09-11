import * as THREE from 'three';
import polygonClipping from 'polygon-clipping';
import {
  MercatorCoordinate,
  type CustomLayerInterface,
  type Map as MapLibreMap,
  type CustomRenderMethodInput,
} from 'maplibre-gl';
import type { Floor, MaterialKind, Point, ProjectDocument, Ring, SiteObject, Slope } from '../model/types';
import type { Route } from '../model/navigation';
import { legStepIndices } from './route';
import {
  closeRing,
  objectArea,
  objectPosition,
  objectRotation,
  openRing,
  rectangle,
  rotate,
  toLngLat,
} from '../model/geometry';
import { distance, pointInRing } from '../model/geometry';
import { floorOutline } from '../model/walls';
import { COLORS, objectRings, type WallPiece, wallPieces } from './features';
import {
  type Flight,
  flights,
  flightsAt,
  isVertical,
  pitchOf,
  reaches,
  servedFloors,
  shaftVoids,
} from '../model/vertical';
import type { StatusReading } from '../model/live';
import { makeFixture, makeRoof } from './architecture';
import { MaterialLibrary } from './materials';
import { EXTERIOR_PRESETS } from '../model/materials';
import type { MapStyleOptions } from '../theme';
import { exteriorWalls } from './exteriors';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { hitEntity, metricUVs, SurfaceBatch } from './surfaces';
import { excavationRings, floorIndex, MAX_CAGE_LEVELS, undergroundView } from './underground';
import { UndergroundCage, undergroundPit } from './UndergroundContext';
import { includeSceneDepth } from './projection';
import { syncLightingCamera } from './projection';
import type { SurfaceFinish } from './textures';
import { sunlight } from './lighting';

// Building geometry floats slightly above the basemap so slabs never z-fight with map tiles.
// Each floor gets an opaque slab; rooms sit on top of it with enough clearance to stay artifact-free.
// Areas on one floor are routinely nested: a parking bay inside an aisle inside a deck plate, a
// meeting room inside an open-plan zone. Drawn at the same base and height they are exactly coplanar,
// so the depth buffer cannot separate them and which one wins flickers as the camera moves. Stagger
// them by footprint: the smaller (more specific) area sits a few millimetres above the larger one it
// lies within — far below anything visible at building scale, far above depth-buffer precision.
const COPLANAR_STEP = 0.007;
export const nestingLift = (area: number) => COPLANAR_STEP * (area > 2000 ? 0 : area > 200 ? 1 : area > 20 ? 2 : 3);
// How far the contact shading rises off a slab, and how dark it gets right at the junction.
const AO_RISE = 0.85,
  AO_FLOOR = 0.58;
const LIFT = 0.15,
  SLAB = 0.18,
  ROOM = 0.05,
  GROUND = 0.06;
const wallBase = (floorId: string | null) => (floorId ? LIFT + SLAB : GROUND);

/** An escalator step: 0.4 m of going and a 0.2 m face, the world over. These are properties of the
 *  machine rather than of the drawing — a manufacturer's step is the same step in every building —
 *  so they are fixed here while the pitch, which the plan really does decide, is not. */
const STEP_GOING = 0.4,
  STEP_RISE = 0.2;

/** The steps of one escalator flight, bottom first.
 *
 *  `at` is how far up the run a step stands, measured in plan metres from the foot of the incline;
 *  `base` is how far above the foot its underside sits. The going is 0.4 m stretched to fill the
 *  incline exactly, so the band meets both comb plates instead of leaving a sliver at one end, and
 *  the riser is whatever the rise divided by the count comes to — a flight the plan has drawn too
 *  short shows as the steep stair it is instead of as a smooth ramp that hides the fact. */
function escalatorSteps(rise: number, deck: number): { at: number; base: number; going: number }[] {
  // Capped: a very long flight is read at a glance, not counted, and every step is a draw call's
  // worth of geometry in a scene that may hold a bank of them on seventeen storeys.
  const count = Math.max(2, Math.min(40, Math.round(deck / STEP_GOING)));
  const going = deck / count;
  return Array.from({ length: count }, (_, i) => ({
    at: going * (i + 0.5),
    // Tops land on the slope line, so the last step meets the upper comb plate rather than stopping
    // a riser short of it.
    base: (rise * (i + 1)) / count - STEP_RISE,
    going,
  }));
}

/** A part of the scene that moves: its own geometry, outside the merged batch, animated toward a
 *  target at a fixed speed. Everything else is welded into one buffer per material — which is what
 *  makes a tall building cheap to draw and impossible to move a single piece of. */
interface Rig {
  id: string;
  group: THREE.Group;
  /** Where it is heading, in whatever unit the part measures itself in — metres of elevation for a
   *  lift car, 0..1 open for a door leaf. */
  target: number;
  /** Units per second. A lift runs at about 1.5 m/s; a door takes about a second to swing. */
  speed: number;
  /** Runs forever, wrapping at the target rather than stopping there — an escalator's steps, which
   *  are identical and one pitch apart, so a wrap is invisible and the stair never stops moving. */
  loop?: boolean;
  apply: (group: THREE.Group, value: number) => void;
}
export class SceneLayer implements CustomLayerInterface {
  id = 'kerros-3d';
  type = 'custom' as const;
  renderingMode = '3d' as const;
  private map?: MapLibreMap;
  private renderer?: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.Camera();
  private worldToClip = new THREE.Matrix4();
  private clipToWorld = new THREE.Matrix4();
  private transform = new THREE.Matrix4();
  private center!: MercatorCoordinate;
  private unit = 1;
  private project?: ProjectDocument;
  private stack = false;
  /** Per-storey ghost strength, shared out across however many levels the stack layers up. */
  private ghostAlpha = 0.17;
  private activeFloor: string | null = null;
  private hovered: string | null = null;
  private rebase = 0;
  private growth = 1;
  private growthStart = 0;
  private materials = new MaterialLibrary();
  private batch = new SurfaceBatch();
  private highlight = new THREE.Group();
  private selected: string | null = null;
  private evening = false;
  private statuses: Map<string, StatusReading> | null = null;
  private excavation = false;
  /** Only the part of the feed the scene is built from — where the cars are and whether doors stand
   *  open. A tone changing from normal to alarm recolours a marker and must not rebuild the scene. */
  private liftSignature = '';
  /** Per-floor stairwell cut-outs; cleared with the scene. */
  private voidCache = new Map<string, Ring[]>();
  /** Moving parts, rebuilt with the scene each update — see `rig`. */
  private rigs: Rig[] = [];
  /** Where each moving part has got to, carried ACROSS rebuilds. The geometry is disposed with the
   *  scene like everything else; this is not, or every lift car would jump back to the bottom of its
   *  shaft on any edit, and every open door would slam. */
  private rigState = new Map<string, number>();
  /** Whether the last animation frame moved anything that casts a shadow. */
  private shadowsMoved = false;
  private lastFrame = 0;
  private revision = 0;
  private depthScale = 1;
  private buried = false;
  private presentedElevation = (z: number) => z;
  private cage = new UndergroundCage();
  private sun?: THREE.DirectionalLight;
  private route: Route | null = null;
  private routeStep: number | null = null;
  private routeGroup: THREE.Group | null = null;
  private mapStyle: MapStyleOptions = {};
  setMapStyle(style?: MapStyleOptions) {
    this.mapStyle = style ?? {};
  }
  private xyCache = new Map<string, Point>();
  private markerCache = new Map<string, { x: number; y: number; visible: boolean }>();
  // Whether each marker is hidden behind geometry. Screen position is cheap and recomputed every
  // frame; this is a raycast against the whole model and must NOT be. It survives camera movement and
  // is only re-derived once the camera settles (or the scene is rebuilt).
  private occlusionCache = new Map<string, boolean>();
  private previousProjection = new THREE.Matrix4();
  private previousScale = 0;
  private previousSize = '';
  private pickables: THREE.Object3D[] = [];
  private clipBounds = new THREE.Box3();
  private clipBoundsDirty = true;
  onAdd(map: MapLibreMap, gl: WebGLRenderingContext | WebGL2RenderingContext) {
    this.map = map;
    this.renderer = new THREE.WebGLRenderer({
      canvas: map.getCanvas(),
      context: gl as WebGL2RenderingContext,
      antialias: true,
    });
    this.renderer.autoClear = false;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.shadowMap.autoUpdate = false;
    // Filmic rolloff instead of a hard clip: bright façades keep their detail instead of blowing out
    // to flat white, and the shadow side keeps colour. Exposure is nudged up to compensate for the
    // slightly darker midtones ACES gives, so the model still sits in the basemap's brightness range.
    // Khronos PBR Neutral, not ACES. ACES is a *film* look: it crushes midtones towards grey and
    // desaturates hard, which on an architectural scene of pale interiors over a pale basemap left
    // every surface the same washed neutral. Measured on the Stockmann stack it was eating 29% of
    // the scene's saturation, and a plate with a clear blue cast came back perfectly colourless.
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    // Slightly under 1. The basemap underneath is not tone-mapped, so it always renders at full
    // strength; pulling the scene down is what separates a pale floor plate from a pale map. 0.9
    // keeps that separation while letting interiors stay bright — 0.82 read as overcast concrete,
    // and the authored room pastels were the first thing it crushed.
    this.renderer.toneMappingExposure = 0.9;
  }
  /** A tiny procedural sky/ground gradient, prefiltered for image-based lighting. Without an
   *  environment every MeshStandardMaterial is lit by two lights alone and reads flat; with one, every
   *  surface picks up sky above and bounced ground below, which is most of what makes 3D look solid.
   *  Built once per lighting mood and cached — PMREM generation is not cheap. */
  private envCache = new Map<string, THREE.WebGLRenderTarget>();
  private environmentMap(evening: boolean): THREE.Texture | null {
    const key = evening ? 'evening' : 'day';
    const cached = this.envCache.get(key);
    if (cached || !this.renderer) return cached?.texture ?? null;
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 256;
    const c = canvas.getContext('2d')!;
    const g = c.createLinearGradient(0, 0, 0, 256);
    if (evening) {
      g.addColorStop(0, '#22293f');
      g.addColorStop(0.42, '#5d5570');
      g.addColorStop(0.52, '#c08a5f');
      g.addColorStop(1, '#241f1c');
    } else {
      g.addColorStop(0, '#719dcc');
      g.addColorStop(0.35, '#c0d5e5');
      g.addColorStop(0.49, '#f6eedf');
      g.addColorStop(0.54, '#b3ada0');
      g.addColorStop(1, '#605f55');
    }
    c.fillStyle = g;
    c.fillRect(0, 0, 512, 256);
    // Broad sky openings add directional reflections without a downloaded HDR panorama.
    for (const [x, y, radius] of [
      [110, 83, 65],
      [370, 58, 44],
    ]) {
      const cloud = c.createRadialGradient(x, y, 0, x, y, radius);
      cloud.addColorStop(0, evening ? 'rgba(249,188,139,.42)' : 'rgba(255,252,239,.8)');
      cloud.addColorStop(1, 'rgba(255,255,255,0)');
      c.fillStyle = cloud;
      c.fillRect(x - radius, y - radius, radius * 2, radius * 2);
    }
    const equirect = new THREE.CanvasTexture(canvas);
    equirect.mapping = THREE.EquirectangularReflectionMapping;
    equirect.colorSpace = THREE.SRGBColorSpace;
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const target = pmrem.fromEquirectangular(equirect);
    equirect.dispose();
    pmrem.dispose();
    // PMREM leaves its own GL state behind; hand the context back to MapLibre the way it expects it.
    this.renderer.resetState();
    this.envCache.set(key, target);
    return target.texture;
  }
  /** Point the sun at the model and shrink its shadow frustum to fit. A fixed +/-140 m box spends
   *  most of a 2048 map on empty ground: a small building got a handful of texels and its shadows
   *  came out as soft mush. Fitting to the real extent keeps texel density high whatever the scale. */
  private fitShadowCamera() {
    const light = this.sun;
    if (!light) return;
    const bounds = new THREE.Box3();
    this.scene.traverse(o => {
      if (o instanceof THREE.Mesh && o.castShadow) bounds.expandByObject(o);
    });
    if (bounds.isEmpty()) return;
    const centre = bounds.getCenter(new THREE.Vector3());
    const size = bounds.getSize(new THREE.Vector3());
    light.target.position.copy(centre);
    light.target.updateMatrixWorld();
    // Keep the light's direction, just re-seat it above the model's centre far enough to clear it.
    const reach = Math.max(size.x, size.y, size.z) || 1;
    const direction = light.position.clone().normalize();
    light.position.copy(centre).addScaledVector(direction, reach * 1.6 + 40);
    light.updateMatrixWorld();
    // Fit in light space, including where the tallest corners project onto the ground. A low
    // evening sun can throw shadows far outside the building's footprint.
    const camera = light.shadow.camera;
    light.shadow.updateMatrices(light);
    const shadowBounds = new THREE.Box3();
    for (const x of [bounds.min.x, bounds.max.x])
      for (const y of [bounds.min.y, bounds.max.y])
        for (const z of [bounds.min.z, bounds.max.z]) {
          const corner = new THREE.Vector3(x, y, z);
          shadowBounds.expandByPoint(corner.clone().applyMatrix4(camera.matrixWorldInverse));
          if (!this.buried && z > 0) {
            corner.addScaledVector(direction, -z / direction.z);
            shadowBounds.expandByPoint(corner.applyMatrix4(camera.matrixWorldInverse));
          }
        }
    Object.assign(camera, {
      left: shadowBounds.min.x - 3,
      right: shadowBounds.max.x + 3,
      top: shadowBounds.max.y + 3,
      bottom: shadowBounds.min.y - 3,
      near: Math.max(0.5, -shadowBounds.max.z - 10),
      far: -shadowBounds.min.z + 10,
    });
    camera.updateProjectionMatrix();
  }
  private xy(p: Point): Point {
    const key = `${p[0]},${p[1]}`,
      cached = this.xyCache.get(key);
    if (cached) return cached;
    const m = MercatorCoordinate.fromLngLat(toLngLat(p, this.project!.origin));
    const result: Point = [(m.x - this.center.x) / this.unit, -(m.y - this.center.y) / this.unit];
    this.xyCache.set(key, result);
    return result;
  }
  /** Build a standalone piece of geometry — same extrusion as `surface`, but returned as its own
   *  group instead of welded into the batch, so something can move it. Its z is already presented,
   *  so a rig that moves it must present its own target too. */
  private part(rings: Point[][], base: number, height: number, color: string): THREE.Group {
    return this.parts([{ rings, base, height }], color);
  }
  /** Several extrusions welded into one moving part. An escalator's step band is twenty boxes that
   *  travel together, and twenty meshes per flight — times a bank of four, times the flights in
   *  view — is a draw call apiece for something that moves as one thing. Merged, it is one. */
  private parts(
    pieces: { rings: Point[][]; base: number; height: number }[],
    color: string,
    shadows = true,
  ): THREE.Group {
    const geometries = pieces.map(({ rings, base, height }) => {
      const shape = new THREE.Shape(rings[0].map(p => new THREE.Vector2(...this.xy(p))));
      shape.holes = rings.slice(1).map(r => new THREE.Path(r.map(p => new THREE.Vector2(...this.xy(p)))));
      const geometry = new THREE.ExtrudeGeometry(shape, { depth: height, bevelEnabled: false, steps: 1 });
      geometry.translate(0, 0, base);
      metricUVs(geometry);
      const positions = geometry.getAttribute('position');
      for (let i = 0; i < positions.count; i++) positions.setZ(i, this.present(positions.getZ(i)));
      geometry.computeVertexNormals();
      return geometry.index ? geometry.toNonIndexed() : geometry;
    });
    const merged = geometries.length === 1 ? geometries[0] : mergeGeometries(geometries)!;
    const mesh = new THREE.Mesh(merged, this.materials.solid(color));
    mesh.castShadow = shadows;
    mesh.receiveShadow = true;
    const group = new THREE.Group();
    group.add(mesh);
    return group;
  }
  /** Register a moving part. Called while the scene is being built; the geometry is fresh each time
   *  and the position it has reached is not, so a car mid-ride keeps riding across an edit.
   *
   *  `settled` seeds the value the first time a part is ever seen, so opening a document does not
   *  send every lift travelling up from the basement to wherever it actually is. */
  private rig(id: string, group: THREE.Group, target: number, speed: number, apply: Rig['apply'], loop = false) {
    if (!this.rigState.has(id)) this.rigState.set(id, loop ? 0 : target);
    apply(group, this.rigState.get(id)!);
    this.scene.add(group);
    this.rigs.push({ id, group, target, speed, apply, loop });
  }
  /** Advance every moving part toward its target. Returns true while anything is still moving, which
   *  is what keeps asking the map to repaint — MapLibre draws on demand, so without that a ride would
   *  advance one frame per mouse move. */
  private animate(seconds: number): boolean {
    let moving = false;
    // A looping part never settles, so it must not drag the shadow map with it: re-rendering every
    // caster in the building on every frame, forever, to follow an escalator step is the one cost
    // that would make a permanent animation not worth having. Loops cast no shadow of their own.
    this.shadowsMoved = false;
    for (const r of this.rigs) {
      const at = this.rigState.get(r.id) ?? r.target;
      if (r.loop) {
        const next = (at + r.speed * seconds) % r.target;
        this.rigState.set(r.id, next);
        r.apply(r.group, next);
        moving = true;
        continue;
      }
      if (Math.abs(at - r.target) < 1e-4) {
        if (at !== r.target) this.rigState.set(r.id, r.target);
        continue;
      }
      const step = r.speed * seconds;
      const next = Math.abs(r.target - at) <= step ? r.target : at + Math.sign(r.target - at) * step;
      this.rigState.set(r.id, next);
      r.apply(r.group, next);
      moving = true;
      this.shadowsMoved = true;
    }
    return moving;
  }
  private present(z: number) {
    return this.stack && this.buried ? this.presentedElevation(z) : z;
  }
  private surface(
    rings: Point[][],
    base: number,
    height: number,
    color: string,
    id: string,
    material?: SurfaceFinish,
    ghost = false,
    // Bake contact shading into the lower part of the surface. Where a wall meets a floor there is
    // almost no sky reaching the junction, and without that darkening every wall looks like it is
    // hovering a millimetre above the slab rather than standing on it.
    ao = false,
    override?: THREE.MeshStandardMaterial,
  ) {
    const shape = new THREE.Shape(rings[0].map(p => new THREE.Vector2(...this.xy(p))));
    shape.holes = rings.slice(1).map(r => new THREE.Path(r.map(p => new THREE.Vector2(...this.xy(p)))));
    const geometry =
      height > 0.005
        ? new THREE.ExtrudeGeometry(shape, {
            depth: height,
            bevelEnabled: false,
            steps: ao && !ghost ? Math.min(24, Math.max(1, Math.ceil(height / 0.35))) : 1,
          })
        : new THREE.ShapeGeometry(shape);
    geometry.translate(0, 0, base);
    metricUVs(geometry);
    // Computed before any depth compression, so the gradient follows real metres off the floor.
    if (ao && !ghost) {
      const positions = geometry.getAttribute('position');
      const shades = new Float32Array(positions.count * 3);
      for (let i = 0; i < positions.count; i++) {
        const above = Math.max(0, Math.min(1, (positions.getZ(i) - base) / AO_RISE));
        const shade = AO_FLOOR + (1 - AO_FLOOR) * above ** 0.55;
        shades[i * 3] = shades[i * 3 + 1] = shades[i * 3 + 2] = shade;
      }
      geometry.setAttribute('color', new THREE.BufferAttribute(shades, 3));
    }
    if (this.stack && this.buried && this.depthScale < 1) {
      const positions = geometry.getAttribute('position');
      for (let i = 0; i < positions.count; i++) positions.setZ(i, this.present(positions.getZ(i)));
      geometry.computeVertexNormals();
    }
    const surfaceMaterial =
      override ??
      (ghost
        ? this.materials.ghost(color, this.ghostAlpha)
        : material
          ? this.materials.get(material, color)
          : this.materials.solid(color));
    this.batch.add(geometry, ao && !ghost ? this.materials.shaded(surfaceMaterial) : surfaceMaterial, id);
  }
  /** A sloped area (garage ramp, loading incline): the plate's own footprint, but each vertex lifted
   *  to its elevation along the slope axis, then given thickness along -Z so the deck reads solid
   *  from below. Depth compression is applied per-vertex, exactly as for flat surfaces. */
  private slopedSurface(o: SiteObject, slope: Slope, lift: number, thickness: number, color: string) {
    const shape = new THREE.Shape(o.rings![0].map(p => new THREE.Vector2(...this.xy(p))));
    shape.holes = o.rings!.slice(1).map(r => new THREE.Path(r.map(p => new THREE.Vector2(...this.xy(p)))));
    const geometry = new THREE.ExtrudeGeometry(shape, { depth: thickness, bevelEnabled: false });
    geometry.translate(0, 0, -thickness); // extrude downward: the driving surface is the top face
    metricUVs(geometry);
    // Ride the slope in scene space: Mercator is conformal, so at building scale xy() is an affine
    // similarity and projecting onto the transformed axis matches slopeElevation() in local metres.
    const [ax, ay] = this.xy(slope.axis[0]),
      [bx, by] = this.xy(slope.axis[1]);
    const dx = bx - ax,
      dy = by - ay,
      len2 = dx * dx + dy * dy;
    const positions = geometry.getAttribute('position');
    for (let i = 0; i < positions.count; i++) {
      const t = len2
        ? Math.max(0, Math.min(1, ((positions.getX(i) - ax) * dx + (positions.getY(i) - ay) * dy) / len2))
        : 0;
      // getZ is 0 on the driving surface and -thickness underneath, so the deck keeps its thickness.
      positions.setZ(i, this.present(positions.getZ(i) + slope.high + (slope.low - slope.high) * t + lift));
    }
    geometry.computeVertexNormals();
    this.batch.add(geometry, this.materials.solid(color), o.id);
  }
  /** The façade envelope for a set of levels: each level's slab, its exterior walls with their
   *  authored finish, and the glazing punched into them. Interior partitions are deliberately left
   *  out — from outside they are hidden work, and they used to produce seams along the façade. */
  private envelope(
    project: ProjectDocument,
    levels: Map<string, Floor>,
    exterior: Set<string>,
    finishes: Map<string, { color: string; material?: MaterialKind }>,
  ) {
    for (const o of project.objects) {
      const fl = levels.get(o.floorId ?? '');
      if (!fl) continue;
      if (o.kind === 'zone' && o.rings) this.surface(o.rings, fl.elevation + LIFT, SLAB, '#c8c5bd', o.id);
      if (o.kind === 'window' && o.barrierId && exterior.has(o.barrierId)) this.opening(project, o, fl.elevation);
    }
    for (const p of wallPieces(project, null, true))
      if (levels.has(p.floorId ?? '') && exterior.has(p.id)) {
        const finish = finishes.get(p.id)!;
        this.surface([p.ring], p.base + wallBase(p.floorId), p.height - p.base, finish.color, p.id, finish.material);
      }
  }
  private opening(project: ProjectDocument, o: SiteObject, z: number) {
    const position = objectPosition(project, o),
      rotation = objectRotation(project, o);
    if (o.kind === 'window') {
      const barrier = project.barriers.find(b => b.id === o.barrierId);
      const height = Math.min(o.height, (barrier?.height ?? o.height + 0.85) - 0.85);
      if (height <= 0) return;
      const base = z + wallBase(o.floorId) + 0.85,
        rim = Math.min(0.08, height / 3, o.width / 3);
      const depth = Math.max(0.16, (barrier?.thickness ?? 0.2) + 0.035);
      const frame = this.materials.metal('#b4b9ba');
      const lit = [...o.id].reduce((sum, ch) => sum + ch.charCodeAt(0), 0) % 5 < 2;
      const glass = this.materials.glass(this.evening, lit);
      const side = (
        offset: number,
        width: number,
        bottom: number,
        h: number,
        material: THREE.MeshStandardMaterial,
        d = depth,
      ) => {
        const delta = rotate([offset, 0], rotation);
        this.surface(
          [rectangle([position[0] + delta[0], position[1] + delta[1]], width, d, rotation)],
          bottom,
          h,
          '#ffffff',
          o.id,
          undefined,
          false,
          false,
          material,
        );
      };
      side(0, o.width + 0.08, base - 0.04, 0.065, this.materials.get('stone', '#b9b6ac'), depth + 0.12);
      side(0, o.width, base, rim, frame);
      side(0, o.width, base + height - rim, rim, frame);
      for (const sign of [-1, 1]) side((sign * (o.width - rim)) / 2, rim, base + rim, height - rim * 2, frame);
      side(0, o.width - rim * 2, base + rim, height - rim * 2, glass, Math.max(0.035, depth - 0.1));
      const panes = Math.max(1, Math.ceil(o.width / 1.45));
      for (let i = 1; i < panes; i++)
        side(-o.width / 2 + (i * o.width) / panes, 0.045, base + rim, height - rim * 2, frame);
    } else if (o.kind === 'stairs') {
      this.shaft(project, o, z, position, rotation);
    } else if (o.kind === 'elevator') {
      this.lift(project, o, z, position, rotation);
    } else if (['door', 'gate'].includes(o.kind)) {
      this.leaf(project, o, z, position, rotation);
    } else {
      this.surface(
        objectRings({ ...o, position, rotation }),
        z + wallBase(o.floorId),
        Math.min(o.height, 3),
        o.color ?? COLORS[o.kind] ?? '#bfcac7',
        o.id,
      );
    }
  }
  /** A door as a leaf in a frame, standing open when the feed says it is.
   *
   *  In 3D a door had been a slab filling its whole opening — a door you could never walk through and
   *  that looked identical whether it was open, closed or unmonitored. The plan has drawn the swing
   *  for a long time; this is the same statement in three dimensions, hinged the same way, so the two
   *  views agree about which side it opens from.
   *
   *  Unknown status means shut. The plan can draw the architectural swing symbol for "a door is here
   *  and this is how it opens" because a symbol is allowed to be about the door rather than about its
   *  state; a solid leaf in space is not, so it stays in the frame until something says otherwise. */
  private leaf(project: ProjectDocument, o: SiteObject, z: number, position: Point, rotation: number) {
    const barrier = project.barriers.find(b => b.id === o.barrierId);
    const thickness = barrier?.thickness ?? 0.2;
    const base = z + wallBase(o.floorId);
    const height = Math.min(o.height, (barrier?.height ?? o.height) - 0.02);
    // NOT the plan's door colour. That indigo is a symbol — it marks a door on a drawing, where it
    // has to stand out from the walls around it. Extruded into a solid leaf it is a purple slab in
    // a room, which is the one thing a door never looks like. A door is a door-coloured object.
    const color = o.color ?? '#cbb79f';
    // The head above the opening, so the wall reads as continuous rather than as a slot to the
    // ceiling — and so an open door leaves a doorway rather than a gap in the storey.
    const over = (barrier?.height ?? height) - height;
    if (over > 0.05)
      this.surface(
        [rectangle(position, o.width, thickness, rotation)],
        base + height,
        over,
        barrier?.color ?? '#b9b6ac',
        o.id,
      );
    // Hinged at the same edge the plan hinges it — features.ts swings from -width/2 about `rotation`.
    const hinge = rotate([-o.width / 2, 0], rotation);
    const pivot: Point = [position[0] + hinge[0], position[1] + hinge[1]];
    // Built lying in the frame with its hinge at the group's origin, so rotating the group about z
    // swings it exactly as the 2D symbol does.
    const centre = rotate([o.width / 2, 0], rotation);
    const panel = this.part(
      [rectangle([pivot[0] + centre[0], pivot[1] + centre[1]], o.width - 0.04, Math.min(0.06, thickness), rotation)],
      base + 0.01,
      height,
      color,
    );
    const at = this.xy(pivot);
    for (const child of panel.children) child.position.set(-at[0], -at[1], 0);
    panel.position.set(at[0], at[1], 0);
    const status = this.statuses?.get(o.feedId ?? '');
    // 72°, matching the plan: a leaf drawn flat against the wall reads as part of the wall.
    this.rig(`${o.id}:leaf`, panel, status?.open ? 1 : 0, 1.4, (g, v) => {
      g.rotation.z = -(72 * Math.PI * v) / 180;
    });
  }
  /** A thin skin lying on the inside face of an exterior wall.
   *
   *  Which face is the inside is not a property of the wall — it is a question about the building
   *  around it — so it is answered the only way it can be: step off the wall each way and see which
   *  side lands within the floor's footprint. A wall with no footprint to be inside of (an outbuilding
   *  wall, a fence read as exterior) gets no lining, which is right. */
  private lining(project: ProjectDocument, piece: WallPiece, floorId: string | null): Ring | null {
    const outline = floorOutline(project, piece.floorId ?? floorId);
    if (!outline.length) return null;
    const ring = openRing(piece.ring);
    if (ring.length !== 4) return null;
    // A wall piece is a rectangle: one pair of sides is its length, the other its thickness.
    const e1 = distance(ring[0], ring[1]),
      e2 = distance(ring[1], ring[2]);
    const [along, thickness] = e1 >= e2 ? [[ring[0], ring[1]] as const, e2] : [[ring[1], ring[2]] as const, e1];
    const len = distance(along[0], along[1]);
    if (len < 0.05 || thickness < 0.03) return null;
    const angle = (Math.atan2(along[1][1] - along[0][1], along[1][0] - along[0][0]) * 180) / Math.PI;
    const nx = -(along[1][1] - along[0][1]) / len,
      ny = (along[1][0] - along[0][0]) / len;
    const mid: Point = [ring.reduce((t, q) => t + q[0], 0) / 4, ring.reduce((t, q) => t + q[1], 0) / 4];
    const skin = Math.min(0.05, thickness / 3);
    for (const sign of [1, -1]) {
      const probe: Point = [mid[0] + nx * sign * (thickness / 2 + 0.3), mid[1] + ny * sign * (thickness / 2 + 0.3)];
      if (!outline.some(r => pointInRing(probe, r))) continue;
      // Sitting just proud of the wall's own face, or the two fight for the same pixels.
      const out = thickness / 2 - skin / 2 + 0.003;
      return closeRing(rectangle([mid[0] + nx * sign * out, mid[1] + ny * sign * out], len, skin, angle));
    }
    return null;
  }
  /** An area's rings with the shafts that pass through its level cut out of them.
   *
   *  Cheap when there is nothing to cut, which is the usual case: a floor with no shaft through it
   *  gets its own rings back untouched, and one with a shaft pays a clip only for the areas the
   *  shaft actually lands in. */
  private withVoids(project: ProjectDocument, rings: Ring[], floorId: string, primary: Set<string>): Ring[] {
    let voids = this.voidCache.get(floorId);
    if (!voids) {
      voids = shaftVoids(project, floorId, primary);
      this.voidCache.set(floorId, voids);
    }
    if (!voids.length || !rings.length) return rings;
    const hits = voids.filter(v => v.some(p => pointInRing(p, rings[0])) || rings[0].some(p => pointInRing(p, v)));
    if (!hits.length) return rings;
    try {
      const cut = polygonClipping.difference(
        [rings.map(r => closeRing(r))] as never,
        ...hits.map(v => [v] as never),
      ) as unknown as Ring[][];
      return cut.flat();
    } catch {
      return rings; // degenerate shaft footprint: an uncut floor beats no floor
    }
  }
  /** A stair, spiral or escalator, drawn as the climb it actually makes.
   *
   *  The flights come from the levels the document says the shaft serves, not from whatever storey
   *  happens to sit above it, and each is drawn at the elevation of the level it leaves — so the
   *  flight arriving at the level you are standing on is there, coming up through the floor, instead
   *  of being filed invisibly under the storey below. */
  private shaft(project: ProjectDocument, o: SiteObject, z: number, position: Point, rotation: number) {
    const color = o.color ?? COLORS[o.kind] ?? '#bfcac7';
    const own = project.floors.find(f => f.id === o.floorId)?.elevation ?? 0;
    const all = flights(project, o);
    // No authored geometry: read one off the plan. A footprint that cannot take the rise at a civil
    // pitch is describing a stair that turns, which is what a short wide core box always is.
    const model =
      o.stairModel ?? (all.length && pitchOf(all[0].rise, Math.max(0.6, o.depth)) > 38 ? 'switchback' : 'straight');
    // Every flight when the whole stack is on show; otherwise the two you could touch from here —
    // the one arriving at this level and the one leaving it. Drawing all of them in a single-floor
    // view hangs a ladder of treads through storeys that are not being drawn.
    const near = this.stack
      ? all
      : (() => {
          const { up, down } = flightsAt(project, o, this.activeFloor);
          return [down, up].filter((f): f is Flight => !!f);
        })();
    if (!near.length) {
      // Serves one level only: there is no climb to draw, and a plate is the honest picture.
      this.surface(objectRings({ ...o, position, rotation }), z + wallBase(o.floorId), 0.18, color, o.id);
      return;
    }
    for (const flight of near) {
      const base = z + (flight.from.elevation - own) + wallBase(o.floorId);
      if (model === 'spiral') {
        this.spiral(o, position, base, flight.rise, color);
        continue;
      }
      // A bank of escalators is stacked criss-cross: each flight sits over the one below and runs
      // the other way, so you step off one and turn to step onto the next. Drawing every flight the
      // same way up would make a single impossible ramp climbing the whole building.
      const index = all.indexOf(flight);
      const reversed = model === 'escalator' && index % 2 === 1;
      this.flight(o, position, rotation + (reversed ? 180 : 0), base, flight.rise, color, model);
    }
  }
  /** A straight climb: treads for a stair, a ribbed deck between flat landing plates for an
   *  escalator. Both run along the object's own depth axis, which is where the plan put them. */
  private flight(
    o: SiteObject,
    position: Point,
    rotation: number,
    base: number,
    rise: number,
    color: string,
    model: 'straight' | 'switchback' | 'dogleg' | 'escalator',
  ) {
    const rad = (rotation * Math.PI) / 180;
    // Unit vector along the run, in plan metres. The footprint's depth is the run the drawing gives
    // it — if that is short for the rise, the thing really is as steep as it looks, and saying so is
    // more useful than quietly lying about the pitch.
    const ux = Math.sin(rad),
      uy = -Math.cos(rad);
    const at = (t: number): Point => [position[0] + ux * t, position[1] + uy * t];
    const run = Math.max(0.6, o.depth);
    const half = run / 2;
    if (model === 'escalator') {
      // Landing plates at both ends, then the incline between them. A real escalator has about a
      // metre of flat comb plate at each end; without them the deck spears into the floor.
      const pad = Math.min(1, run / 4);
      const deck = run - pad * 2;
      // And the steps themselves. An escalator is a moving STAIR, and drawing its deck as one smooth
      // ramp is what made a bank of them read as slides: nothing in the picture said you would be
      // standing on the level. The step is the one fixed thing about the machine — 0.4 m of going,
      // whatever the pitch — so the band is however many of those fit the incline, and the riser
      // follows from the rise it has to climb. A drawing that gives the run too little length still
      // shows the steep flight it describes, in steps, which is a more useful lie to catch.
      const band = escalatorSteps(rise, deck);
      const going = band[0].going,
        riser = rise / band.length;
      // The comb plates the band runs out of and into. The upper one is as deep as a riser rather
      // than a fixed slab, because the step that has just left the top of a moving band has to go
      // somewhere and under that plate is where: see the spare steps below.
      const comb = Math.max(0.2, riser + 0.04);
      this.surface([rectangle(at(half - pad / 2), o.width, pad, rotation)], base, 0.2, color, o.id);
      this.surface([rectangle(at(-half + pad / 2), o.width, pad, rotation)], base + rise, comb, color, o.id);
      // The truss the steps ride on: the old smooth deck, dropped clear of the step band so it reads
      // as the machine under the stair rather than as the surface you walk on.
      const body = { ...o, rings: [rectangle(at(0), o.width, deck, rotation)] } as SiteObject;
      this.slopedSurface(
        body,
        { axis: [at(-half + pad), at(half - pad)], high: base + rise, low: base },
        -STEP_RISE,
        0.3,
        '#9aa5a1',
      );
      const tread = (step: { at: number; base: number }) => ({
        rings: [rectangle(at(half - pad - step.at), o.width - 0.12, going * 1.02, rotation)],
        base: base + step.base,
        height: STEP_RISE,
      });
      // Standing on one storey there are at most two flights in view, so they can move. In the
      // stacked view there are all of them, on every level of the building at once — dozens of bands
      // asking for a repaint every frame to animate something a few pixels wide — so there the band
      // is welded into the batch with everything else and simply stands still.
      if (this.stack) {
        for (const step of band) {
          const piece = tread(step);
          this.surface(piece.rings, piece.base, piece.height, color, o.id);
        }
      } else {
        // The band travels exactly one step per cycle. Every step is identical and one pitch from
        // the next, so a wrap back to the start puts each one exactly where its neighbour was and
        // the stair never appears to stop.
        //
        // The ends are the whole difficulty. A rigid band gains a step at one end of its travel and
        // loses one at the other, and a step that pops into being in open air is what a moving
        // staircase must never look like. So it carries one spare below the foot — it starts the
        // cycle under the lower comb plate and climbs out from beneath it, which is what a real
        // escalator does anyway — and at the head the step that has climbed past the last visible
        // one finishes its cycle inside the upper plate, which is why that plate is a riser deep
        // rather than a slab: it is the head housing the band runs into. A descending band is the
        // same picture upside down, so its spare waits in the head housing instead.
        //
        // Which way the machine runs is said the way the demo says it — in the name, which is also
        // where the ontology reads it from. A flight that says nothing carries you up.
        const way = /\bdown\b/i.test(o.name ?? '') ? -1 : 1;
        const spare =
          way > 0
            ? { at: -going / 2, base: -STEP_RISE }
            : { at: deck + going / 2, base: rise + riser - STEP_RISE };
        const group = this.parts([spare, ...band].map(tread), color, false);
        // One step's travel, in scene space, taken by projecting two plan points rather than by
        // rebuilding the rotation here: `xy` is the only thing that knows which way plan north
        // points on screen, and asking it twice is cheaper than being wrong about the frame.
        const foot = this.xy(at(0)),
          next = this.xy(at(-going * way));
        const dz = this.present(base + riser * way) - this.present(base);
        this.rig(
          `${o.id}:steps:${Math.round(base * 100)}`,
          group,
          1,
          // Half a metre a second along the incline is an ordinary escalator — a step a second.
          0.5 / Math.hypot(going, riser),
          (g, v) => g.position.set((next[0] - foot[0]) * v, (next[1] - foot[1]) * v, dz * v),
          true,
        );
      }
      // Balustrades: a waist-high blade either side, following the same incline.
      for (const sign of [-1, 1]) {
        const side = [sign * (o.width / 2 - 0.06), 0] as Point;
        const offset = rotate(side, rotation);
        const rail = {
          ...o,
          rings: [rectangle([at(0)[0] + offset[0], at(0)[1] + offset[1]], 0.1, deck, rotation)],
        } as SiteObject;
        this.slopedSurface(
          rail,
          {
            axis: [
              [at(-half + pad)[0] + offset[0], at(-half + pad)[1] + offset[1]],
              [at(half - pad)[0] + offset[0], at(half - pad)[1] + offset[1]],
            ],
            high: base + rise + 0.95,
            low: base + 0.95,
          },
          0,
          0.08,
          '#8f9a96',
        );
      }
      return;
    }
    // A stair is steps, and a stair that cannot climb its storey in one run turns back on itself —
    // which is what a real core stair does and why a core box is short and wide rather than long.
    // Straight, a 4.4 m storey over a 4.5 m run is a 44° chute; two flights with a half-landing
    // between them is 26° and fits the same box. The footprint still decides: the number of sweeps
    // is whatever keeps the pitch civil inside the plan's own outline.
    // A straight stair is one run; the turning ones are two half-runs about a landing. Half the rise
    // each, so a 4.4 m storey over a 4.5 m box climbs at 26° twice instead of 44° once — which is the
    // difference between a stair and a chute, and why a real core stair is short and wide.
    const sweeps = model === 'straight' ? 1 : 2;
    // A half-turn puts the second flight beside the first, facing back. A quarter-turn puts it across
    // the landing at right angles. Both climb the same; they differ in where the second run lies.
    const turn = model === 'dogleg' ? 90 : 180;
    const laneWidth = sweeps > 1 ? o.width / 2 : o.width;
    for (let lane = 0; lane < sweeps; lane++) {
      const from = base + (rise * lane) / sweeps,
        climb = rise / sweeps;
      // A 175 mm riser is the comfortable domestic figure and close to code everywhere; capped so a
      // tall storey does not spend hundreds of boxes on something read at a glance.
      const steps = Math.max(2, Math.min(24, Math.round(climb / 0.175)));
      const going = run / steps;
      const spin = rotation + (lane ? turn : 0);
      const rad = (spin * Math.PI) / 180;
      const vx = Math.sin(rad),
        vy = -Math.cos(rad);
      // Second flight sits beside the first across the footprint, not through it.
      const offset = lane && sweeps > 1 ? rotate([laneWidth / 2, 0], rotation) : ([0, 0] as Point);
      const shifted = lane ? ([position[0] + offset[0], position[1] + offset[1]] as Point) : position;
      const on = (t: number): Point => [shifted[0] + vx * t, shifted[1] + vy * t];
      if (lane && sweeps > 1) {
        // The landing the turn happens on, at the height the first flight reached.
        this.surface(
          [rectangle(on(half - going / 2), laneWidth * 1.9, going * 1.7, spin)],
          from - 0.05,
          0.11,
          color,
          o.id,
        );
      }
      for (let i = 0; i < steps; i++) {
        this.surface(
          [rectangle(on(half - going * (i + 0.5)), laneWidth * 0.94, going * 1.02, spin)],
          from + (climb * i) / steps,
          climb / steps + 0.04,
          color,
          o.id,
        );
      }
    }
  }
  /** A lift: the shaft as tall as the levels it serves, its doors on the level you are standing on,
   *  and the car where the feed says it is.
   *
   *  It used to be a 1.2 m box — shorter than the doors it was supposed to contain — because the
   *  generic object path capped elevators there to stop them blocking the view. A lift is not
   *  furniture: it is a hole through the building, and drawing it as one is the only way the plan
   *  shows that floors 2 and 7 are on the same shaft. Above the level in focus it turns to ghost, so
   *  it reads as continuing without becoming a column in front of everything else. */
  private lift(project: ProjectDocument, o: SiteObject, z: number, position: Point, rotation: number) {
    const color = o.color ?? COLORS[o.kind] ?? '#bfcac7';
    const own = project.floors.find(f => f.id === o.floorId)?.elevation ?? 0;
    const levels = servedFloors(project, o);
    const base = z + wallBase(o.floorId);
    const rel = (f: Floor) => z + (f.elevation - own) + wallBase(o.floorId);
    const active = project.floors.find(f => f.id === this.activeFloor);
    if (levels.length < 2) {
      this.surface(objectRings({ ...o, position, rotation }), base, Math.min(o.height, 2.4), color, o.id);
      return;
    }
    const bottom = rel(levels[0]);
    const top = rel(levels[levels.length - 1]) + (levels[levels.length - 1].height ?? o.height);
    // Split at the level in focus: solid to the head of this storey, ghost for whatever is above it.
    const cut = active ? Math.min(top, z + (active.elevation - own) + wallBase(o.floorId) + (active.height ?? 3)) : top;
    const shell = (from: number, to: number, ghost: boolean) => {
      if (to - from < 0.05) return;
      const t = 0.09;
      for (const [w, d, dx, dy] of [
        [o.width, t, 0, (o.depth - t) / 2],
        [o.width, t, 0, -(o.depth - t) / 2],
        [t, o.depth, (o.width - t) / 2, 0],
        [t, o.depth, -(o.width - t) / 2, 0],
      ] as [number, number, number, number][]) {
        const at = rotate([dx, dy], rotation);
        this.surface(
          [rectangle([position[0] + at[0], position[1] + at[1]], w, d, rotation)],
          from,
          to - from,
          ghost ? color : '#b4bab7',
          o.id,
          undefined,
          ghost,
        );
      }
    };
    shell(bottom, cut, false);
    shell(cut, top, true);
    // The landing doors, on the storey in focus, facing the way the lift is turned. Two leaves that
    // part: closed unless the feed says this car is standing here with its doors open.
    const reading = this.statuses?.get(o.feedId ?? '');
    const carFloor = reading?.carFloorId ?? null;
    // The car rides to the level the feed names, or waits at the bottom of its shaft — which is what
    // an idle lift actually does. Its target is an ELEVATION, not a floor: the ride takes as long as
    // the distance, so eight storeys is a longer journey than one.
    const carAt = levels.find(f => f.id === carFloor) ?? levels[0];
    const inset = 0.14,
      carHeight = Math.min(2.3, (carAt.height ?? 3) - 0.4);
    const car = this.part(
      [rectangle(position, Math.max(0.4, o.width - inset * 2), Math.max(0.4, o.depth - inset * 2), rotation)],
      0,
      carHeight,
      reading?.carFloorId ? '#dfe6e3' : '#cdd4d1',
    );
    // 1.5 m/s is an ordinary passenger lift. Interpolating in metres and mapping through present()
    // keeps the ride honest under the stacked view's depth compression.
    this.rig(`${o.id}:car`, car, rel(carAt) + 0.04, 1.5, (g, v) => {
      g.position.z = this.present(v) - this.present(0);
    });
    if (active && levels.some(f => f.id === active.id)) {
      const head = Math.min(2.3, (active.height ?? 3) - 0.35);
      // Doors open only once the car is standing here. A feed that says "open" while the car is four
      // floors away is describing something that cannot happen, and drawing it would be a lie about
      // the building; the host sends `open` when the lift arrives.
      const arrived = Math.abs((this.rigState.get(`${o.id}:car`) ?? rel(carAt)) - rel(active)) < 0.25;
      const doorsOpen = !!reading?.open && arrived;
      // A level the shaft merely passes has no doors at all — it is not in `levels`, so this is
      // skipped there and the void is all you see. A car that opens on more than one face lists
      // them; the default is the front, which is what nearly every lift does.
      for (const face of o.doorSides ?? ['front']) {
        // Each face turns the leaves a further quarter-turn and measures across the matching side.
        const turn = { front: 0, right: 90, back: 180, left: 270 }[face];
        const spin = rotation + turn;
        const across = turn % 180 === 0 ? o.width : o.depth;
        const out = (turn % 180 === 0 ? o.depth : o.width) / 2 - 0.03;
        const leaf = across / 2 - 0.03;
        for (const sign of [-1, 1]) {
          const shut = rotate([sign * (leaf / 2), out], spin);
          const panel = this.part(
            [rectangle([position[0] + shut[0], position[1] + shut[1]], leaf, 0.07, spin)],
            rel(active) + 0.02,
            head,
            '#98a3a6',
          );
          // Leaves part sideways, so the animated value is how far open (0..1) and the group slides
          // along the face. A little over a second end to end, which is what a lift door takes.
          const travel = rotate([sign * (across / 2 - 0.06), 0], spin);
          this.rig(`${o.id}:door:${face}:${sign}`, panel, doorsOpen ? 1 : 0, 0.9, (g, v) => {
            g.position.x = travel[0] * v;
            g.position.y = -travel[1] * v;
          });
        }
      }
    }
  }
  /** A spiral: wedge treads winding around a central pole.
   *
   *  Its exits are wherever it is served — a spiral passing three levels with a landing on each is
   *  one object serving three floors, which the document could already say and nothing drew. */
  private spiral(o: SiteObject, position: Point, base: number, rise: number, color: string) {
    const outer = Math.max(0.8, Math.min(o.width, o.depth) / 2);
    const inner = Math.min(0.16, outer / 5);
    const steps = Math.max(6, Math.min(30, Math.round(rise / 0.18)));
    // One full turn per storey reads as a spiral at any storey height; more would be a screw, less a
    // ramp with a kink.
    const sweep = (2 * Math.PI) / steps;
    for (let i = 0; i < steps; i++) {
      const a0 = i * sweep,
        a1 = a0 + sweep * 1.04;
      const ring: Point[] = [];
      for (const [r, from, to] of [
        [outer, a0, a1],
        [inner, a1, a0],
      ] as [number, number, number][]) {
        const span = 4;
        for (let k = 0; k <= span; k++) {
          const a = from + ((to - from) * k) / span;
          ring.push([position[0] + Math.cos(a) * r, position[1] + Math.sin(a) * r]);
        }
      }
      this.surface([closeRing(ring)], base + (rise * i) / steps, 0.07, color, o.id);
    }
    // The pole the whole thing hangs off.
    this.surface([rectangle(position, inner * 2, inner * 2, 0)], base, rise, '#9aa3a0', o.id);
  }
  update(
    project: ProjectDocument,
    floorId: string | null,
    stack: boolean,
    selected: string | null,
    evening = false,
    statuses: Map<string, StatusReading> | null = null,
    excavation = false,
  ) {
    const liftSignature = statuses
      ? [...statuses.values()]
          .filter(r => r.carFloorId !== undefined || r.open !== undefined)
          .map(r => `${r.feedId}:${r.carFloorId ?? ''}:${r.open ?? ''}`)
          .sort()
          .join('|')
      : '';
    this.statuses = statuses;
    if (
      this.project === project &&
      this.stack === stack &&
      this.activeFloor === floorId &&
      this.evening === evening &&
      this.liftSignature === liftSignature &&
      this.excavation === excavation &&
      this.scene.children.length
    ) {
      if (this.selected !== selected) {
        this.selected = selected;
        this.refreshHighlight();
      }
      return;
    }
    if (this.project !== project) this.xyCache.clear();
    this.voidCache.clear();
    this.disposeScene();
    // The groups went with the scene; where their parts had got to did not.
    this.rigs = [];
    this.project = project;
    this.stack = stack;
    this.activeFloor = floorId;
    this.selected = selected;
    this.evening = evening;
    this.liftSignature = liftSignature;
    this.excavation = excavation;
    this.revision++;
    const exterior = exteriorWalls(project);
    const index = floorIndex(project),
      floors = index.floors;
    const buildings = new Map(project.buildings.map(b => [b.id, b]));
    const finishes = new Map(
      project.barriers.map(b => {
        const preset = buildings.get(floors.get(b.floorId ?? '')?.buildingId ?? '')?.exteriorPreset;
        return [
          b.id,
          exterior.has(b.id)
            ? preset
              ? EXTERIOR_PRESETS[preset]
              : b.material
                ? { material: b.material, color: b.color ?? '#c8c3b7' }
                : EXTERIOR_PRESETS.limestone
            : {
                material: b.material ?? (b.kind === 'wall' ? ('plaster' as const) : undefined),
                // An interior wall is plastered, and plaster is near-white. COLORS.wall is the grey
                // a wall is DRAWN in — a stroke on a plan has to read against a pale floor, so it is
                // mid-grey by necessity — and standing that grey up as a surface, shaded and with
                // contact shadow at its foot, made every partition read as bare concrete. A fence
                // keeps its drawn colour: it has no plaster and is not a room's wall.
                color: b.color ?? (b.kind === 'wall' ? '#eef0f3' : COLORS[b.kind]),
              },
        ];
      }),
    );
    const view = undergroundView(project, floorId, stack),
      activeF = view.active,
      buried = view.buried;
    this.buried = buried;
    this.depthScale = view.depthScale;
    this.presentedElevation = view.elevation;
    this.rebase = stack ? 0 : view.focusElevation;
    // Deep stacks show the complete structure with detail on the selected floor. Building every
    // room and fitting hundreds of metres into a city camera wasted work on hidden geometry.
    const structureOverview = buried && stack && view.levels.length > 16 && !!activeF;
    const outlineOnly = new Set(
      structureOverview ? view.levels.filter(f => f.elevation > activeF!.elevation).map(f => f.id) : [],
    );
    // Storeys UNDER the one in focus are drawn as a shell: exterior walls and one slab, nothing
    // inside. Looking down a stack you cannot see a lower storey's partitions through its own
    // ceiling anyway, so building them is geometry nobody sees — and on a tall building it is most
    // of the scene. The shell still says where the storey is and how far it reaches.
    const shellBelow = new Set(
      stack && activeF
        ? view.levels.filter(f => f.buildingId === activeF.buildingId && f.elevation < activeF.elevation).map(f => f.id)
        : [],
    );
    this.center = MercatorCoordinate.fromLngLat(toLngLat([0, 0], project.origin));
    this.unit = this.center.meterInMercatorCoordinateUnits();
    this.transform
      .makeTranslation(this.center.x, this.center.y, 0)
      .scale(new THREE.Vector3(this.unit, -this.unit, this.unit));
    // Budget the light so an up-facing surface lands near its own albedo instead of well past it.
    // Hemisphere + environment + sun previously summed to roughly 2x on a horizontal plate, so every
    // mid tone clipped toward white and a whole floor read as paper however its colours were authored.
    // Image-based lighting is here for specular life on surfaces, not to flood the scene with fill:
    // pushed up it washes the model to paper-white and flattens the very shading it is meant to add.
    // Keep it low, keep the sun strong, and the model gains depth instead of losing it.
    this.scene.environment = this.environmentMap(evening);
    this.scene.environmentRotation.set(Math.PI / 2, 0, 0);
    this.scene.environmentIntensity = evening ? 0.38 : 0.55;
    const sky = new THREE.HemisphereLight(
      evening ? '#819bc5' : '#c7ddf5',
      evening ? '#393345' : '#b9ac94',
      evening ? 0.32 : 0.38,
    );
    sky.position.set(0, 0, 1);
    this.scene.add(sky);
    const sun = sunlight(evening);
    const light = new THREE.DirectionalLight(sun.color, sun.intensity);
    light.position.set(...sun.position);
    // A dim, cool fill from the opposite quarter. Real interiors and streets bounce light back into
    // the shadow side; without it every unlit façade collapses to the same dead tone.
    const fill = new THREE.DirectionalLight(evening ? '#7f90bd' : '#cfe0f2', evening ? 0.16 : 0.18);
    fill.position.set(evening ? -80 : 85, evening ? 60 : 55, 45);
    this.scene.add(fill);
    light.castShadow = true;
    light.shadow.mapSize.set(2048, 2048);
    light.shadow.bias = -0.00015;
    light.shadow.normalBias = 0.025;
    // The frustum is fitted to the finished model below; this is only a safe starting box.
    Object.assign(light.shadow.camera, { left: -140, right: 140, top: 140, bottom: -140, near: 1, far: 500 });
    this.scene.add(light);
    this.scene.add(light.target);
    this.sun = light;
    // A level is below grade if its own floor sits under 0 — used to keep buried levels out of the
    // above-ground views (see the visibility rules below).
    const belowGrade = (fid: string | null) => !!fid && (floors.get(fid)?.elevation ?? 0) < 0;
    // Is there anything under the level in focus, in its own building? Only then does its plate have
    // to be see-through — on a ground floor or a single-storey site it stays solid.
    const levelsBelowActive =
      !!activeF && view.levels.some(f => f.buildingId === activeF.buildingId && f.elevation < activeF.elevation);
    // Ghosts do not sort, so each layer multiplies into the next: the strength that lets a house's
    // two storeys read through one another turns a tower into a solid block. Share one budget out.
    this.ghostAlpha = Math.max(0.17, Math.min(0.38, 1 / Math.max(1, view.levels.length)));
    // An entresol is a partial level — a gallery ringing a void — so on its own it is a thin loop
    // floating over nothing. The storey it overlooks is what gives it something to be above, and in
    // 2D the plan has always drawn that; 3D showed the loop alone. Carry the level below with it.
    const under =
      activeF?.mezzanine && !stack
        ? project.floors
            .filter(f => f.buildingId === activeF.buildingId && f.elevation < activeF.elevation)
            .sort((a, b) => b.elevation - a.elevation)[0]
        : undefined;
    /** Height of a floor relative to the one in focus — 0 for the active level, negative below it. */
    const relative = (fid: string | null) =>
      fid ? this.rebase + ((floors.get(fid)?.elevation ?? activeF?.elevation ?? 0) - (activeF?.elevation ?? 0)) : 0;
    const visibleObjects = stack
      ? project.objects
      : [
          ...(index.objects.get(null) ?? []),
          ...(under ? (index.objects.get(under.id) ?? []) : []),
          ...(floorId ? (index.objects.get(floorId) ?? []) : []),
          // A stair that climbs to this level belongs on it, even though it is filed under the one
          // it starts from. Without this the flight you are standing at the top of is not drawn.
          ...(floorId ? (index.reaching.get(floorId) ?? []) : []),
        ];
    for (const o of visibleObjects) {
      if (buried && (o.floorId === null || (activeF && floors.get(o.floorId)?.buildingId !== activeF.buildingId)))
        continue;
      // The mirror of the rule above: standing above ground you cannot see through the earth, so
      // below-grade levels stay hidden until you go down to one. The excavation is only dug when
      // you are buried, so without this a basement — and especially a garage that sprawls past the
      // tower — hangs over the surrounding streets with no ground around it.
      // A shaft is the exception: it is filed under the lowest level it serves, which for a lift
      // running from a garage is below grade, and skipping it there would hide the whole shaft from
      // every storey above. It stands where it reaches, so it is judged by the level in focus.
      if (!buried && belowGrade(o.floorId) && !(isVertical(o.kind) && reaches(project, o, floorId))) continue;
      // A twin of a shaft already drawn from its lowest level. One lift, one shaft.
      if (isVertical(o.kind) && !index.primary.has(o.id)) continue;
      if (o.floorId && outlineOnly.has(o.floorId)) continue;
      if (o.floorId && shellBelow.has(o.floorId)) continue;
      if (structureOverview && o.floorId !== floorId && o.kind !== 'zone') continue;
      const z = stack ? (floors.get(o.floorId ?? '')?.elevation ?? 0) : relative(o.floorId);
      const indoorFinish = o.floorId !== null && (o.kind === 'room' || o.kind === 'zone');
      // Stacked view reads as a doll's house: every storey but the selected one turns translucent,
      // and the active level keeps its authored colours at full strength inside the glassy stack.
      //
      // Storeys below used to stay solid, which sounds right and is not: a solid plate hides the one
      // beneath it, so a seventeen-level building rendered as a single shelf in a closed brick box
      // and "All floors" showed exactly one. Whatever is below has to be see-through as well, or
      // there is nothing to see through to.
      const activeLevel = floorId !== null && o.floorId === floorId;
      const ghosted = !!(stack && floorId !== null && o.floorId && o.floorId !== floorId);
      // Looking down a stack, the active storey's plate is a lid over everything beneath it: pick the
      // top floor and the ones below vanish, however faithfully they are drawn. Only its own plate
      // has to give — its walls stay solid, so the level still reads as the one in focus.
      const lidsOverBelow = stack && activeLevel && levelsBelowActive;
      const color =
        this.mapStyle.objectColor?.(o) ??
        (activeLevel
          ? (o.color ?? COLORS[o.kind] ?? '#e6e8e1')
          : indoorFinish && !o.material
            ? '#e5e4df'
            : (o.color ?? COLORS[o.kind] ?? '#e6e8e1'));
      if (o.kind === 'fixture' || o.kind === 'landscape') {
        if (ghosted) continue;
        const fixture = makeFixture(
          o,
          pt => this.xy(pt),
          z + (o.floorId ? LIFT + SLAB : GROUND),
          this.materials,
          evening,
        );
        if (stack && buried && z < 0) {
          const base = fixture.position.z,
            height = Math.max(o.height, 0.01);
          fixture.position.z = this.present(base);
          fixture.scale.z = (this.present(base + height) - this.present(base)) / height;
        }
        // Fold the fixture's boxes into the shared batch rather than adding a group of loose meshes:
        // each one was its own draw call and its own buffer upload, and a floor of parked cars or
        // desks runs to thousands of them.
        for (const leftover of this.batch.addObject(fixture, o.id)) this.scene.add(leftover);
        continue;
      }
      if (o.rings && o.slope) {
        // A sloped deck carries its own absolute elevations, so it ignores the floor's plate height.
        if (!ghosted) this.slopedSurface(o, o.slope, LIFT + SLAB, SLAB, color);
        continue;
      }
      if (o.rings) {
        if (o.kind === 'building' && floorId !== null) continue;
        const indoor = o.floorId !== null,
          elevated = ['office', 'container'].includes(o.kind);
        const base =
          z +
          (indoor
            ? (o.kind === 'room' ? LIFT + SLAB + 0.015 : LIFT) + nestingLift(objectArea(o))
            : o.kind === 'parcel'
              ? 0.02
              : GROUND);
        const height = elevated ? o.height : indoor ? (o.kind === 'room' ? ROOM : SLAB) : 0.04;
        this.surface(
          // A stairwell is a hole in the floor you are standing on, too. Added as holes in the
          // area's own rings so the plate keeps its shape and loses only the shaft.
          indoor && o.floorId ? this.withVoids(project, o.rings, o.floorId, index.primary) : o.rings,
          base,
          height,
          color,
          o.id,
          // The floor you are standing on used to be the one surface with no finish at all, which left
          // the largest expanse in the frame as flat untextured colour. Give it the same plaster as
          // the levels below — it is subtle enough not to compete with the plan, and without it a
          // whole storey reads as paper.
          ghosted ? undefined : (o.material ?? (indoorFinish ? 'plaster' : undefined)),
          ghosted,
          false,
          lidsOverBelow && indoorFinish ? this.materials.plate(color) : undefined,
        );
      } else if (['stairs', 'elevator', 'turnstile', 'door', 'gate', 'window'].includes(o.kind)) {
        if (!ghosted) this.opening(project, o, z);
      } else if (['office', 'container', 'storage'].includes(o.kind)) {
        this.surface(
          objectRings(o),
          z + wallBase(o.floorId),
          o.height,
          color,
          o.id,
          ghosted ? undefined : o.material,
          ghosted,
        );
      }
    }
    // One slab per shell storey — the ceiling you look down onto — unioned from its areas so a
    // wing or a bay is included and the interior divisions are not. One surface, one union, per
    // storey: the whole point of the shell is that it costs a fraction of the real floor.
    for (const fid of shellBelow) {
      const areas = (index.objects.get(fid) ?? []).filter(
        o => o.rings?.length && (o.kind === 'room' || o.kind === 'zone'),
      );
      if (!areas.length) continue;
      const polygons = areas.map(o => [closeRing(o.rings![0])] as Ring[]);
      let merged: Ring[][];
      try {
        merged = polygonClipping.union(polygons[0], ...polygons.slice(1)) as unknown as Ring[][];
        // Punch the stairwells. A shaft that carries on past this storey goes through its floor, and
        // a slab drawn over it is a lid on the flight below.
        const voids = shaftVoids(project, fid, index.primary);
        if (voids.length)
          merged = polygonClipping.difference(merged as never, ...voids.map(v => [v] as never)) as unknown as Ring[][];
      } catch {
        continue; // degenerate footprint: no slab is better than a wrong one
      }
      const z = floors.get(fid)?.elevation ?? 0;
      for (const pg of merged) this.surface(pg, z + LIFT + SLAB, SLAB, '#e5e4df', `shell:${fid}`, undefined, true);
    }
    // The level below brings its walls too, or its rooms read as floating colour.
    const allPieces = [...wallPieces(project, floorId, stack), ...(under ? wallPieces(project, under.id, false) : [])];
    for (const p of allPieces) {
      if (buried && (p.floorId === null || (activeF && floors.get(p.floorId)?.buildingId !== activeF.buildingId)))
        continue;
      if (!buried && belowGrade(p.floorId)) continue;
      if (p.floorId && outlineOnly.has(p.floorId)) continue;
      if (p.floorId && shellBelow.has(p.floorId) && !exterior.has(p.id)) continue;
      if (structureOverview && p.floorId !== floorId && !exterior.has(p.id)) continue;
      const finish = finishes.get(p.id)!;
      // Every wall but the active floor's turns translucent in the stacked view — including the
      // storeys *below*, which used to stay solid. "Cutaway" has to actually cut something away: with
      // eight solid storeys of brick under the selected floor, a seventeen-level building showed one
      // plate inside a closed box, and the mode that promises all floors delivered none of them.
      const wallGhost = !!(stack && floorId !== null && p.floorId && p.floorId !== floorId);
      this.surface(
        [p.ring],
        p.base + wallBase(p.floorId) + (stack ? 0 : relative(p.floorId)),
        p.height - p.base,
        finish.color,
        p.id,
        wallGhost ? undefined : finish.material,
        wallGhost,
        // Only where a wall actually starts at its floor. A piece that begins part-way up — the strip
        // over a door, say — has no junction to darken and would just get a dirty smear.
        p.base < 0.01,
      );
      // The inside of an outside wall is a room's wall, and rooms are plastered. A facade's stone or
      // brick is its OUTER face; wrapping it round the solid put masonry inside every room, so a
      // house read as a ruin with no interior finish anywhere. A thin skin on the inner face fixes
      // it for what it costs: one surface per exterior piece, only where the wall faces a floor.
      if (exterior.has(p.id) && !wallGhost && finish.material && finish.material !== 'plaster') {
        const lining = this.lining(project, p, floorId);
        if (lining)
          this.surface(
            [lining],
            p.base + wallBase(p.floorId) + (stack ? 0 : relative(p.floorId)),
            p.height - p.base,
            '#eceae5',
            p.id,
            'plaster',
            false,
            p.base < 0.01,
          );
      }
    }
    // Roofs cover their building in the site view and stacked view; cutaways expose the interior.
    if (!buried && (stack || floorId === null))
      for (const b of project.buildings)
        if (b.roof && (!stack || !activeF || b.id !== activeF.buildingId)) {
          const roof = makeRoof(b.roof, pt => this.xy(pt), b.id, this.materials);
          for (const leftover of this.batch.addObject(roof, b.id)) this.scene.add(leftover);
        }
    // Only the lower envelope is needed beneath a cutaway. Keep its authored façade and glazing;
    // interior partitions and duplicate ceiling plates were both hidden work and sources of seams.
    if (!stack && floorId) {
      const lower = new Map(
        project.floors
          .filter(
            fl => fl.buildingId === floors.get(floorId)?.buildingId && fl.elevation >= 0 && fl.elevation < this.rebase,
          )
          .map(fl => [fl.id, fl]),
      );
      this.envelope(project, lower, exterior, finishes);
    }
    // The site view has to show the site. Until now only *authored* roof geometry drew here, so a
    // building whose roof was never modelled — which is most of them — disappeared completely and the
    // parcel read as an empty lot. Build the massing from the floor stack instead: the same façade
    // envelope used beneath a cutaway, capped at each building's roofline.
    if (!stack && floorId === null && !buried) {
      const aboveGround = new Map(project.floors.filter(fl => fl.elevation >= 0).map(fl => [fl.id, fl]));
      this.envelope(project, aboveGround, exterior, finishes);
      for (const b of project.buildings) {
        if (b.roof) continue; // an authored roof is better than a flat cap; leave it to makeRoof
        const top = project.floors
          .filter(fl => fl.buildingId === b.id && fl.elevation >= 0)
          .sort((x, y) => x.elevation - y.elevation)
          .at(-1);
        const rings = top && index.outlines.get(top.id)?.rings;
        if (top && rings) this.surface(rings, top.elevation + top.height, SLAB, '#747976', b.id, 'roof');
      }
    }
    // Excavate around the whole below-grade complex (all deck plates plus any ramps reaching the
    // surface), not just the active floor's plate — otherwise a garage or driveway that extends past
    // the tower footprint hangs in open air with no soil around it.
    if (buried && excavation) {
      const outline = index.outlines.get(activeF?.id ?? view.levels[0]?.id ?? '');
      const excavation = excavationRings(project, view.levels);
      const rings = excavation.length ? excavation : outline?.rings?.[0] ? [openRing(outline.rings[0])] : [];
      const split = view.focusElevation;
      // In a single-floor view the cut runs a few metres below your level, which is what exposes the
      // soil profile; the stacked view already cuts to the bottom of the deepest level.
      const bottom = stack
        ? view.elevation(view.levels.reduce((z, f) => Math.min(z, f.elevation), 0)) - 2.5
        : split - 6;
      // Every below-grade slab leaves a stratum line on the cut face, so levels you are not standing
      // on still read in section.
      const strata = view.levels.filter(f => f.elevation < 0).map(f => view.elevation(f.elevation));
      for (const local of rings) {
        // A little breathing room avoids coplanar soil and exterior walls.
        const ring = local.map(pt => this.xy(pt));
        const cx = ring.reduce((n, p) => n + p[0], 0) / ring.length,
          cy = ring.reduce((n, p) => n + p[1], 0) / ring.length;
        this.scene.add(
          undergroundPit(
            ring.map<Point>(([x, y]) => [cx + (x - cx) * 1.025, cy + (y - cy) * 1.025]),
            split,
            bottom,
            strata,
          ),
        );
      }
    }
    if (buried && activeF && (!stack || structureOverview)) {
      const above = view.levels.filter(f => f.elevation > activeF.elevation).sort((a, b) => a.elevation - b.elevation);
      const stride = Math.max(1, Math.ceil((above.length - 1) / (MAX_CAGE_LEVELS - 1)));
      const samples = above.filter((_, i) => i % stride === 0 || i === above.length - 1);
      const rings: THREE.Vector3[][] = [];
      let columns: Point[] = [];
      for (const fl of samples) {
        const envelope = index.outlines.get(fl.id);
        if (!envelope) continue;
        const ring = openRing(envelope.rings![0]);
        rings.push(ring.map(pt => new THREE.Vector3(...this.xy(pt), view.elevation(fl.elevation) + LIFT)));
        if (!columns.length) {
          const step = Math.max(1, Math.ceil(ring.length / 16));
          columns = ring.filter((_, i) => i % step === 0).map(pt => this.xy(pt));
        }
      }
      const topFl = above.at(-1);
      this.cage.configure(
        rings,
        columns,
        view.focusElevation + LIFT,
        topFl ? view.elevation(topFl.elevation + topFl.height) : 0,
        evening,
      );
      this.cage.setBearing(this.map?.getBearing() ?? 0);
      this.scene.add(this.cage);
    }
    this.batch.finish(this.scene);
    if (!buried) {
      // Receive shadows on the actual map without replacing its roads, labels or ground colour.
      const bounds = new THREE.Box3().setFromObject(this.scene);
      if (!bounds.isEmpty()) {
        const size = bounds.getSize(new THREE.Vector3()),
          center = bounds.getCenter(new THREE.Vector3());
        const reach = Math.max(24, size.z * 4);
        const ground = new THREE.Mesh(
          new THREE.PlaneGeometry(size.x + reach * 2, size.y + reach * 2),
          new THREE.ShadowMaterial({
            color: evening ? '#282637' : '#3d4950',
            opacity: evening ? 0.38 : 0.26,
            depthWrite: false,
          }),
        );
        ground.position.set(center.x, center.y, 0.012);
        ground.receiveShadow = true;
        ground.raycast = () => {};
        this.scene.add(ground);
      }
    }
    this.fitShadowCamera();
    this.scene.add(this.highlight);
    this.refreshHighlight();
    this.pickables = [];
    this.scene.traverse(object => {
      if (!(object instanceof THREE.Mesh)) return;
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      if (!materials.some(m => m.visible && (!m.transparent || m.depthWrite))) return;
      if (object.userData.entityId || object.userData.spans) this.pickables.push(object);
    });
    this.buildRoute(); // disposeScene swept the previous route group's resources with the scene
    if (this.renderer) this.renderer.shadowMap.needsUpdate = true;
    this.map?.triggerRepaint();
  }
  /** Show/replace the 3D route. When only the active step changed, restyle materials in place;
   * otherwise rebuild the route group. Route state is retained across update() rebuilds — every
   * rebuild re-runs buildRoute with FRESH materials, because disposeScene disposes all mesh
   * materials and a cached material would die silently on the next floor switch. */
  setRoute(route: Route | null, activeStep: number | null = null) {
    if (route === this.route && activeStep === this.routeStep && (this.routeGroup !== null || !route)) return;
    const restyleOnly = route !== null && route === this.route && this.routeGroup !== null;
    this.route = route;
    this.routeStep = activeStep;
    if (restyleOnly) this.restyleRoute();
    else this.buildRoute();
    this.map?.triggerRepaint();
  }
  private routeStyle(step: number) {
    const active = step === this.routeStep;
    return {
      color: active ? (this.mapStyle.routeActive ?? '#6259e8') : (this.mapStyle.route ?? '#8d85dc'),
      opacity: active ? 0.95 : 0.38,
    };
  }
  private restyleRoute() {
    this.routeGroup?.traverse(o => {
      if (o instanceof THREE.Mesh) {
        const { color, opacity } = this.routeStyle(o.userData.step as number);
        const m = o.material as THREE.MeshBasicMaterial;
        m.color.set(color);
        m.opacity = opacity;
      }
    });
  }
  private buildRoute() {
    this.clipBoundsDirty = true;
    if (this.routeGroup) {
      this.routeGroup.removeFromParent();
      this.routeGroup.traverse(o => {
        if (o instanceof THREE.Mesh) {
          o.geometry.dispose();
          (o.material as THREE.Material).dispose();
        }
      });
      this.routeGroup = null;
    }
    const route = this.route,
      project = this.project;
    if (!route || !project) return;
    const floors = floorIndex(project).floors,
      activeF = floors.get(this.activeFloor ?? '');
    // Same visibility predicates as the plates: buried hides outdoor legs and other buildings;
    // the cutaway shows only the active floor (+ outdoor); the stack shows every floor.
    const visible = (fid: string | null) => {
      if (!this.buried && fid && (floors.get(fid)?.elevation ?? 0) < 0) return false;
      if (this.buried && (fid === null || (activeF && floors.get(fid ?? '')?.buildingId !== activeF.buildingId)))
        return false;
      if (!this.stack && fid !== null && fid !== this.activeFloor) return false;
      return true;
    };
    const zOf = (fid: string | null) =>
      fid === null
        ? GROUND + 0.05
        : this.present((this.stack ? (floors.get(fid)?.elevation ?? 0) : this.rebase) + LIFT + SLAB + ROOM + 0.07);
    const group = new THREE.Group();
    const steps = legStepIndices(route);
    const mesh = (geometry: THREE.BufferGeometry, step: number) => {
      const { color, opacity } = this.routeStyle(step);
      const m = new THREE.Mesh(
        geometry,
        new THREE.MeshBasicMaterial({ color, opacity, transparent: true, depthWrite: false, side: THREE.DoubleSide }),
      );
      m.renderOrder = 10;
      m.raycast = () => {};
      m.userData.step = step;
      group.add(m);
    };
    let run: { step: number; fid: string | null; points: Point[] } | null = null;
    const flush = () => {
      if (run && run.points.length > 1 && visible(run.fid)) {
        const g = this.ribbonGeometry(run.points, zOf(run.fid), 0.22);
        if (g) mesh(g, run.step);
      }
      run = null;
    };
    for (let i = 0; i < route.legs.length; i++) {
      const leg = route.legs[i],
        step = steps[i];
      if (leg.edge.kind === 'stairs' || leg.edge.kind === 'elevator') {
        flush();
        const [x, y] = this.xy(leg.from.position);
        if (this.stack) {
          // subtle shaft connector between the presented floor elevations
          if (!visible(leg.from.floorId) && !visible(leg.to.floorId)) continue;
          const z1 = zOf(leg.from.floorId),
            z2 = zOf(leg.to.floorId);
          const g = new THREE.CylinderGeometry(0.14, 0.14, Math.abs(z2 - z1) || 0.1, 10);
          g.rotateX(Math.PI / 2);
          g.translate(x, y, (z1 + z2) / 2);
          mesh(g, step);
        } else if (leg.from.floorId === this.activeFloor || leg.to.floorId === this.activeFloor) {
          // shaft marker disc on the visible floor
          const g = new THREE.CylinderGeometry(0.5, 0.5, 0.05, 24);
          g.rotateX(Math.PI / 2);
          g.translate(x, y, zOf(this.activeFloor) + 0.02);
          mesh(g, step);
        }
        continue;
      }
      const fid = leg.from.floorId === leg.to.floorId ? leg.from.floorId : (leg.from.floorId ?? leg.to.floorId);
      if (!run || run.step !== step || run.fid !== fid) {
        flush();
        run = { step, fid, points: [leg.from.position] };
      }
      run.points.push(leg.to.position);
    }
    flush();
    if (!group.children.length) return;
    this.routeGroup = group;
    this.scene.add(group); // raycast is a no-op and userData carries no entityId, so pickables ignore the ribbon
  }
  /** Flat mitred triangle-strip ribbon at a constant z, in scene metres. */
  private ribbonGeometry(points: Point[], z: number, half: number): THREE.BufferGeometry | null {
    const pts: Point[] = [];
    for (const p of points) {
      const q = this.xy(p);
      if (!pts.length || Math.hypot(q[0] - pts[pts.length - 1][0], q[1] - pts[pts.length - 1][1]) > 0.01) pts.push(q);
    }
    if (pts.length < 2) return null;
    const positions: number[] = [],
      indices: number[] = [];
    for (let i = 0; i < pts.length; i++) {
      const prev = pts[Math.max(0, i - 1)],
        next = pts[Math.min(pts.length - 1, i + 1)];
      const dx = next[0] - prev[0],
        dy = next[1] - prev[1],
        len = Math.hypot(dx, dy) || 1;
      let nx = -dy / len,
        ny = dx / len,
        w = half;
      if (i > 0 && i < pts.length - 1) {
        const d1x = pts[i][0] - pts[i - 1][0],
          d1y = pts[i][1] - pts[i - 1][1],
          l1 = Math.hypot(d1x, d1y) || 1;
        const d2x = pts[i + 1][0] - pts[i][0],
          d2y = pts[i + 1][1] - pts[i][1],
          l2 = Math.hypot(d2x, d2y) || 1;
        const mx = -(d1y / l1 + d2y / l2),
          my = d1x / l1 + d2x / l2,
          ml = Math.hypot(mx, my);
        if (ml > 0.001) {
          nx = mx / ml;
          ny = my / ml;
          const dot = nx * (-d1y / l1) + ny * (d1x / l1);
          w = half / Math.max(0.4, Math.abs(dot));
        }
      }
      positions.push(pts[i][0] + nx * w, pts[i][1] + ny * w, z, pts[i][0] - nx * w, pts[i][1] - ny * w, z);
      if (i) {
        const b = i * 2;
        indices.push(b - 2, b - 1, b, b - 1, b + 1, b);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    g.setIndex(indices);
    return g;
  }
  // Grows the building out of the map when entering 3D so the mode switch reads as one motion.
  animateIn() {
    this.growth = 0;
    this.growthStart = performance.now();
    this.map?.triggerRepaint();
  }
  private refreshHighlight() {
    for (const child of [...this.highlight.children]) {
      const line = child as THREE.LineSegments;
      line.geometry.dispose();
      (line.material as THREE.Material).dispose();
    }
    this.highlight.clear();
    for (const [id, color] of [
      [this.hovered, this.mapStyle.hover ?? '#8d85dc'],
      [this.selected, this.mapStyle.selection ?? '#6355d4'],
    ] as const)
      if (id) {
        const line = this.batch.outline(id, color);
        if (line) this.highlight.add(line);
      }
    this.map?.triggerRepaint();
  }
  setHover(id: string | null) {
    if (id === this.hovered) return;
    this.hovered = id;
    this.refreshHighlight();
  }
  get diagnostics() {
    return {
      revision: this.revision,
      drawCalls: this.renderer?.info.render.calls ?? 0,
      geometries: this.renderer?.info.memory.geometries ?? 0,
      textures: this.renderer?.info.memory.textures ?? 0,
    };
  }
  render(_gl: WebGLRenderingContext | WebGL2RenderingContext, args: CustomRenderMethodInput) {
    if (!this.renderer) return;
    const now = performance.now();
    // Capped so a backgrounded tab does not resume by teleporting every car a hundred metres.
    const elapsed = Math.min(0.1, this.lastFrame ? (now - this.lastFrame) / 1000 : 0);
    this.lastFrame = now;
    if (this.rigs.length && this.animate(elapsed)) {
      if (this.shadowsMoved) this.renderer.shadowMap.needsUpdate = true;
      this.map?.triggerRepaint();
    }
    if (this.growth < 1) {
      this.growth = Math.min(1, (performance.now() - this.growthStart) / 550);
      this.scene.scale.z = 0.03 + 0.97 * (1 - (1 - this.growth) ** 3);
      this.renderer.shadowMap.needsUpdate = true;
      this.map?.triggerRepaint();
    } else this.scene.scale.z = 1;
    // defaultProjectionData.mainMatrix passes through a Float32 projection path; at city zoom its
    // rounding is metres, which made the whole scene drift off the basemap at some camera poses.
    // The transform's mercatorMatrix is the same mercator→clip matrix at full float64 precision.
    const precise = (this.map as unknown as { transform?: { mercatorMatrix?: ArrayLike<number> } })?.transform
      ?.mercatorMatrix;
    this.worldToClip
      .fromArray((precise?.length === 16 ? precise : args.defaultProjectionData.mainMatrix) as number[])
      .multiply(this.transform);
    if (this.buried) {
      if (this.clipBoundsDirty) {
        this.scene.updateMatrixWorld(true);
        // Cache in scene metres, removing the current entrance-animation scale. Cage bounds
        // cover every bearing, so neither panning nor rotation needs another geometry scan.
        this.clipBounds
          .setFromObject(this.scene)
          .applyMatrix4(new THREE.Matrix4().copy(this.scene.matrixWorld).invert());
        this.clipBoundsDirty = false;
      }
      // MapLibre fits its far plane to the ground; a basement can cross that plane and lose
      // a straight slice of its floor as the camera pans. Fit the custom scene independently.
      includeSceneDepth(this.worldToClip, this.clipBounds, this.scene.scale.z, args.nearZ, args.farZ);
    }
    this.clipToWorld.copy(this.worldToClip).invert();
    syncLightingCamera(this.camera, this.worldToClip, this.clipToWorld);
    // Three caches the viewport from the canvas size at construction; after the map container
    // resizes (inspector opening, fullscreen) it would keep drawing into the old rectangle,
    // shearing the scene off the basemap. Re-sync to the shared canvas every frame (pixelRatio 1).
    const canvas = this.map?.getCanvas();
    if (canvas) this.renderer.setViewport(0, 0, canvas.width, canvas.height);
    const size = canvas ? `${canvas.clientWidth}:${canvas.clientHeight}` : '';
    if (
      !this.previousProjection.equals(this.worldToClip) ||
      this.previousScale !== this.scene.scale.z ||
      this.previousSize !== size
    ) {
      this.markerCache.clear();
      this.previousProjection.copy(this.worldToClip);
      this.previousScale = this.scene.scale.z;
      this.previousSize = size;
    }
    this.cage.setBearing(this.map?.getBearing() ?? 0);
    this.renderer.resetState();
    if (this.buried) {
      // Underground inspection composites over the map. Keep its colour, but discard the
      // ground/vector depth left in our shared context; scene objects still occlude each other.
      this.renderer.state.buffers.depth.setMask(true);
      this.renderer.state.buffers.depth.setClear(1);
      this.renderer.clearDepth();
    }
    this.renderer.render(this.scene, this.camera);
    this.renderer.resetState();
  }
  projectObject(o: SiteObject): { x: number; y: number; visible: boolean } | null {
    if (!this.project || !this.map) return null;
    const cached = this.markerCache.get(o.id);
    if (cached) return cached;
    const xy = this.xy(objectPosition(this.project, o));
    const z =
      (this.stack
        ? (floorIndex(this.project).floors.get(o.floorId ?? '')?.elevation ?? 0)
        : o.floorId
          ? this.rebase
          : 0) +
      wallBase(o.floorId) +
      (o.kind === 'camera' ? o.height : 0.5);
    const target = new THREE.Vector3(...xy, this.present(z) * this.scene.scale.z);
    const p = target.clone().applyMatrix4(this.worldToClip);
    let visible =
      Math.abs(p.x) <= 1.05 &&
      Math.abs(p.y) <= 1.05 &&
      p.z < 1 &&
      p.z > -1 &&
      (!this.buried || o.floorId !== null) &&
      (!this.stack || o.floorId === null || o.floorId === this.activeFloor);
    if (visible && this.stack) {
      // Occlusion is by far the most expensive thing per marker — a ray against every pickable mesh.
      // While the camera is in motion, reuse the last verdict: markers shift by a few pixels a frame
      // and re-deriving this for hundreds of them was costing more than the rest of the frame put
      // together. It refreshes as soon as the camera stops.
      const settled = !this.map.isMoving();
      const cachedOcclusion = this.occlusionCache.get(o.id);
      if (!settled && cachedOcclusion !== undefined) visible = cachedOcclusion;
      else {
        const near = new THREE.Vector3(p.x, p.y, -1).applyMatrix4(this.clipToWorld);
        const length = near.distanceTo(target);
        const clearance = (this.present(z) - this.present(z - 0.25)) * this.scene.scale.z;
        const ray = new THREE.Raycaster(near, target.clone().sub(near).normalize(), 0, Math.max(0, length - clearance));
        visible = !ray
          .intersectObjects(this.pickables, false)
          .some(hit => hit.object instanceof THREE.Mesh && hitEntity(hit) !== o.id);
        this.occlusionCache.set(o.id, visible);
      }
    }
    const result = {
      x: ((p.x + 1) / 2) * this.map.getCanvas().clientWidth,
      y: ((1 - p.y) / 2) * this.map.getCanvas().clientHeight,
      visible,
    };
    this.markerCache.set(o.id, result);
    return result;
  }
  pick(point: { x: number; y: number }): string | null {
    if (!this.map) return null;
    const x = (point.x / this.map.getCanvas().clientWidth) * 2 - 1,
      y = 1 - (point.y / this.map.getCanvas().clientHeight) * 2;
    const near = new THREE.Vector3(x, y, -1).applyMatrix4(this.clipToWorld),
      far = new THREE.Vector3(x, y, 1).applyMatrix4(this.clipToWorld);
    const raycaster = new THREE.Raycaster(near, far.sub(near).normalize());
    return raycaster.intersectObjects(this.pickables, false).map(hitEntity).find(Boolean) ?? null;
  }
  private disposeScene() {
    this.cage.dispose();
    this.markerCache.clear();
    this.occlusionCache.clear();
    this.pickables = [];
    this.clipBoundsDirty = true;
    const geometries = new Set<THREE.BufferGeometry>(),
      materials = new Set<THREE.Material>();
    this.scene.traverse(o => {
      if (o instanceof THREE.Mesh || o instanceof THREE.LineSegments) {
        geometries.add(o.geometry);
        (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => {
          if (!m.userData.shared) materials.add(m);
        });
        // InstancedMesh (roof tiles) also holds instanceMatrix/instanceColor GPU buffers that only
        // its own dispose() frees — geometry/material disposal leaves them orphaned on each rebuild.
        if (o instanceof THREE.InstancedMesh) o.dispose();
      }
      if (o instanceof THREE.Light && 'shadow' in o) (o as THREE.DirectionalLight).shadow?.dispose();
    });
    geometries.forEach(g => g.dispose());
    materials.forEach(m => m.dispose());
    this.scene.clear();
    this.highlight.clear();
    this.batch.clear();
    this.routeGroup = null;
  }
  onRemove() {
    this.disposeScene();
    this.materials.dispose();
    this.envCache.forEach(target => target.dispose());
    this.envCache.clear();
    // dispose() frees Three's programs/listeners; it does not lose the shared context. Never call
    // forceContextLoss(). Reset the GL bindings before handing the context back to MapLibre.
    this.renderer?.resetState();
    this.renderer?.dispose();
    this.renderer = undefined;
  }
}
