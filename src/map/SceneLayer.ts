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
import { legStepIndices, ROUTE_COLOR, routeTrackImage, TRACK_PIXELS, TRACK_TILE } from './route';
import {
  barrierEnds,
  closeRing,
  objectArea,
  objectPosition,
  objectRotation,
  openRing,
  rectangle,
  ringArea,
  rotate,
  toLngLat,
} from '../model/geometry';
import { distance, pointInRing } from '../model/geometry';
import { floorOutline } from '../model/walls';
import { COLORS, objectRings, type WallPiece, wallPieces } from './features';
import {
  type Flight,
  flightRun,
  type FlightRun,
  flights,
  flightsAt,
  isVertical,
  reaches,
  servedFloors,
  shaftVoids,
  type VoidOptions,
  type StairModel,
  stairModel,
  treads,
} from '../model/vertical';
import type { StatusReading } from '../model/live';
import { makeFixture, makeRoof } from './architecture';
import { MaterialLibrary } from './materials';
import { EXTERIOR_PRESETS } from '../model/materials';
import type { MapStyleOptions } from '../theme';
import { exteriorWalls } from './exteriors';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { hitEntity, metricUVs, OUTSIDE, SurfaceBatch } from './surfaces';
import { excavationRings, floorIndex, MAX_CAGE_LEVELS, type UndergroundView, undergroundView } from './underground';
import { UndergroundCage, undergroundPit } from './UndergroundContext';
import { includeSceneDepth } from './projection';
import { syncLightingCamera } from './projection';
import type { SurfaceFinish } from './textures';
import { ambient, FIXED, type Sun, sunlight } from './lighting';
import { FixtureLights } from './FixtureLights';
import { EYE } from './walk';
import { tallSpaceContext } from './walkSurfaces';
import { applyPoolCaustics, makePool, makeWaterSlide } from './water';

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
// Re-exported: they are declared in levels.ts so the flat plan can read them without three.js.
export { LIFT, SLAB } from './levels';
import { LIFT, SLAB } from './levels';
const ROOM = 0.05,
  GROUND = 0.06;
/** Head clearance over the eye. A ceiling you can see the top of is not a ceiling. */
const HEAD_CLEAR = 0.35;
/** How much of the storey in focus everything stacked above it must leave, and how much the storeys
 *  under it leave of one another. The per-storey ghost strength is solved from these and the level
 *  count — see ghostAlpha. Below is the harder read (it comes through the focus's own plate as well)
 *  and so is allowed to be the stronger layer. */
const FOCUS_SEEN = 0.62,
  UNDER_SEEN = 0.3;
/** The envelope and the partitions of the storeys not in focus: the things a stack is looked THROUGH
 *  rather than at. Flat, and not a share of the plates' strength, because the case has a job of its
 *  own — saying where the building is and how it is banded — that does not get easier or harder with
 *  the level count. A plate is one layer between the eye and what is under it; the façade is a solid
 *  band at every one of seventeen storeys, two faces deep, covering the whole plan, and at the
 *  plates' strength it closed the building into a brick box. Glass, not masonry. */
const CASE_ALPHA = 0.055;
/** And the floor under a shaft's ghosted upper run — see lift(). */
const SHAFT_GHOST = 0.17;

/** How far an absolutely-placed piece of geometry has to move to join the rest of the scene.
 *
 *  Geometry arrives in two coordinate systems. Most of it is placed relative to the level in focus,
 *  which is what lets a cutaway sit on the map and a walk stand on the map's own ground plane. The
 *  rest carries the elevation the document authored: a ramp's slope, the parcel and the fences out
 *  of doors, the excavation and its cage. Nothing reconciled the two, so walking a P1 deck put the
 *  ramps 12.6 m under the walker and left the pavement level with a fifth-floor shop. This is the
 *  one number that carries an authored elevation into the frame everything else is drawn in. The
 *  stacked view is already drawn at authored elevations, so there it is nothing. */
export const sceneGround = (stack: boolean, rebase: number, activeElevation: number) =>
  stack ? 0 : rebase - activeElevation;

/** Where an authored elevation ends up on screen, once the view's depth mapping has had its say.
 *
 *  `undergroundView` compresses a shaft deeper than 96 m so a 400 m one can be looked at, and its
 *  header asks every consumer to share that one transform. They did not: the stack compressed its
 *  geometry vertex by vertex while a single-floor cutaway rebased to the compressed depth and then
 *  added raw deltas to it, which put a level 140 m under the one in focus 44 m into the sky. This is
 *  the mapping the plate, the flights climbing through it, the excavation's strata and the cage all
 *  go through. A walk is the one view it has nothing to say to: inside one storey there is no depth
 *  to compress, and the storey has been moved onto the map's ground plane anyway. */
export const sceneElevation = (view: UndergroundView, walk: boolean, z: number) =>
  walk ? z - (view.active?.elevation ?? 0) : view.elevation(z);

/** The underside of a walked storey's ceiling, above the storey's own datum.
 *
 *  It is the next slab's underside, not the storey height less a slab: fixtures are authored against
 *  the storey — the garage's 3.1 m luminaires, its 4.2 m pillars — and a lid a third of a metre low
 *  had them poking through it. And a storey the document drew too low for a person to stand in must
 *  still get a ceiling above the eye rather than one you look down onto: the 1.6 m entresol put its
 *  glowing plane at 1.42 m, a good half metre under the walker's eye. */
export const walkSoffit = (rebase: number, height: number) =>
  Math.max(rebase + height + LIFT, rebase + LIFT + SLAB + EYE + HEAD_CLEAR);

/** A mezzanine shares the surrounding hall's roof. Its own partial footprint cannot close the
 *  space seen beyond the gallery edge. Other floors keep their own ceiling. */
export function walkCeiling(project: ProjectDocument, floorId: string): { floor: Floor; soffit: number } | undefined {
  const active = project.floors.find(f => f.id === floorId);
  if (!active) return;
  const host = active.mezzanine
    ? project.floors
        .filter(
          f =>
            !f.mezzanine &&
            f.buildingId === active.buildingId &&
            f.elevation < active.elevation &&
            f.elevation + f.height > active.elevation,
        )
        .sort((a, b) => b.elevation - a.elevation)[0]
    : undefined;
  const floor = host ?? active;
  return { floor, soffit: walkSoffit(0, floor.elevation + floor.height - active.elevation) };
}

/** Coordinates a clipper can close a ring with. Two plates drawn to the same edge arrive here
 *  differing in the fifteenth decimal, and polygon-clipping answers that by losing the ring. */
const snapRing = (ring: Ring): Ring =>
  ring.map(p => [Math.round(p[0] * 1e4) / 1e4, Math.round(p[1] * 1e4) / 1e4] as Point);

/** The single plate a storey is drawn as when it is drawn as a shell — the ceiling you look down
 *  onto from the storey above — with the stairwells punched through it.
 *
 *  Only the storey's top-level areas go in. A parking deck is one plate carrying four hundred bays
 *  drawn on it as zones; unioning every one of them is the input polygon-clipping's sweep line gives
 *  up on, and the caller's catch then left the deck with no slab at all. The bays are inside the
 *  plate anyway, so they say nothing about where the storey reaches. Ramps do — they run out past
 *  the building to the street — so they are unioned in.
 *
 *  A storey drawn as rooms rather than as a zone has no single plate, and `floorOutline` already
 *  knows how to make one: rooms plus the walls between them, snapped and cached. */
export function shellPlate(
  project: ProjectDocument,
  floorId: string,
  primary?: Set<string>,
  voidOptions?: VoidOptions,
): Ring[][] {
  const index = floorIndex(project);
  const own = index.objects.get(floorId) ?? [];
  const zones = own.filter(o => o.kind === 'zone' && !o.parentId && o.rings?.length);
  // A zone keeps all its rings: the -1A gallery is a loop around the atrium, and dropping its hole
  // would floor the void it exists to ring.
  const plates: Ring[][] = zones.length
    ? zones.map(o => o.rings!.map(r => snapRing(closeRing(r))))
    : floorOutline(project, floorId).map(r => [snapRing(closeRing(r))]);
  const ramps: Ring[][] = own.filter(o => o.slope && o.rings?.length).map(o => [snapRing(closeRing(o.rings![0]))]);
  const input = [...plates, ...ramps];
  if (!input.length) return [];
  try {
    let merged = polygonClipping.union(input[0], ...input.slice(1)) as unknown as Ring[][];
    // A shaft that carries on past this storey goes through its floor, and a slab drawn over it is
    // a lid on the flight below.
    const voids = shaftVoids(project, floorId, primary, voidOptions);
    if (voids.length)
      merged = polygonClipping.difference(
        merged as never,
        ...voids.map(v => [snapRing(v)] as never),
      ) as unknown as Ring[][];
    return merged;
  } catch {
    // Snapping is not a guarantee, and a storey with no slab reads as a storey that is not there.
    // Its largest area and its ramps are the shape a shell is for: where the storey is, how far it
    // reaches, and nothing inside it.
    const largest = index.outlines.get(floorId)?.rings;
    return [...(largest ? [largest.map(r => closeRing(r))] : []), ...ramps];
  }
}
/** Milliseconds between frames of a permanent animation — 24 fps, a step band's own rate. */
const LOOP_FRAME = 42;
/** The one rig id the route owns, so a rebuild can drop its own and leave every other alone. */
const ROUTE_RIG = 'route:track';
const wallBase = (floorId: string | null) => (floorId ? LIFT + SLAB : GROUND);

/** Do two rings come near enough each other to be worth clipping? Bounding boxes, which is coarse on
 *  purpose: a box that overlaps where the shapes do not costs one clip that gives the area back
 *  unchanged. What it replaces — a corner-in-ring test each way — was enough while every void was a
 *  shaft landing inside one area, and wrong for a ramp, which is a forty-metre strip crossing the
 *  aisles at right angles with no corner of anything inside anything. Those aisles kept their whole
 *  plate and bridged the trench cut under them. */
const boxesMeet = (a: Ring, b: Ring) => {
  const span = (ring: Ring, axis: 0 | 1) => {
    let lo = Infinity,
      hi = -Infinity;
    for (const p of ring) {
      if (p[axis] < lo) lo = p[axis];
      if (p[axis] > hi) hi = p[axis];
    }
    return [lo, hi];
  };
  for (const axis of [0, 1] as const) {
    const [alo, ahi] = span(a, axis),
      [blo, bhi] = span(b, axis);
    if (ahi < blo || bhi < alo) return false;
  }
  return true;
};

/** Does this ramp join the level at `elevation`? A sloped zone spans two decks and is filed on one of
 *  them, so the other has to claim it or the deck a car arrives at draws no way onto it. Its ends are
 *  what it joins — not every storey the incline passes through on the way. */
export const rampJoins = (o: SiteObject, elevation: number) =>
  !!o.slope && [o.slope.low, o.slope.high].some(end => Math.abs(end - elevation) < 0.01);

/** The plan hole a deck's own driveway needs: the ramp that sets off from this level, and so is under
 *  this level's plate from the moment it starts falling.
 *
 *  Only that one. A ramp arriving from the deck above lies OVER this plate and wants no hole — cut
 *  one and the storey gets a forty-metre trench with nothing under it — and a driveway that merely
 *  passes this elevation a hundred metres away beneath the street has nothing to do with this floor,
 *  which is how a slot for the Mannerheimintie ramp came to be cut through the shop. */
export const rampVoids = (project: ProjectDocument, floorId: string): Ring[] => {
  const level = project.floors.find(f => f.id === floorId);
  if (!level) return [];
  return project.objects
    .filter(o => o.floorId === floorId && o.slope && o.rings?.length && Math.abs(o.slope.high - level.elevation) < 0.01)
    .map(o => closeRing(o.rings![0]));
};

/** An escalator step: 0.4 m of going and a 0.2 m face, the world over. These are properties of the
 *  machine rather than of the drawing — a manufacturer's step is the same step in every building —
 *  so they are fixed here while the pitch, which the plan really does decide, is not. */
const STEP_GOING = 0.4,
  STEP_RISE = 0.2;

/** How far a landing plate stands over the floor it belongs to. A comb plate drawn at its true
 *  thickness stood a fifth of a metre proud of both storeys, so you stepped up onto a block at the
 *  foot of every escalator and down off one at its head; drawn exactly flush it fights the plate for
 *  the same pixels. A threshold's worth is neither. */
const PLATE_LIP = 0.02;

/** The steps of one escalator flight, bottom first.
 *
 *  `at` is how far up the run a step stands, measured in plan metres from the foot of the incline;
 *  `base` is how far above the foot its underside sits. The going is 0.4 m stretched to fill the
 *  incline exactly, so the band leaves no sliver at the foot, and the riser is whatever the rise
 *  divided by the count comes to — a flight the plan has drawn too short shows as the steep stair it
 *  is instead of as a smooth ramp that hides the fact. */
function escalatorSteps(rise: number, incline: number): { at: number; base: number; going: number; face: number }[] {
  // Capped: a very long flight is read at a glance, not counted, and every step is a draw call's
  // worth of geometry in a scene that may hold a bank of them on seventeen storeys.
  const count = Math.max(2, Math.min(40, Math.round(incline / STEP_GOING)));
  const going = incline / count;
  // An escalator's risers are closed — a cleated face runs from one tread down to the next — so the
  // face has to be at least as deep as the pitch it is set at. Drawn at the machine's own 0.2 m on
  // an incline steeper than the machine's own, the band opened into a gap under every nose and read
  // as an outdoor fire stair.
  const face = Math.max(STEP_RISE, rise / count);
  return Array.from({ length: count }, (_, i) => ({
    at: going * (i + 0.5),
    // The band hangs a riser below the slope line: the foot step's top is level with the lower comb
    // plate, which is where a step really does emerge, and the head of the run stops a riser short
    // of the upper one. That last riser is where the band's travel goes — a cycle puts every step
    // where its neighbour was, so the step that climbs past the last visible one has to finish
    // inside the head housing rather than above a landing that is now flush with the floor.
    base: (rise * i) / count - face,
    going,
    face,
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
  private camera = (() => {
    const camera = new THREE.Camera();
    camera.layers.enableAll(); // the scene is split across layers for lighting, not for visibility
    return camera;
  })();
  private worldToClip = new THREE.Matrix4();
  private clipToWorld = new THREE.Matrix4();
  private transform = new THREE.Matrix4();
  private center!: MercatorCoordinate;
  private unit = 1;
  private project?: ProjectDocument;
  private stack = false;
  private walking = false;
  /** The walked floor has lamps of its own. Then the walk hands the interior over to them and
   *  turns the general ceiling light down; a floor without any keeps the general light, or it is
   *  a dark floor with a bright lid. */
  private lampLit = false;
  private poolLitOnly = false;
  /** Per-storey ghost strength for the things a stack is FOR — the floor plates that carry each
   *  storey's plan — on the storeys ABOVE the one in focus. Shared out across however many of them
   *  the stack layers up between the eye and the focus. */
  private ghostAlpha = 0.17;
  /** And for the storeys UNDER the one in focus, which are read through the active plate as well as
   *  through everything above it and need the strength to survive both. Keeping the two apart is
   *  also what lets the active plate be drawn between them — see the render-order pass. */
  private underAlpha = 0.27;
  private activeFloor: string | null = null;
  private hovered: string | null = null;
  private rebase = 0;
  /** See sceneGround: what an authored elevation has to be shifted by to join the scene. */
  private ground = 0;
  private growth = 1;
  private growthStart = 0;
  private materials = new MaterialLibrary();
  private fixtureLights?: FixtureLights;
  private waterTime = { value: 0 };
  private hasWater = false;
  private batch = new SurfaceBatch();
  private highlight = new THREE.Group();
  private selected: string | null = null;
  /** Where the sun stands over this project right now, and whether that counts as evening. */
  private sunState: Sun = FIXED.day;
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
  /** The two lights that are not the sun, kept so the scene can be re-lit without being rebuilt. */
  private skyLight?: THREE.HemisphereLight;
  private roomLight?: THREE.HemisphereLight;
  private route: Route | null = null;
  private routeStep: number | null = null;
  private routeGroup: THREE.Group | null = null;
  private routeTile: THREE.DataTexture | null = null;
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
  /** Move the existing lights to where a new sun puts them, without touching the geometry. Valid
   *  only while the dusk treatment is unchanged — see the caller. */
  private relight(project: ProjectDocument, floorId: string | null, sun: Sun) {
    const air = ambient(sun, project.floors.find(f => f.id === floorId)?.light);
    this.scene.environmentIntensity = this.poolLitOnly ? 0 : air.environment;
    this.skyLight?.color.set(air.sky);
    this.skyLight?.groundColor.set(air.ground);
    if (this.skyLight) this.skyLight.intensity = this.poolLitOnly ? 0 : air.hemisphere;
    this.roomLight?.color.set(air.interior);
    this.roomLight?.groundColor.set(air.interiorBounce);
    if (this.roomLight) this.roomLight.intensity = air.interiorLevel * (this.walking && this.lampLit ? 0.45 : 1);
    const beam = sunlight(sun);
    if (this.sun) {
      this.sun.color.set(beam.color);
      this.sun.intensity = this.poolLitOnly ? 0 : beam.intensity;
      this.sun.position.set(...beam.position);
      this.fitShadowCamera();
    }
    this.refreshShadows();
    this.map?.triggerRepaint();
  }
  /** Redraw every shadow map on the next frame: the sun's, and each lamp's. Shadows are drawn on
   *  demand, and each light says for itself whether it is owed a redraw — the sun's map is one
   *  2048² pass over the whole model and a lamp's is six, so a lamp swapping under a walker must
   *  not cost the sun's as well. This is the "everything changed" case. */
  private refreshShadows() {
    if (!this.renderer) return;
    if (this.sun) this.sun.shadow.needsUpdate = true;
    this.fixtureLights?.invalidate();
    this.renderer.shadowMap.needsUpdate = true;
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
  /** Ask for a repaint at the loop rate rather than at once, coalescing the requests so a dozen
   *  escalators still only cost one frame between them. */
  private loopTimer?: ReturnType<typeof setTimeout>;
  private paintSoon() {
    if (this.loopTimer) return;
    this.loopTimer = setTimeout(() => {
      this.loopTimer = undefined;
      this.map?.triggerRepaint();
    }, LOOP_FRAME);
  }
  /** One vertex, mapped by the view's depth transform — see sceneElevation. Geometry is built at
   *  the elevations the document authored, so this is the last thing that touches a z before it
   *  reaches the buffer. It ran in the stacked view only, which left a deep cutaway drawing its
   *  plate at the compressed depth and everything around it at the real one. */
  private present(z: number) {
    return this.buried && !this.walking ? this.presentedElevation(z) : z;
  }
  private surface(
    rings: Point[][],
    base: number,
    height: number,
    color: string,
    id: string,
    material?: SurfaceFinish,
    // True for the shared per-storey plate strength; a number for a surface whose own storey has
    // asked for a different one — see ghostStrength.
    ghost: boolean | number = false,
    // Bake contact shading into the lower part of the surface. Where a wall meets a floor there is
    // almost no sky reaching the junction, and without that darkening every wall looks like it is
    // hovering a millimetre above the slab rather than standing on it.
    ao = false,
    override?: THREE.MeshStandardMaterial,
    // Out of doors, and so out of reach of the building's own ceiling lighting. The parcel, the
    // landscaping, a fence: lit by the sky and nothing else, whatever the lamps inside are doing.
    outdoor = false,
  ) {
    // An area a void has swallowed whole — a parking bay lying under the ramp that runs over it — has
    // no plate left to draw, and asking for the first of no rings took the rest of the storey down
    // with it.
    if (!rings.length) return;
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
    if (this.buried && !this.walking && this.depthScale < 1) {
      const positions = geometry.getAttribute('position');
      for (let i = 0; i < positions.count; i++) positions.setZ(i, this.present(positions.getZ(i)));
      geometry.computeVertexNormals();
    }
    const surfaceMaterial =
      override ??
      (ghost
        ? this.materials.ghost(color, typeof ghost === 'number' ? ghost : this.ghostAlpha)
        : material
          ? this.materials.get(material, color)
          : this.materials.solid(color));
    this.batch.add(geometry, ao && !ghost ? this.materials.shaded(surfaceMaterial) : surfaceMaterial, id, outdoor);
  }
  /** A sloped area (garage ramp, loading incline): the plate's own footprint, but each vertex lifted
   *  to its elevation along the slope axis, then given thickness along -Z so the deck reads solid
   *  from below. Depth compression is applied per-vertex, exactly as for flat surfaces. */
  private slopedSurface(
    o: SiteObject,
    slope: Slope,
    lift: number,
    thickness: number,
    color: string,
    ghost: boolean | number = false,
  ) {
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
    this.batch.add(
      geometry,
      ghost
        ? this.materials.ghost(color, typeof ghost === 'number' ? ghost : this.ghostAlpha)
        : this.materials.solid(color),
      o.id,
    );
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
      const glass = this.materials.glass(this.sunState.evening, lit);
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
    if (ring.length < 3) return null;
    const wall = project.barriers.find(b => b.id === piece.id);
    if (!wall || wall.thickness < 0.03) return null;
    const [start, end] = barrierEnds(project, wall);
    const length = distance(start, end),
      ux = (end[0] - start[0]) / length,
      uy = (end[1] - start[1]) / length;
    // Joined pieces are trapezoids at corners. Find the actual long faces parallel to the wall,
    // rather than treating a mitred end as another long side or inferring thickness from it.
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i],
        b = ring[(i + 1) % ring.length],
        len = distance(a, b);
      if (len < 0.05 || Math.abs((b[0] - a[0]) * uy - (b[1] - a[1]) * ux) > 1e-6 * len) continue;
      const nx = (b[1] - a[1]) / len,
        ny = -(b[0] - a[0]) / len;
      const mid: Point = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      const probe: Point = [mid[0] + nx * 0.3, mid[1] + ny * 0.3];
      if (!outline.some(r => pointInRing(probe, r))) continue;
      const skin = Math.min(0.05, wall.thickness / 3),
        out = 0.003 - skin / 2;
      const angle = (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI;
      return closeRing(rectangle([mid[0] + nx * out, mid[1] + ny * out], len, skin, angle));
    }
    return null;
  }
  /** An area's rings with the shafts that climb through its level, and the ramps that drive through
   *  it, cut out of them.
   *
   *  `through` says which plate is being cut: a floor is open where something arrives up through it,
   *  a ceiling where something sets off up through it. They are not the same holes — the bottom of a
   *  run departs without arriving and the top arrives without departing — and on a criss-cross
   *  escalator bank they are at opposite ends of the same box.
   *
   *  `wells` is whether a stairwell may be punched at all — a hole onto a storey nobody is drawing
   *  is worse than no hole. A ramp is not subject to it: what is under a ramp's hole is the ramp.
   *
   *  Cheap when there is nothing to cut, which is the usual case: a floor with no shaft through it
   *  gets its own rings back untouched, and one with a shaft pays a clip only for the areas the
   *  shaft actually lands in. */
  private withVoids(
    project: ProjectDocument,
    rings: Ring[],
    floorId: string,
    primary: Set<string>,
    through: 'floor' | 'ceiling' = 'floor',
    wells = true,
  ): Ring[] {
    const key = `${floorId}|${through}|${wells}`;
    let voids = this.voidCache.get(key);
    if (!voids) {
      // Above ground nothing under the street is drawn, flights included, so a hole cut for one
      // would open onto the basemap with nothing coming up through it.
      voids = wells ? shaftVoids(project, floorId, primary, { through, lowest: this.buried ? -Infinity : -0.01 }) : [];
      // A driveway is a hole in a deck as surely as a stairwell is. The ramp off P1 dives under the
      // plate it is filed on the moment it starts falling, so drawn whole that plate is a lid over
      // it and the ramp was invisible from the deck it leaves. Where ramp and deck meet they are
      // level with each other, so the ramp fills exactly what it cuts. Floors only: nothing drives
      // up out of the storey overhead into the ceiling.
      if (through === 'floor')
        voids = [
          ...voids,
          ...rampVoids(project, floorId),
          ...project.objects.filter(o => o.floorId === floorId && o.water && o.rings?.length).map(o => o.rings![0]),
        ];
      this.voidCache.set(key, voids);
    }
    if (!voids.length || !rings.length) return rings;
    const hits = voids.filter(v => boxesMeet(v, rings[0]));
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
    const model = stairModel(project, o);
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
    // A shaft is exempt from the below-grade skip — it is filed under the lowest level it serves and
    // would otherwise vanish from every storey above — but that exemption let it draw its whole body.
    // On an above-ground view nothing under the street is drawn, so a garage flight climbed out of
    // bare basemap with no deck at either end of it. Clamp the shaft to the levels the view builds.
    const drawn = this.buried ? near : near.filter(f => f.from.elevation > -0.01);
    if (!drawn.length) return;
    for (const flight of drawn) {
      const base = z + (flight.from.elevation - own) + wallBase(o.floorId);
      if (model === 'spiral') {
        this.spiral(o, position, base, flight.rise, color);
        continue;
      }
      const index = all.indexOf(flight);
      // A criss-cross bank lands every flight where the next one starts, so the two of them asked
      // for the same landing and drew it twice, in the same place, at the same height. One plate per
      // level: the flight above puts its foot plate there, so the one below leaves its head bare.
      const shared = index + 1 < all.length && drawn.includes(all[index + 1]);
      this.flight(o, flightRun(project, o, flight.rise, model, index), base, flight.rise, color, model, !shared);
    }
  }
  /** A straight climb: treads for a stair, a ribbed deck between flat landing plates for an
   *  escalator. Both run along the object's own depth axis, which is where the plan put them. */
  private flight(
    o: SiteObject,
    run: FlightRun,
    base: number,
    rise: number,
    color: string,
    model: StairModel,
    /** Draw the landing at the head of this flight. False where the flight above starts here and
     *  puts its own plate on the same level — see the criss-cross bank in shaft(). */
    head = true,
  ) {
    const { at, half, pad, incline, topT, footT, rotation } = run;
    if (model === 'escalator') {
      // Landing plates at both ends, then the incline between them. A real escalator has about a
      // metre of flat comb plate at each end; without them the deck spears into the floor. The
      // incline is only as long as the rise needs at the machine's own 30° — see flightRun — so the
      // plate at the foot takes whatever run is left over rather than the climb being flattened out
      // to fill the box.
      const band = escalatorSteps(rise, incline);
      const going = band[0].going,
        face = band[0].face,
        riser = rise / band.length;
      // The comb plate the band runs into: deeper than a step's face, because the step that has just
      // left the head of a moving band has to go somewhere and inside that plate is where — see the
      // spare steps below. Its TOP is the storey's floor, not its underside: a landing standing a
      // fifth of a metre proud is a block you step up onto and then down off again.
      const comb = Math.max(0.24, riser + 0.06);
      const foot = half - footT;
      // And the foot plate is deep enough to bury the spare step waiting under it.
      this.surface(
        [rectangle(at(footT + foot / 2), o.width, foot, rotation)],
        base - (riser + face + 0.08),
        riser + face + 0.08 + PLATE_LIP,
        color,
        o.id,
      );
      if (head)
        this.surface(
          [rectangle(at(topT - pad / 2), o.width, pad, rotation)],
          base + rise - comb,
          comb + PLATE_LIP,
          color,
          o.id,
        );
      // The truss the steps ride on: the old smooth deck, dropped clear of the step band so it reads
      // as the machine under the stair rather than as the surface you walk on.
      const body = { ...o, rings: [rectangle(at((topT + footT) / 2), o.width, incline, rotation)] } as SiteObject;
      this.slopedSurface(body, { axis: [at(topT), at(footT)], high: base + rise, low: base }, -face, 0.3, '#9aa5a1');
      const tread = (step: { at: number; base: number }) => ({
        rings: [rectangle(at(footT - step.at), o.width - 0.12, going * 1.02, rotation)],
        base: base + step.base,
        height: face,
      });
      // Which way the machine runs, and whether it is running at all. The object says which way it
      // was built to carry you; a feed may say it has been reversed for the evening peak, and may
      // say it has been stopped — and a stopped escalator is a stair, so its steps stand still.
      const reading = this.statuses?.get(o.feedId ?? '');
      const way = (reading?.travel ?? o.travel ?? 'up') === 'down' ? -1 : 1;
      const running = reading?.running ?? true;
      // Standing on one storey there are at most two flights in view, so they can move. In the
      // stacked view there are all of them, on every level of the building at once — dozens of bands
      // asking for a repaint every frame to animate something a few pixels wide — so there the band
      // is welded into the batch with everything else and simply stands still. A stopped escalator
      // takes the same path: nothing to animate, so nothing asks for a frame.
      if (this.stack || !running) {
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
        // cycle under the foot plate and climbs out from beneath it, which is what a real escalator
        // does anyway — and at the head the step that has climbed past the last visible one finishes
        // its cycle inside the comb plate, which is why that plate is deeper than a step's face: it
        // is the head housing the band runs into. A descending band is the same picture upside down,
        // so its spare waits in the head housing instead.
        //
        const spare =
          way > 0 ? { at: -going / 2, base: -riser - face } : { at: incline + going / 2, base: rise - face };
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
        const mid = at((topT + footT) / 2);
        const rail = {
          ...o,
          rings: [rectangle([mid[0] + offset[0], mid[1] + offset[1]], 0.1, incline, rotation)],
        } as SiteObject;
        this.slopedSurface(
          rail,
          {
            axis: [
              [at(topT)[0] + offset[0], at(topT)[1] + offset[1]],
              [at(footT)[0] + offset[0], at(footT)[1] + offset[1]],
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
    const centre = at(0);
    for (let lane = 0; lane < sweeps; lane++) {
      const from = base + (rise * lane) / sweeps,
        climb = rise / sweeps;
      // A 175 mm riser is the comfortable domestic figure, and a third of a metre is as deep as a
      // tread gets: past that a long box was spreading a short climb into a ramp with slabs on it,
      // so the surplus run goes to the landing instead — see treads().
      const { steps, going } = treads(climb, run.length);
      const spin = rotation + (lane ? turn : 0);
      const rad = (spin * Math.PI) / 180;
      const vx = Math.sin(rad),
        vy = -Math.cos(rad);
      // BOTH lanes stand off the object's axis, half a lane each way. Leaving the first centred and
      // shifting only the second by half a lane had the two overlapping by a quarter of the box —
      // on a 2.5 m core stair, half a metre of tread that belonged to both flights at once.
      const offset = sweeps > 1 ? rotate([((lane ? 1 : -1) * laneWidth) / 2, 0], rotation) : ([0, 0] as Point);
      const shifted: Point = [centre[0] + offset[0], centre[1] + offset[1]];
      const on = (t: number): Point => [shifted[0] + vx * t, shifted[1] + vy * t];
      if (lane && sweeps > 1) {
        // The landing the turn happens on, at the height the first flight reached — the object's own
        // box wide, not a lane and a half of it hanging out over the floor beside the core, and as
        // deep as the run the treads did not need, so you turn on floor rather than on air.
        const depth = Math.max(going * 1.7, run.length - steps * going);
        this.surface(
          [rectangle(at(-half + depth / 2), o.width, depth, rotation)],
          from - 0.05,
          0.11,
          color,
          o.id,
          o.material,
        );
      }
      for (let i = 0; i < steps; i++) {
        this.surface(
          [rectangle(on(half - going * (i + 0.5)), laneWidth * 0.94, going * 1.02, spin)],
          from + (climb * i) / steps,
          climb / steps + 0.04,
          color,
          o.id,
          o.material,
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
    // Above ground, no lower than the map plane. A lift running up from a garage is filed under P3
    // and exempt from the below-grade skip so that it shows on every storey it serves — but that
    // exemption had it stand its shell down to -21 m over a basemap with no building around it.
    const stood = this.buried ? levels : levels.filter(f => f.elevation > -0.01);
    const lowest = stood[0] ?? levels[0];
    const bottom = Math.max(rel(levels[0]), this.buried ? -Infinity : z - own + wallBase(o.floorId));
    const top = rel(levels[levels.length - 1]) + (levels[levels.length - 1].height ?? o.height);
    // Split at the level in focus: solid to the head of this storey, ghost for whatever is above it.
    const cut = active ? Math.min(top, z + (active.elevation - own) + wallBase(o.floorId) + (active.height ?? 3)) : top;
    const shell = (from: number, to: number, ghost: boolean | number) => {
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
    // Not at the plates' strength. A shaft is one thin column, not a layer over the plan, so it pays
    // none of the veil the stacked storeys are sharing out — and on a tall building that share falls
    // low enough to erase it, which takes with it the one thing in the stack that says how the
    // storeys are joined.
    shell(cut, top, Math.max(this.ghostAlpha, SHAFT_GHOST));
    // The landing doors, on the storey in focus, facing the way the lift is turned. Two leaves that
    // part: closed unless the feed says this car is standing here with its doors open.
    const reading = this.statuses?.get(o.feedId ?? '');
    const carFloor = reading?.carFloorId ?? null;
    // The car rides to the level the feed names, or waits at the bottom of its shaft — which is what
    // an idle lift actually does. Its target is an ELEVATION, not a floor: the ride takes as long as
    // the distance, so eight storeys is a longer journey than one.
    const carAt = levels.find(f => f.id === carFloor && (this.buried || f.elevation > -0.01)) ?? lowest;
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
      // Treads count up from the first one you step ON, so the last lands level with the floor above
      // rather than a riser short of it — which is what left a spiral ending in a step up to nothing.
      this.surface([closeRing(ring)], base + (rise * (i + 1)) / steps - 0.07, 0.07, color, o.id);
    }
    // The pole the whole thing hangs off.
    this.surface([rectangle(position, inner * 2, inner * 2, 0)], base, rise, '#9aa3a0', o.id);
  }
  update(
    project: ProjectDocument,
    floorId: string | null,
    stack: boolean,
    selected: string | null,
    sun: Sun = FIXED.day,
    statuses: Map<string, StatusReading> | null = null,
    excavation = false,
    /** Walk mode: put the floor being walked on the map's own ground plane. MapLibre's camera cannot
     *  go below that plane, so a basement drawn at its true depth would be unreachable on foot. */
    walk = false,
  ) {
    // Everything below still asks "is it evening?" — that question has an answer, it just is not a
    // switch any more. The sun's own angle and strength are read from `sun` where they matter.
    const evening = sun.evening;
    const liftSignature = statuses
      ? [...statuses.values()]
          .filter(r => r.carFloorId !== undefined || r.open !== undefined || r.running !== undefined || r.travel)
          .map(r => `${r.feedId}:${r.carFloorId ?? ''}:${r.open ?? ''}:${r.running ?? ''}:${r.travel ?? ''}`)
          .sort()
          .join('|')
      : '';
    this.statuses = statuses;
    const settled =
      this.project === project &&
      this.stack === stack &&
      this.walking === walk &&
      this.activeFloor === floorId &&
      this.liftSignature === liftSignature &&
      this.excavation === excavation &&
      this.scene.children.length > 0;
    if (settled && this.sunState === sun) {
      if (this.selected !== selected) {
        this.selected = selected;
        this.refreshHighlight();
      }
      return;
    }
    // The sun moves every ten minutes, and a building does not change when it does. Rebuilding a
    // seventeen-storey model — or a hundred-level one — to move a light would freeze the map on a
    // timer for no reason, so when the sun is the only thing that has moved, only the lights move.
    // Crossing into or out of dusk is the exception: that turns lamps on, changes the glazing and
    // recolours the contact shadows, none of which live in a light.
    if (settled && this.sunState.evening === sun.evening) {
      this.sunState = sun;
      this.relight(project, floorId, sun);
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
    clearTimeout(this.loopTimer);
    this.loopTimer = undefined;
    this.rigs = [];
    this.project = project;
    this.stack = stack;
    this.walking = walk;
    this.lampLit =
      !!walk && !!floorId && project.objects.some(o => o.floorId === floorId && o.kind === 'light' && !!o.light);
    this.poolLitOnly =
      project.floors.find(f => f.id === floorId)?.light?.level === 0 &&
      project.objects.some(o => o.floorId === floorId && !!o.water);
    this.activeFloor = floorId;
    this.selected = selected;
    this.sunState = sun;
    this.liftSignature = liftSignature;
    this.excavation = excavation;
    this.revision++;
    // Standing in it, most of a floor is behind you and a lamp's shadow reaches twelve metres:
    // batch the floor in cells so the frustum and the shadow passes can leave the rest alone. From
    // above, everything is in the frame and one mesh per material is cheapest.
    this.batch.chunk = walk ? 20 : 0;
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
    // The datum a cutaway builds its geometry about: the level in focus, at the depth the DOCUMENT
    // gives it, because present() is what maps a depth for the screen and it wants authored metres
    // to work on. Rebasing to the compressed depth here and then adding raw deltas to it was the
    // two-mappings bug: the plate landed where the camera aims and everything referred to it did not.
    this.rebase = stack || walk ? 0 : (activeF?.elevation ?? 0);
    // What an authored elevation has to be shifted by to land in the frame the rest of the scene is
    // drawn in — see sceneGround. Zero in every view but a walk, which is the one that moves the
    // level in focus away from where the document put it.
    const ground = sceneGround(stack, this.rebase, activeF?.elevation ?? 0);
    this.ground = ground;
    // Deep stacks show the complete structure with detail on the selected floor. Building every
    // room and fitting hundreds of metres into a city camera wasted work on hidden geometry.
    //
    // Only where the depth mapping is actually compressing something. Counting levels said yes to
    // Stockmann's seventeen storeys, which are drawn at their true depths and fit on the screen
    // perfectly well, so "All floors" from any basement threw away fourteen above-ground storeys
    // and drew wire rings where the building was.
    const structureOverview = buried && stack && view.compressed && !!activeF;
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
    // The level in focus decides what the interior light is, because that is the level you are
    // looking into. A stack is lit by the one in focus too: they are usually the same building with
    // the same fit-out, and lighting seventeen storeys three different colours at once would say
    // something about the building that is not true.
    const air = ambient(sun, project.floors.find(f => f.id === floorId)?.light);
    // Walking, the eye is inside and adapted to the inside. The exposure that keeps a plan legible
    // from above is set against the basemap — a small pale plate over a pale map — and at eye level
    // that same plate fills the lower half of the frame and clips to white. A clipped floor has no
    // contrast left to give: it is the flat grey field you see when you stand in one. Stopping down
    // is what an eye does on the way through the door, and it hands the range back to the floor.
    // Standing inside, the eye is adapted to the inside. The exposure that keeps a plan legible from
    // above is set against the basemap — a small pale plate over a pale map — and at eye level that
    // same plate fills the lower half of the frame and clips to white. A clipped floor has no
    // contrast left to give: it is the flat grey field you see when you stand in one.
    if (this.renderer) this.renderer.toneMappingExposure = walk ? 0.68 : 0.9;
    this.scene.environment = this.environmentMap(evening);
    this.scene.environmentRotation.set(Math.PI / 2, 0, 0);
    this.scene.environmentIntensity = this.poolLitOnly ? 0 : air.environment;
    const sky = new THREE.HemisphereLight(air.sky, air.ground, this.poolLitOnly ? 0 : air.hemisphere);
    sky.position.set(0, 0, 1);
    sky.layers.enableAll();
    this.scene.add(sky);
    this.skyLight = sky;
    // The building's own lighting, which does not care what the sun is doing. Offices, shop floors
    // and garages burn their lights around the clock, and Kerros draws buildings from the inside —
    // so a storey in section at midnight is lit by this and stays readable, while outside goes dark.
    // A ceiling light lands most of itself on the floor, so the floor comes out the brightest plane
    // in the room — which is true of the light and false of the picture, because a real floor is the
    // darkest one. Looking down into a cutaway that does not matter; the plate is a small patch in a
    // big frame. At eye level it is half the frame, and it blew out. Walking, the lamps come down and
    // the luminous ceiling carries the reading of a lit interior instead.
    const room = new THREE.HemisphereLight(
      air.interior,
      air.interiorBounce,
      walk && this.lampLit ? air.interiorLevel * 0.45 : air.interiorLevel,
    );
    room.position.set(0, 0, 1);
    this.scene.add(room);
    this.roomLight = room;
    const beam = sunlight(sun);
    const light = new THREE.DirectionalLight(beam.color, this.poolLitOnly ? 0 : beam.intensity);
    light.position.set(...beam.position);
    // A dim, cool fill from the opposite quarter. Real interiors and streets bounce light back into
    // the shadow side; without it every unlit façade collapses to the same dead tone.
    const fill = new THREE.DirectionalLight(
      evening ? '#7f90bd' : '#cfe0f2',
      this.poolLitOnly ? 0 : evening ? 0.16 : 0.18,
    );
    fill.layers.enableAll();
    fill.position.set(evening ? -80 : 85, evening ? 60 : 55, 45);
    this.scene.add(fill);
    light.layers.enableAll();
    light.castShadow = true;
    light.shadow.autoUpdate = false; // redrawn by refreshShadows(), not by every lamp that moves
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
    // Ghosts do not sort and do not cancel: each layer multiplies into the next, so the strength
    // that lets a house's two storeys read through one another turns a tower into a solid block.
    //
    // The share used to be 1/levels clamped into [0.17, 0.38], which stops sharing at six levels and
    // hands seventeen the same 0.17 it hands six — measured on Stockmann, every one of the seventeen
    // drew at the floor of the clamp. n layers at a each pass (1-a)^n of whatever is behind them, so
    // the only arithmetic that means anything on a tall building is to fix what must come through
    // and solve for a. And to count each side of the storey in focus separately, because the two
    // sides are asked for different things: what is ABOVE stands between the eye and the focus and
    // has to leave most of it, while what is BELOW is already behind the focus's own half-clear
    // plate and needs the strength to show through it. One number for both is why picking a low
    // floor of a tall building used to bury it under everything it was picked out of.
    const share = (transmit: number, levels: number) =>
      Math.max(0.035, Math.min(0.38, 1 - transmit ** (1 / Math.max(1, levels))));
    this.ghostAlpha = share(FOCUS_SEEN, view.levels.filter(f => f.elevation > (activeF?.elevation ?? 0)).length);
    this.underAlpha = share(UNDER_SEEN, view.levels.filter(f => f.elevation < (activeF?.elevation ?? 0)).length);
    /** How strongly a storey that is not the one in focus draws — and, since a batch is cut by
     *  material, which side of the active plate its geometry ends up being drawn on. `kase` is the
     *  envelope and the partitions, which are looked through rather than at. */
    const ghostStrength = (fid: string | null | undefined, kase = false) =>
      kase
        ? CASE_ALPHA
        : activeF && (floors.get(fid ?? '')?.elevation ?? 0) < activeF.elevation
          ? this.underAlpha
          : this.ghostAlpha;
    // An entresol is a partial level — a gallery ringing a void — so on its own it is a thin loop
    // floating over nothing. The storey it overlooks is what gives it something to be above, and in
    // 2D the plan has always drawn that; 3D showed the loop alone. Carry the level below with it.
    const under =
      activeF?.mezzanine && !stack
        ? project.floors
            .filter(f => f.buildingId === activeF.buildingId && f.elevation < activeF.elevation)
            .sort((a, b) => b.elevation - a.elevation)[0]
        : undefined;
    // The mirror of `under`, and the reason a hall never showed the gallery hanging in it: a
    // mezzanine sits INSIDE the storey below it, so from the ground floor the entresol is a level
    // nothing draws and the twelve flights climbing to it end in mid-air. A mezzanine whose datum
    // falls within the active storey belongs to it, seen from below.
    //
    // Mezzanines only. A gallery drawn tall enough to stand in can reach past its host storey's
    // head, and taking every level that starts inside the storey would then hang the whole floor
    // above it over the hall as well.
    const over =
      activeF && !stack
        ? project.floors.filter(
            f =>
              f.mezzanine &&
              f.buildingId === activeF.buildingId &&
              f.id !== activeF.id &&
              f.elevation > activeF.elevation &&
              f.elevation < activeF.elevation + activeF.height,
          )
        : [];
    // The storeys a single-floor view draws beneath the one in focus, as a façade envelope: their
    // slabs, their exterior walls and their glazing. A mezzanine's carried level is left out — it is
    // drawn in full above, and drawing it again put a second uncut slab and a second set of windows
    // through the first.
    const lower = new Map(
      !stack && !walk && activeF
        ? view.levels
            .filter(fl => fl.elevation >= 0 && fl.elevation < activeF.elevation && fl.id !== under?.id)
            .map(fl => [fl.id, fl] as const)
        : [],
    );
    // Below grade there is no envelope to fall back on: the cutaway drew the deck in focus and
    // nothing under it, so every ramp and every arriving flight ended in mid-air over bedrock.
    // Shell the storey immediately below, the way the stack shells the ones beneath its focus.
    const belowShell =
      buried && !stack && !walk && activeF
        ? view.levels
            .filter(f => f.elevation < activeF.elevation && f.id !== under?.id)
            .sort((a, b) => b.elevation - a.elevation)[0]
        : undefined;
    // Every storey this view actually builds below the one in focus.
    const spanningObjects = walk ? tallSpaceContext(project, floorId) : [];
    const contextFloors = new Set(spanningObjects.map(o => o.floorId).filter(Boolean) as string[]);
    const drawnLevels = new Set<string>(
      [...shellBelow, ...lower.keys(), ...contextFloors, under?.id, belowShell?.id, floorId].filter(
        Boolean,
      ) as string[],
    );
    /** Does a hole in this level's plate open onto a storey that is drawn? A stairwell punched
     *  through a floor with nothing under it is not a stairwell: on the ground floor all twelve of
     *  them opened straight onto the basemap. The stack draws every storey, so there it always is. */
    const punchWells = (fid: string) =>
      stack ||
      view.levels.some(f => f.elevation < (floors.get(fid)?.elevation ?? 0) && f.id !== fid && drawnLevels.has(f.id));
    /** Where a floor's geometry is built, before present() maps it for the screen: the elevation the
     *  document authored in a cutaway, and the height above the walked storey in a walk. Out of doors
     *  is grade, which is `ground` away from the floor being walked. */
    const relative = (fid: string | null) =>
      fid
        ? this.rebase + ((floors.get(fid)?.elevation ?? activeF?.elevation ?? 0) - (activeF?.elevation ?? 0))
        : ground;
    /** Where an authored depth is shown, for the geometry that is placed outright rather than built
     *  and then presented: the excavation face and the cage. Same mapping present() puts the model
     *  through, or the soil and the plate standing in it disagree about how deep the storey is. */
    const shown = (z: number) => sceneElevation(view, walk, z);
    const visibleObjects = stack
      ? project.objects
      : // Deduplicated: a shaft filed under the storey below reaches this one, and the carried
        // levels bring their own copy of the same object.
        [
          ...new Map(
            [
              ...(index.objects.get(null) ?? []),
              ...(under ? (index.objects.get(under.id) ?? []) : []),
              ...over.flatMap(f => index.objects.get(f.id) ?? []),
              ...spanningObjects,
              ...(floorId ? (index.objects.get(floorId) ?? []) : []),
              // A stair that climbs to this level belongs on it, even though it is filed under the
              // one it starts from. Without this the flight you are standing at the top of is not
              // drawn.
              ...(floorId ? (index.reaching.get(floorId) ?? []) : []),
              // And a driveway that surfaces belongs to the street as much as to the deck it leaves.
              // It is filed on the deck, so the site view — which iterates the site's own objects —
              // never saw it, and the garage came out with no mouth at the kerb.
              ...(floorId === null
                ? project.objects.filter(o => o.slope && Math.max(o.slope.high, o.slope.low) >= -0.01)
                : []),
              // A ramp is a floor that is two floors. It is filed on the deck it leaves, so the deck
              // it arrives at drew nothing: from P2 the ramp down from P1 stopped existing, and a
              // car came up out of a plate with no way onto it. Both decks it joins, then — the
              // levels its own slope starts and ends at, rather than every storey the incline passes
              // through. The driveway out to Mannerheimintie crosses -4.2, -6.6 and -9 a hundred
              // metres away under the street, and it has nothing to do with any of them.
              ...(activeF
                ? project.objects.filter(
                    o =>
                      rampJoins(o, activeF.elevation) && floors.get(o.floorId ?? '')?.buildingId === activeF.buildingId,
                  )
                : []),
            ].map(o => [o.id, o] as const),
          ).values(),
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
      // And a driveway that surfaces is the second: a ramp climbing out of the garage belongs to the
      // street as much as to the deck it leaves, so on the site view it is drawn diving into the
      // ground where it really does. Hiding it left the garage with no mouth and the kerb with an
      // unexplained gap in it.
      const surfaces = floorId === null && !!o.slope && Math.max(o.slope.high, o.slope.low) >= -0.01;
      if (!buried && belowGrade(o.floorId) && !(isVertical(o.kind) && reaches(project, o, floorId)) && !surfaces)
        continue;
      // A twin of a shaft already drawn from its lowest level. One lift, one shaft.
      if (isVertical(o.kind) && !index.primary.has(o.id)) continue;
      // A shaft is filed under the LOWEST level it serves, and every rule that hides a storey under
      // the one in focus was hiding the shafts with it: the store's twelve cores are filed on Herkku
      // and the garage's on P3, so "All floors" showed a building of punched stairwells with nothing
      // in them unless you happened to be standing on one of those two levels. A shaft is not on a
      // storey, it is between them — exempt, the way an exterior wall already is.
      const spanning = isVertical(o.kind);
      if (o.floorId && outlineOnly.has(o.floorId) && !spanning) continue;
      // A storey under the one in focus keeps its PLAN and loses its fit-out. It used to lose both:
      // the shell replaced every level below with one union slab in one flat grey, which on
      // Stockmann turned ten storeys of plan into ten identical rectangles — and a mode called "All
      // floors" that shows none of them is the whole complaint. The plates are what a doll's house
      // is for, and they are also the cheap half: a retail storey is a plate and a room, and even
      // an office fit-out is a hundred flat shapes against its hundreds of extruded partitions.
      // Partitions and fittings stay dropped, because looking down through a stack a partition is a
      // smear and the plate is the thing that says what the storey is.
      // Not on a stack deep enough to be compressed: structureOverview exists precisely so that a
      // hundred-metre shaft does not build every bay on every deck, and there the shell slab goes on
      // standing in for the plans.
      const planPlate = !structureOverview && (o.kind === 'room' || o.kind === 'zone' || !!o.slope);
      if (o.floorId && shellBelow.has(o.floorId) && !spanning && !planPlate) continue;
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
      //
      // And a ghost keeps the colour it was authored in. `ghost` darkens rather than tints precisely
      // so that it can — the comment on it says as much — but every ghosted plate was arriving here
      // already repainted the one neutral the carried levels under a cutaway want, so seventeen
      // storeys came out the same grey and the stack could not tell you that any of them differed.
      const activeLevel = floorId !== null && o.floorId === floorId;
      const ghosted = !!(stack && floorId !== null && o.floorId && o.floorId !== floorId);
      // A plate is the plan; anything standing up on a storey you are not looking at is in the way.
      const ghostFill = ghosted && ghostStrength(o.floorId, !(o.kind === 'room' || o.kind === 'zone'));
      // Looking down a stack, the active storey's plate is a lid over everything beneath it: pick the
      // top floor and the ones below vanish, however faithfully they are drawn. Only its own plate
      // has to give — its walls stay solid, so the level still reads as the one in focus.
      const lidsOverBelow = stack && activeLevel && levelsBelowActive;
      const color =
        this.mapStyle.objectColor?.(o) ??
        (activeLevel || ghosted
          ? (o.color ?? COLORS[o.kind] ?? '#e6e8e1')
          : indoorFinish && !o.material
            ? // A carried level under a cutaway is background: one neutral, so it reads as context
              // for the storey in focus rather than competing with it.
              '#e5e4df'
            : (o.color ?? COLORS[o.kind] ?? '#e6e8e1'));
      if (o.water && o.rings?.length) {
        if (!ghosted) {
          this.scene.add(makePool(o, pt => this.xy(pt), this.present(z + LIFT + SLAB), this.materials, this.waterTime));
          this.hasWater = true;
        }
        continue;
      }
      if (o.slide) {
        if (!ghosted)
          this.scene.add(makeWaterSlide(o, pt => this.xy(pt), this.present(z + LIFT + SLAB), this.materials));
        continue;
      }
      if (o.kind === 'fixture' || o.kind === 'landscape') {
        if (ghosted) continue;
        const fixture = makeFixture(
          o,
          pt => this.xy(pt),
          z + (o.floorId ? LIFT + SLAB : GROUND),
          this.materials,
          evening,
        );
        if (buried && !walk && z < 0) {
          const base = fixture.position.z,
            height = Math.max(o.height, 0.01);
          fixture.position.z = this.present(base);
          fixture.scale.z = (this.present(base + height) - this.present(base)) / height;
        }
        // Fold the fixture's boxes into the shared batch rather than adding a group of loose meshes:
        // each one was its own draw call and its own buffer upload, and a floor of parked cars or
        // desks runs to thousands of them.
        for (const leftover of this.batch.addObject(fixture, o.id, o.floorId === null)) this.scene.add(leftover);
        continue;
      }
      if (o.rings && o.slope) {
        // A sloped deck carries its own authored elevations, so it ignores the floor's plate height
        // and has to be brought into the scene's frame by hand — see sceneGround.
        //
        // Ghosted too, in the stack. A ramp is a storey's plan as much as its deck is, and skipping
        // it left the driveway out of every level but the one in focus — the shell slab used to
        // carry the ramp's footprint flat, and now that the storey draws its own plates it has to
        // draw its own slopes with them or the garage loses its way in and out.
        this.slopedSurface(o, o.slope, LIFT + SLAB + ground, SLAB, color, ghostFill);
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
          indoor && o.floorId
            ? this.withVoids(project, o.rings, o.floorId, index.primary, 'floor', punchWells(o.floorId))
            : o.rings,
          base,
          height,
          color,
          o.id,
          // The floor you are standing on used to be the one surface with no finish at all, which left
          // the largest expanse in the frame as flat untextured colour. Give it the same plaster as
          // the levels below — it is subtle enough not to compete with the plan, and without it a
          // whole storey reads as paper.
          ghosted ? undefined : (o.material ?? (indoorFinish ? 'plaster' : undefined)),
          ghostFill,
          false,
          lidsOverBelow && indoorFinish
            ? this.materials.plate(color)
            : // Walking, the floor is the one surface that can say where the light is, and only
              // because you see it along rather than down onto it.
              walk && indoorFinish && !ghosted && o.material !== 'carpet'
              ? this.materials.polished(this.materials.get(o.material ?? 'plaster', color))
              : undefined,
          !indoor,
        );
      } else if (['stairs', 'elevator', 'turnstile', 'door', 'gate', 'window'].includes(o.kind)) {
        // A door or a window belongs to its own storey and is left to it when that storey is only a
        // ghost. A shaft belongs to all of them at once, and the rule that skipped every ghosted
        // opening was the last one hiding the stairs from "All floors": it stays, at full strength,
        // because it is the one thing in the stack that says how the storeys are joined.
        if (!ghosted || spanning) this.opening(project, o, z);
      } else if (['office', 'container', 'storage'].includes(o.kind)) {
        this.surface(
          objectRings(o),
          z + wallBase(o.floorId),
          o.height,
          color,
          o.id,
          ghosted ? undefined : o.material,
          ghostFill,
          false,
          undefined,
          o.floorId === null,
        );
      }
    }
    // One slab per shell storey — the ceiling you look down onto — merged from its top-level plates
    // so a wing or a ramp is included and the interior divisions are not. One surface, one union,
    // per storey: the whole point of the shell is that it costs a fraction of the real floor.
    //
    // The cutaway's one shelled storey, and a compressed stack's. An ordinary stack no longer shells
    // the levels below its focus: they draw their own plates and their own ramps now, so the union
    // would be the same ground covered a second time — in one flat grey over the colours that had
    // just been recovered.
    for (const fid of [...(structureOverview ? shellBelow : []), ...(belowShell ? [belowShell.id] : [])]) {
      // Standing above ground you cannot see through the earth, and the object and wall loops both
      // say so — but the shell did not, so ghost slabs for the basements hung under the streets.
      if (!buried && belowGrade(fid)) continue;
      const z = stack ? (floors.get(fid)?.elevation ?? 0) : relative(fid);
      for (const pg of shellPlate(project, fid, index.primary, { lowest: buried ? -Infinity : -0.01 }))
        this.surface(pg, z + LIFT + SLAB, SLAB, '#e5e4df', `shell:${fid}`, undefined, stack && ghostStrength(fid));
    }
    // Walk mode gets a lid. An open-topped floor plate is not a room: the light has nothing to come
    // off, the floor runs away to the horizon and a shop floor reads as grey tarmac. The ceiling is
    // most of what makes an interior look like an interior from inside it. Cutaway keeps its open
    // top — looking down into a storey is the whole point of that view.
    //
    // Drawn per area rather than as one unioned lid, which is how it was first written and how the
    // shell slab still is. polygon-clipping's sweep line gives up on a real office fit-out — the
    // demo's 134-room level throws "Unable to find segment … in SweepLine tree" — and the union's
    // only fallback is no ceiling at all, which is exactly what a storey full of rooms got. Each
    // area's own rings already describe its shape, and withVoids already punches the stairwells
    // through them; nesting keeps a room's ceiling a hair below the zone's, which is coplanar-safe
    // and is also true of every fit-out inside a bigger space.
    if (walk && floorId && activeF) {
      // The underside of the storey above, and never below the walker's own eye — see walkSoffit.
      const { floor: ceilingFloor, soffit } = walkCeiling(project, floorId)!;
      // Lit by how much the floor's lamps are ON, not by how hard they are working. The room light
      // dims as daylight comes in, and tying the soffit to that made the ceiling go dark at noon —
      // the one time of day a room is unmistakably bright. A ceiling is the source, so it is the
      // brightest plane in the room or it is not a ceiling.
      const lit = this.materials.luminous('#f0f1ee', air.interior, 0.8 * (activeF.light?.level ?? 1), 'ceiling');
      const tiled = this.materials.luminous('#f2f3ef', air.interior, 0.7 * (activeF.light?.level ?? 1), 'tile');
      const tallRoofs = spanningObjects.filter(
        o => o.ceilingHeight && o.rings?.length && (floors.get(o.floorId!)?.elevation ?? 0) < activeF.elevation,
      );
      for (const o of [...(index.objects.get(ceilingFloor.id) ?? []), ...tallRoofs]) {
        if (!o.rings?.length || (o.kind !== 'room' && o.kind !== 'zone')) continue;
        if (o.water || o.slope) continue;
        if (!o.ceilingHeight && tallRoofs.some(hall => pointInRing(o.position, hall.rings![0]))) continue;
        const roof =
          o.ceilingHeight !== undefined
            ? walkSoffit(
                0,
                (floors.get(o.floorId!)?.elevation ?? activeF.elevation) + o.ceilingHeight - activeF.elevation,
              )
            : soffit;
        this.surface(
          // The lid is open where a flight sets OFF through it, which is not where the floor is open:
          // the bottom of a run departs without arriving, and a run's top arrives without departing.
          this.withVoids(project, o.rings, ceilingFloor.id, index.primary, 'ceiling'),
          roof - nestingLift(objectArea(o)),
          SLAB,
          '#f0f1ee',
          `ceiling:${o.id}`,
          undefined,
          false,
          false,
          o.material === 'tile' ? tiled : lit,
        );
      }
      // The wells the stairs and escalators climb through are punched out of the lid, and only this
      // storey is built — so through each one you looked straight at the sky. What is up a well is
      // the storey above: put its ceiling over the well, a storey higher and unlit, so the flight
      // climbs into a building rather than out of one.
      //
      // The storey above is the first one that starts at or past this storey's head, not simply the
      // next level up: a mezzanine hanging inside this storey is drawn in the room with you, and
      // taking its lid for the well head would have put the cap below the ceiling it is capping.
      const overhead = project.floors
        .filter(
          f =>
            f.buildingId === activeF.buildingId && f.elevation >= ceilingFloor.elevation + ceilingFloor.height - 0.01,
        )
        .sort((a, b) => a.elevation - b.elevation)[0];
      const wellHead = Math.max(
        soffit + SLAB,
        overhead ? walkSoffit(relative(overhead.id), overhead.height) : soffit + activeF.height,
      );
      const wells = shaftVoids(project, ceilingFloor.id, index.primary, {
        through: 'ceiling',
        lowest: buried ? -Infinity : -0.01,
      });
      for (const [i, well] of wells.entries()) this.surface([well], wellHead, SLAB, '#d9dad6', `well:${floorId}:${i}`);
    }
    // A carried level brings its walls too, or its rooms read as floating colour — the level below a
    // mezzanine, and the mezzanine hanging inside the storey you are looking at.
    const allPieces = [
      ...wallPieces(project, floorId, stack),
      ...(under ? wallPieces(project, under.id, false) : []),
      ...over.flatMap(f => wallPieces(project, f.id, false)),
      ...[...contextFloors]
        .filter(id => id !== under?.id && !over.some(f => f.id === id))
        .flatMap(id =>
          wallPieces(project, id, false).filter(piece =>
            spanningObjects.some(
              o => o.floorId === id && o.rings?.length && piece.ring.some(pt => pointInRing(pt, o.rings![0])),
            ),
          ),
        ),
    ];
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
      //
      // Translucent was not nearly enough on its own. A wall is an extruded solid, so a sight line
      // crosses two of its faces, and the façade band of seventeen storeys stands between the camera
      // and every plate in the building — at the plates' own strength that measured out as a closed
      // brick box with a plate floating in it. The envelope gets the case budget instead: strong
      // enough to say where the building is and how it is banded, weak enough to see the floors.
      const wallGhost =
        stack && floorId !== null && !!p.floorId && p.floorId !== floorId && ghostStrength(p.floorId, true);
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
        undefined,
        // A fence or a garden wall stands out of doors and is lit like the ground it stands on.
        p.floorId === null,
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
          for (const leftover of this.batch.addObject(roof, b.id, true)) this.scene.add(leftover);
        }
    // Only the lower envelope is needed beneath a cutaway. Keep its authored façade and glazing;
    // interior partitions and duplicate ceiling plates were both hidden work and sources of seams.
    if (lower.size) this.envelope(project, lower, exterior, finishes);
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
    //
    // Not while walking. The pit and the cage are the two things drawn at authored elevations that a
    // shift cannot rescue: the pit's cut face runs from the level in focus up to grade, and it is
    // grade the walk has moved away from — shifting the pit would stand the soil and its veil in the
    // room around the walker, and the cage's rings would cross him at ankle and head height. Both
    // are ways of looking AT a buried building from outside it; inside it they have nothing to say.
    if (buried && excavation && !walk) {
      const outline = index.outlines.get(activeF?.id ?? view.levels[0]?.id ?? '');
      const excavation = excavationRings(project, view.levels);
      const rings = excavation.length ? excavation : outline?.rings?.[0] ? [openRing(outline.rings[0])] : [];
      const split = shown(activeF?.elevation ?? 0);
      // The cut has to reach whatever the view actually draws below the floor in focus — the shelled
      // storey under it, and any ramp running down off the plate — or the ramp ends in mid-air and
      // the deck below stands inside bedrock. An arbitrary six metres did neither. The stacked view
      // already cuts to the bottom of the deepest level.
      const reach = Math.min(
        split,
        belowShell ? shown(belowShell.elevation) : split,
        ...(index.objects.get(floorId ?? '') ?? [])
          .filter(o => o.slope)
          .map(o => shown(Math.min(o.slope!.low, o.slope!.high))),
      );
      const bottom = stack ? shown(view.levels.reduce((z, f) => Math.min(z, f.elevation), 0)) - 2.5 : reach - 2.5;
      // Every below-grade slab leaves a stratum line on the cut face, so levels you are not standing
      // on still read in section.
      const strata = view.levels.filter(f => f.elevation < 0).map(f => shown(f.elevation));
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
    if (buried && activeF && !walk && (!stack || structureOverview)) {
      const above = view.levels.filter(f => f.elevation > activeF.elevation).sort((a, b) => a.elevation - b.elevation);
      const stride = Math.max(1, Math.ceil((above.length - 1) / (MAX_CAGE_LEVELS - 1)));
      const samples = above.filter((_, i) => i % stride === 0 || i === above.length - 1);
      const rings: THREE.Vector3[][] = [];
      let columns: Point[] = [],
        widest = 0;
      for (const fl of samples) {
        const envelope = index.outlines.get(fl.id);
        if (!envelope) continue;
        const ring = openRing(envelope.rings![0]);
        rings.push(ring.map(pt => new THREE.Vector3(...this.xy(pt), shown(fl.elevation) + LIFT)));
        // The corners the cage stands on are the building's, so they come from its widest storey —
        // and never from a mezzanine, which is a gallery inside a storey and not the storey. Taken
        // from the first level above instead, Herkku caged a hundred-and-ten-metre building in the
        // four corners of the forty-metre -1A gallery standing inside it.
        const area = fl.mezzanine ? 0 : Math.abs(ringArea(ring));
        if (columns.length && area <= widest) continue;
        widest = area;
        const step = Math.max(1, Math.ceil(ring.length / 16));
        columns = ring.filter((_, i) => i % step === 0).map(pt => this.xy(pt));
      }
      const topFl = above.at(-1);
      this.cage.configure(
        rings,
        columns,
        shown(activeF.elevation) + LIFT,
        topFl ? shown(topFl.elevation + topFl.height) : 0,
        evening,
      );
      this.cage.setBearing(this.map?.getBearing() ?? 0);
      this.scene.add(this.cage);
    }
    const fixtureBase = this.present((stack ? (activeF?.elevation ?? 0) : relative(floorId)) + LIFT + SLAB);
    if ((walk || this.hasWater) && floorId) {
      const fixtures = [...(index.objects.get(floorId) ?? []), ...spanningObjects]
        .filter(o => o.kind === 'light' && o.light && (walk || (o.light.mountHeight ?? 0) < 0))
        .map(o => (o.floorId === floorId ? o : { ...o, height: o.height + relative(o.floorId) }));
      if (fixtures.length)
        this.fixtureLights = new FixtureLights(this.scene, fixtures, pt => this.xy(pt), fixtureBase, this.materials);
    }
    this.batch.finish(this.scene);
    if (this.hasWater && floorId)
      applyPoolCaustics(this.scene, project, floorId, point => this.xy(point), fixtureBase, this.waterTime);
    // Sort the stack around the storey in focus. This is the thing that was actually hiding it.
    //
    // A batch merges everything sharing a material into one mesh at the scene origin, so three.js's
    // painter sort — which orders transparent objects by their origin's view depth — sees every mesh
    // at the same depth and falls through to the order they were created in. The active storey's
    // plate is transparent AND keeps depthWrite on (it has to occlude its own walls' hidden faces),
    // and it happened to be created before the ghost meshes. It therefore stamped the depth buffer
    // over its whole footprint before a single ghost was drawn, and every storey underneath was
    // depth-rejected: sixteen plans, built, blended with nothing, thrown away. "All floors" showed
    // one floor because the other sixteen were behind a depth test they could not pass.
    //
    // Nothing here can sort per fragment — a merged mesh is one draw — but a stack does not need it
    // to: the one plane everything is either above or below is the active plate. So the ghosts under
    // it draw first, the plate over them, and the ghosts above it last, which is back-to-front for
    // the only camera this view has. Ghosts write no depth, so ordering them occludes nothing; it
    // only decides what blends over what. A mesh that straddles the plate — a shaft running the
    // height of the building — goes under it, where it belongs for most of its length.
    if (stack && activeF)
      for (const mesh of this.scene.children)
        if (mesh instanceof THREE.Mesh) {
          const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
          if (!material.transparent || material.depthWrite) continue;
          mesh.geometry.computeBoundingBox();
          mesh.renderOrder = (mesh.geometry.boundingBox?.min.z ?? 0) >= this.present(activeF.elevation) ? 1 : -1;
        }
    if (!buried) {
      // Receive shadows on the actual map without replacing its roads, labels or ground colour.
      const bounds = new THREE.Box3().setFromObject(this.scene);
      if (!bounds.isEmpty()) {
        const size = bounds.getSize(new THREE.Vector3()),
          center = bounds.getCenter(new THREE.Vector3());
        const reach = Math.max(24, size.z * 4);
        const shadowPlane = new THREE.Mesh(
          new THREE.PlaneGeometry(size.x + reach * 2, size.y + reach * 2),
          new THREE.ShadowMaterial({
            color: evening ? '#282637' : '#3d4950',
            // A weak sun casts a weak shadow. Held at a fixed darkness, a midwinter noon threw a
            // shadow as black as midsummer's across a city it was barely lighting.
            opacity: evening ? 0.34 : 0.1 + 0.2 * air.day,
            depthWrite: false,
          }),
        );
        // It is the ground, so it lies where the ground lies: at grade, which a walk has moved.
        shadowPlane.position.set(center.x, center.y, ground + 0.012);
        shadowPlane.layers.set(OUTSIDE);
        shadowPlane.receiveShadow = true;
        shadowPlane.raycast = () => {};
        this.scene.add(shadowPlane);
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
      if (object.userData.entityId || object.userData.entityIds || object.userData.spans) this.pickables.push(object);
    });
    this.buildRoute(); // disposeScene swept the previous route group's resources with the scene
    this.refreshShadows();
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
  /** The track's texture already carries the green and the white kerb, so the material's own colour
   *  stays white and only emphasis separates the step being walked from the rest of the path. A
   *  route is one route: dimming the other steps says "later", where recolouring them would say
   *  "different". */
  private routeStyle(step: number) {
    return { opacity: this.routeStep === null || step === this.routeStep ? 1 : 0.5 };
  }
  private restyleRoute() {
    this.routeGroup?.traverse(o => {
      if (o instanceof THREE.Mesh)
        (o.material as THREE.MeshBasicMaterial).opacity = this.routeStyle(o.userData.step as number).opacity;
    });
  }
  private buildRoute() {
    this.clipBoundsDirty = true;
    // update() clears every rig before it rebuilds, but setRoute() rebuilds on its own — without
    // this, changing destination leaves the old rig scrolling a texture on a disposed group.
    this.rigs = this.rigs.filter(r => r.id !== ROUTE_RIG);
    this.rigState.delete(ROUTE_RIG);
    if (this.routeGroup) {
      this.routeGroup.removeFromParent();
      this.routeGroup.traverse(o => {
        if (o instanceof THREE.Mesh) {
          o.geometry.dispose();
          (o.material as THREE.Material).dispose();
        }
      });
      this.routeTile?.dispose();
      this.routeTile = null;
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
        ? // Out of doors is grade, and a walk has moved grade — see sceneGround.
          this.ground + GROUND + 0.05
        : this.present((this.stack ? (floors.get(fid)?.elevation ?? 0) : this.rebase) + LIFT + SLAB + ROOM + 0.07);
    const group = new THREE.Group();
    const steps = legStepIndices(route);
    // One texture for the whole route, tiled along it by the ribbon's metre-counting UVs. Built per
    // build rather than cached: disposeScene sweeps the group with the scene, and a shared texture
    // that outlived one of those would be disposed under the next route.
    const tile = new THREE.DataTexture(
      new Uint8Array(routeTrackImage(this.mapStyle.routeActive ?? ROUTE_COLOR).data.buffer),
      TRACK_PIXELS[0],
      TRACK_PIXELS[1],
      THREE.RGBAFormat,
    );
    tile.wrapS = THREE.RepeatWrapping;
    tile.colorSpace = THREE.SRGBColorSpace;
    // Mipmapped and anisotropic: the track runs away to the horizon at eye level, and the far half of
    // it is all grazing angle — which is where a sharp tile stops being sharp and starts sparkling.
    tile.generateMipmaps = true;
    tile.minFilter = THREE.LinearMipmapLinearFilter;
    tile.magFilter = THREE.LinearFilter;
    tile.anisotropy = Math.min(8, this.renderer?.capabilities.getMaxAnisotropy() ?? 1);
    tile.needsUpdate = true;
    const mesh = (geometry: THREE.BufferGeometry, step: number, tracked = true) => {
      const m = new THREE.Mesh(
        geometry,
        new THREE.MeshBasicMaterial({
          color: tracked ? '#ffffff' : (this.mapStyle.routeActive ?? ROUTE_COLOR),
          map: tracked ? tile : null,
          opacity: this.routeStyle(step).opacity,
          transparent: true,
          depthWrite: false,
          side: THREE.DoubleSide,
        }),
      );
      m.renderOrder = 10;
      m.raycast = () => {};
      m.userData.step = step;
      group.add(m);
    };
    let run: { step: number; fid: string | null; points: Point[] } | null = null;
    const flush = () => {
      if (run && run.points.length > 1 && visible(run.fid)) {
        // 1.4 m of track. At 0.44 m the route was a stripe drawn on the floor; at eye level in walk
        // mode a stripe is something you stand beside, and a track is something you stand on.
        const g = this.ribbonGeometry(run.points, zOf(run.fid), 0.7);
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
          mesh(g, step, false);
        } else if (leg.from.floorId === this.activeFloor || leg.to.floorId === this.activeFloor) {
          // shaft marker disc on the visible floor
          const g = new THREE.CylinderGeometry(0.8, 0.8, 0.05, 28);
          g.rotateX(Math.PI / 2);
          g.translate(x, y, zOf(this.activeFloor) + 0.02);
          mesh(g, step, false);
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
    if (!group.children.length) {
      tile.dispose();
      return;
    }
    this.routeGroup = group;
    this.routeTile = tile;
    // Scrolling the tile IS the animation: one tile per TRACK_TILE metres, so a full cycle is one
    // arrow's worth of travel and the band never appears to jump. Negative, because u grows towards
    // the destination and the arrows have to march that way rather than back down the corridor.
    this.rig(
      ROUTE_RIG,
      group,
      1,
      0.55, // cycles a second: one arrow-length every ~1.8 s, a walking pace rather than a barber's pole
      (_, v) => {
        tile.offset.x = -v;
      },
      true,
    );
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
      uvs: number[] = [],
      indices: number[] = [];
    // u counts metres walked, not vertices: the arrows have to be evenly spaced along the path, and
    // a long straight run and a tight corner are the same number of vertices and very different
    // distances. v crosses the ribbon, so the texture's own top and bottom edges are the track's.
    let run = 0;
    for (let i = 0; i < pts.length; i++) {
      if (i) run += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
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
      uvs.push(run / TRACK_TILE, 0, run / TRACK_TILE, 1);
      if (i) {
        const b = i * 2;
        indices.push(b - 2, b - 1, b, b - 1, b + 1, b);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
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
  render(gl: WebGLRenderingContext | WebGL2RenderingContext, args: CustomRenderMethodInput) {
    if (!this.renderer) return;
    // The model draws over the map, and the only way to say so is to throw away the depth the map
    // has written before us.
    //
    // MapLibre gives every style layer a slice of the depth buffer by its position in the list and
    // draws its opaque fills into it; a custom layer is handed the buffer as it stands and its own
    // geometry is depth-tested against those slices. Our heights are metres above the ground, not
    // slices, so which of the two wins is a matter of camera pitch and zoom rather than of layer
    // order — and it showed: a floor plate would lose to a land-use polygon and vanish, leaving a
    // slab of flat basemap colour inside the building while the walls, whose faces happened to land
    // on the near side of the contest, stayed put. Clearing the depth buffer settles it. Everything
    // the map has drawn is behind us by construction, which is what being the last layer means.
    gl.clear(gl.DEPTH_BUFFER_BIT);
    const now = performance.now();
    if (this.hasWater) {
      this.waterTime.value = now / 1000;
      this.paintSoon();
    }
    // Capped so a backgrounded tab does not resume by teleporting every car a hundred metres.
    const elapsed = Math.min(0.1, this.lastFrame ? (now - this.lastFrame) / 1000 : 0);
    this.lastFrame = now;
    if (this.rigs.length && this.animate(elapsed)) {
      if (this.shadowsMoved) this.refreshShadows();
      // A moving part asks for the next frame, and asking every frame pins a scene of a thousand
      // draw calls at the display's refresh rate for as long as one escalator is running. Measured,
      // the rig itself costs nothing — the cost is the repaint it demands. A step band travels half
      // a metre a second, so it reads as continuous well under 60 Hz; the settling rigs (a lift car,
      // a door leaf) are short and keep the full rate. Repainting on a timer rather than immediately
      // is what hands the idle frames back.
      if (this.shadowsMoved) this.map?.triggerRepaint();
      else this.paintSoon();
    }
    if (this.growth < 1) {
      this.growth = Math.min(1, (performance.now() - this.growthStart) / 550);
      this.scene.scale.z = 0.03 + 0.97 * (1 - (1 - this.growth) ** 3);
      this.refreshShadows();
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
    if (this.fixtureLights) {
      const { shadowsChanged, animate } = this.fixtureLights.update(this.camera.position, now / 1000);
      if (shadowsChanged) this.renderer.shadowMap.needsUpdate = true;
      if (animate) this.paintSoon();
    }
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
  /** Where a point on a floor's walking surface lands on screen — the avatar marker, which is not an
   *  object and has no occlusion to test. `visible` is the frustum only. */
  projectPoint(pt: Point, floorId: string | null): { x: number; y: number; visible: boolean } | null {
    if (!this.project || !this.map) return null;
    const z =
      (this.stack ? (floorIndex(this.project).floors.get(floorId ?? '')?.elevation ?? 0) : floorId ? this.rebase : 0) +
      wallBase(floorId);
    const p = new THREE.Vector3(...this.xy(pt), this.present(z) * this.scene.scale.z).applyMatrix4(this.worldToClip);
    return {
      x: ((p.x + 1) / 2) * this.map.getCanvas().clientWidth,
      y: ((1 - p.y) / 2) * this.map.getCanvas().clientHeight,
      visible: Math.abs(p.x) <= 1.05 && Math.abs(p.y) <= 1.05 && p.z < 1 && p.z > -1,
    };
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
      (!this.walking || this.camera.position.distanceTo(target) <= 12) &&
      (!this.buried || o.floorId !== null) &&
      (!this.stack || o.floorId === null || o.floorId === this.activeFloor);
    if (visible && (this.stack || this.walking)) {
      // Occlusion is by far the most expensive thing per marker — a ray against every pickable mesh.
      // While the camera is in motion, reuse the last verdict: markers shift by a few pixels a frame
      // and re-deriving this for hundreds of them was costing more than the rest of the frame put
      // together. It refreshes as soon as the camera stops.
      const settled = !this.map.isMoving();
      const cachedOcclusion = this.occlusionCache.get(o.id);
      // At eye level, a single step can put a wall in front of a marker. Nearby markers are few,
      // so test them on each new camera frame instead of carrying a stale visibility verdict.
      if (!this.walking && !settled && cachedOcclusion !== undefined) visible = cachedOcclusion;
      else {
        const near = new THREE.Vector3(p.x, p.y, -1).applyMatrix4(this.clipToWorld);
        const length = near.distanceTo(target);
        const clearance = (this.present(z) - this.present(z - 0.25)) * this.scene.scale.z;
        const ray = new THREE.Raycaster(near, target.clone().sub(near).normalize(), 0, Math.max(0, length - clearance));
        ray.layers.enableAll();
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
    raycaster.layers.enableAll();
    return raycaster.intersectObjects(this.pickables, false).map(hitEntity).find(Boolean) ?? null;
  }
  private disposeScene() {
    this.hasWater = false;
    this.fixtureLights = undefined;
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
    // The track texture is not a shared material and nothing above sweeps a map off one, so it has to
    // be let go here too — a route rebuilt on every floor switch would otherwise leak a texture a time.
    this.routeTile?.dispose();
    this.routeTile = null;
    this.routeGroup = null;
  }
  onRemove() {
    clearTimeout(this.loopTimer);
    this.loopTimer = undefined;
    this.disposeScene();
    this.materials.dispose();
    this.envCache.forEach(target => target.dispose());
    this.envCache.clear();
    // dispose() frees Three's programs/listeners; it does not lose the shared context. Never call
    // forceContextLoss(). Reset the GL bindings before handing the context back to MapLibre.
    this.renderer?.resetState();
    this.renderer?.dispose();
    this.renderer = undefined;
    this.map = undefined;
  }
}
