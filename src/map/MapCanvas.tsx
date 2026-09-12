import { useEffect, useMemo, useRef, useState } from 'react';
import maplibregl, {
  type ExpressionSpecification,
  type FilterSpecification,
  type GeoJSONSource,
  type ImageSource,
  type Map as GLMap,
} from 'maplibre-gl';
import { Compass, LocateFixed, Minus, Mountain, Plus, RotateCcw, RotateCw } from 'lucide-react';
import polygonClipping from 'polygon-clipping';
import {
  isSpace,
  type AssetRepository,
  type Point,
  type ProjectDocument,
  type SiteObject,
  type Tool,
} from '../model/types';
import type { StatusReading } from '../model/live';
import type { BasemapConfig } from '../model/host';
import {
  add,
  barrierEnds,
  segmentProjection,
  closeRing,
  drawingCorners,
  objectArea,
  objectPosition,
  openRing,
  pointInRing,
  ringArea,
  rotate,
  toLngLat,
  toLocal,
} from '../model/geometry';
import { statusLabel, statusTone } from '../adapters/status';
import { useKerrosTheme, useStrings, type MapStyleOptions } from '../theme';
import { neutralBasemap } from '../adapters/basemap';
import { ambient, mixColor, type Sun, sunlight } from './lighting';
import { EntityIcon } from '../components/Icons';
import { draftFeatures, makeFeatures, navGraphFeatures, onFloor, visibleOnFloor, wallPieces } from './features';
import { routeArrowImage, routeFeatures } from './route';
import { aimCenter, JourneyPlayer } from './journey';
import type { Route } from '../model/navigation';
import { LIFT, SceneLayer, SLAB } from './SceneLayer';
import { EYE, HEAD_ROOM, unstick, WalkController, type WalkPose } from './walk';
import { inSpace, spaceAt, spacePoint } from '../model/spaces';
import { servedFloors } from '../model/vertical';
import { undergroundView } from './underground';
import { loadBasemap } from './loadBasemap';

// Cadastral parcels come from a host-declared vector tilejson (see BasemapVectorSchema.cadastre):
// parcel polygons, boundary lines/markers and parcel-id labels styled per theme.
// The tilejson describes the {z}/{y}/{x} template; transformRequest appends the api-key.
export interface MapCanvasProps {
  project: ProjectDocument;
  canEdit: boolean;
  floorId: string | null;
  selected: string | null;
  tool: Tool;
  draft: Point[];
  hover: Point | null;
  /** Alignment hints drawn under the draft: the axis a wall is being held to, or a whole segment
   *  the tool is offering. Both are previews — nothing here exists in the document yet. */
  guides?: { line: [Point, Point]; role: 'guide' | 'proposal' }[];
  threeD: boolean;
  stack: boolean;
  coverage: boolean;
  showLabels: boolean;
  showPlan: boolean;
  /** Where the sun stands over this project now. Carries its own `evening` for the dusk look. */
  sun: Sun;
  dark: boolean;
  cityBuildings: boolean;
  cadastre: boolean;
  basemap?: BasemapConfig;
  assets: AssetRepository;
  statuses: Map<string, StatusReading>;
  /** Draw the soil section around below-grade floors. */
  excavation?: boolean;
  /** First-person walk mode: the camera becomes a person standing on `floorId`. Requires threeD.
   *  While it is on the map's own gestures are off and the floor is drawn at ground level. */
  walk?: boolean;
  /** Walk mode wants out (Escape with nothing else to release). */
  onWalkExit?: () => void;
  focusId?: string | null;
  alignment?: { image: Point[]; map: Point[] };
  /** Exact camera to restore (deep links); suppresses the automatic fit and 3D tilt-in on load. */
  initialCamera?: { center: [number, number]; zoom: number; bearing: number; pitch: number };
  route?: Route | null; // render route in 2D + 3D whenever set
  activeStep?: number | null; // emphasised step
  playing?: boolean; // journey animation on/off
  onJourneyStep?: (index: number) => void; // fired as the camera reaches each step
  onJourneyEnd?: () => void; // journey finished or was cancelled by user gesture
  onRequestFloor?: (floorId: string | null) => void; // journey asks the app to switch floors
  onClick: (point: Point, entityId: string | null) => void;
  onHover: (point: Point, tolerance: number) => void;
  onAdopt?: (adopted: { rings: Point[][]; sourceId: string | number; storeys: number; name: string }) => void;
  // Method syntax keeps a host handler with the pre-'node' union assignable while A-workstreams land.
  onSelect: (id: string) => void;
  onHoverObject?: (id: string | null) => void;
  onVertexMove(
    kind: 'junction' | 'ring' | 'object' | 'barrier' | 'node' | 'opening' | 'rotate' | 'coverage',
    id: string,
    point: Point,
    ring?: number,
    vertex?: number,
    /** Shift was held on release: take the drop exactly as given, ignoring any snapping. */
    free?: boolean,
  ): void;
  onError: (message: string) => void;
  onReady?: (map: GLMap) => void;
}
const EMPTY_FEATURES: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };
const DIM_FEATURES: GeoJSON.FeatureCollection = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: {},
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [-180, -85],
            [180, -85],
            [180, 85],
            [-180, 85],
            [-180, -85],
          ],
        ],
      },
    },
  ],
};

function planFeatures(p: MapCanvasProps, mapStyle?: MapStyleOptions): GeoJSON.FeatureCollection {
  // Three owns the plan in 3D. Status updates must not rebuild hidden 2D geometry in a worker.
  if (p.threeD) return EMPTY_FEATURES;
  const entities = makeFeatures(p.project, p.floorId, p.selected, p.coverage, p.statuses, mapStyle);
  // An intermediate (mezzanine) level draws in context: the level below stays visible dimmed
  // under its own rooms and the level above appears as a faint dashed outline.
  const activeFloor = p.project.floors.find(f => f.id === p.floorId);
  if (activeFloor?.mezzanine && !p.threeD) {
    const band = p.project.floors.filter(f => f.buildingId === activeFloor.buildingId && f.id !== activeFloor.id);
    const lower = band.filter(f => f.elevation < activeFloor.elevation).sort((a, b) => b.elevation - a.elevation)[0];
    const upper = band.filter(f => f.elevation > activeFloor.elevation).sort((a, b) => a.elevation - b.elevation)[0];
    const ctx = (fl: typeof lower, level: string, walls: boolean) =>
      fl
        ? makeFeatures(p.project, fl.id, null, false)
            .features.filter(
              f =>
                f.properties?.floorId === fl.id &&
                !f.properties.decoration &&
                (walls || f.properties.kind !== 'wall') &&
                f.geometry.type === 'Polygon',
            )
            .map(f => ({ ...f, properties: { kind: f.properties!.kind, color: f.properties!.color, context: level } }))
        : [];
    entities.features = [...ctx(lower, 'lower', true), ...entities.features, ...ctx(upper, 'upper', false)];
  }
  return entities;
}

/** The map heading that puts the plan square on screen.
 *
 *  A project's local frame is already turned by its origin bearing, so a site laid out along its
 *  street has axis-aligned coordinates and a heading to match. Opening the map due north then shows
 *  that plan standing at an angle — and every "reset north" put it back at that angle. The frame the
 *  drawing was made in is the one to read it in, so north-up means site-up. A project with no
 *  bearing is unaffected: its frame IS north. */
const siteBearing = (project: ProjectDocument) => project.origin[2] ?? 0;
/** What walk mode tells the person walking: where they are, and what the level keys would do here. */
interface WalkHint {
  looking: boolean;
  up: string | null;
  down: string | null;
  where: string;
}
const NO_HINT: WalkHint = { looking: false, up: null, down: null, where: '' };

export function MapCanvas(props: MapCanvasProps) {
  const container = useRef<HTMLDivElement>(null),
    map = useRef<GLMap | null>(null),
    scene = useRef<SceneLayer | null>(null),
    latest = useRef(props),
    urls = useRef(new Map<string, string>());
  latest.current = props;
  const [ready, setReady] = useState(false),
    [frame, setFrame] = useState(0),
    [mapError, setMapError] = useState(''),
    [pitch, setPitch] = useState(0);
  const suppressClick = useRef(false),
    overlay = useRef<HTMLDivElement>(null),
    hoverId = useRef<string | null>(null);
  const styleReady = useRef(false);
  const mapStyle = useKerrosTheme().mapStyle;
  const mapStyleRef = useRef(mapStyle);
  mapStyleRef.current = mapStyle;
  const strings = useStrings().map;
  const stringsRef = useRef(strings);
  stringsRef.current = strings;
  const entityFeatures = useMemo(
    () => planFeatures(props, mapStyle),
    [
      props.project,
      props.floorId,
      props.selected,
      props.coverage,
      props.threeD,
      props.threeD ? null : props.statuses,
      mapStyle,
    ],
  );
  const draftData = useMemo(
    () => draftFeatures(props.project, props.draft, props.hover, props.tool) as GeoJSON.FeatureCollection,
    [props.project, props.draft, props.hover, props.tool],
  );
  const guideData = useMemo<GeoJSON.FeatureCollection>(
    () => ({
      type: 'FeatureCollection',
      features: (props.guides ?? []).map(g => ({
        type: 'Feature' as const,
        properties: { role: g.role },
        geometry: { type: 'LineString' as const, coordinates: g.line.map(pt => toLngLat(pt, props.project.origin)) },
      })),
    }),
    [props.guides, props.project.origin],
  );
  // 'route' joins the Tool union in the authoring workstream; the cast keeps this file self-contained.
  const routeTool = (props.tool as string) === 'route';
  const navSelected =
    !!props.selected &&
    (!!props.project.navNodes?.some(n => n.id === props.selected) ||
      !!props.project.navEdges?.some(e => e.id === props.selected));
  const routeData = useMemo(
    () =>
      props.route && !props.threeD
        ? (routeFeatures(
            props.project,
            props.route,
            props.floorId,
            props.activeStep ?? null,
          ) as GeoJSON.FeatureCollection)
        : EMPTY_FEATURES,
    [props.project, props.route, props.floorId, props.activeStep, props.threeD],
  );
  const navGraphData = useMemo(
    () =>
      !props.threeD && props.canEdit && (routeTool || navSelected)
        ? (navGraphFeatures(props.project, props.floorId, props.selected) as GeoJSON.FeatureCollection)
        : EMPTY_FEATURES,
    [props.project, props.floorId, props.selected, props.threeD, props.canEdit, routeTool, navSelected],
  );
  const entityData = useRef(entityFeatures),
    draftSourceData = useRef(draftData),
    routeSourceData = useRef(routeData),
    guideSourceData = useRef(guideData),
    navSourceData = useRef(navGraphData);
  entityData.current = entityFeatures;
  draftSourceData.current = draftData;
  guideSourceData.current = guideData;
  routeSourceData.current = routeData;
  navSourceData.current = navGraphData;
  const journey = useRef<JourneyPlayer | null>(null);
  const appliedSourceData = useRef(new Map<string, GeoJSON.FeatureCollection>());
  const objectsById = useMemo(() => new Map(props.project.objects.map(o => [o.id, o])), [props.project]);
  const objectIndex = useRef(objectsById);
  objectIndex.current = objectsById;
  const clampTooltip = (e: { currentTarget: HTMLElement }) => {
    const tip = e.currentTarget.querySelector<HTMLElement>('.marker-tooltip');
    const wrap = container.current;
    if (!tip || !wrap) return;
    const w = wrap.getBoundingClientRect(),
      r = e.currentTarget.getBoundingClientRect(),
      half = tip.offsetWidth / 2 + 10;
    tip.classList.toggle('flip-y', r.top - w.top < tip.offsetHeight + 24);
    tip.classList.toggle('nudge-left', r.left + half > w.right);
    tip.classList.toggle('nudge-right', r.left - half < w.left);
  };
  // Overlay symbols follow the camera imperatively so they never trail a pan while React catches up.
  const reposition = () => {
    const m = map.current,
      el = overlay.current,
      p = latest.current;
    if (!m || !el) return;
    const byId = objectIndex.current;
    for (const child of Array.from(el.children) as HTMLElement[]) {
      const { wx, wy, oid } = child.dataset;
      if (wx === undefined || wy === undefined) continue;
      if (p.threeD && oid) {
        const o = byId.get(oid);
        const s = o && scene.current?.projectObject(o);
        if (s) {
          child.style.left = `${s.x}px`;
          child.style.top = `${s.y}px`;
          child.style.visibility = s.visible ? '' : 'hidden';
        }
      } else {
        const s = m.project(toLngLat([Number(wx), Number(wy)], p.project.origin));
        child.style.left = `${s.x}px`;
        child.style.top = `${s.y}px`;
        child.style.visibility = '';
      }
    }
  };
  // Basemap buildings adopted into the project or standing under a project parcel are excluded
  // from the generic city massing — the project's own model renders there instead.
  const cityHidden = useRef('');
  // Accumulated, never rebuilt from scratch. The set is discovered by querying the tiles that happen
  // to be loaded, and tiles come and go: rebuilt each pass, a footprint identified a moment ago as
  // standing under the project's own parcel would be forgotten the moment its tile unloaded, the
  // filter would widen again, and the city massing would be drawn back over the model — which, since
  // an extrusion writes depth, swallows the floor plate whole and leaves a building with a hole in
  // it. Once a footprint is known to be ours it stays ours. Cleared with the style.
  const cityIds = useRef(new Set<string | number>());
  /** The basemap's own footprint layers, with the filter each carried before we narrowed it. */
  const footprintFilters = useRef(new Map<string, unknown>());
  const refreshCityFilter = () => {
    const m = map.current,
      p = latest.current;
    const fp = p.basemap?.vectorSchema?.footprints;
    if (!m || !fp || !m.getLayer('kerros-city-3d')) return;
    // Out of 3D the model is not standing there, so the basemap's building is the only one there is
    // and gets its own filter back. The massing layer's own visibility already follows the toggle,
    // so narrowing it costs nothing — but the flat fill has to be narrowed whatever the toggle says,
    // or turning the city massing off would bring the box back with it.
    if (!p.threeD || undergroundView(p.project, p.floorId, p.stack).buried) {
      for (const [id, was] of footprintFilters.current)
        if (m.getLayer(id)) m.setFilter(id, (was ?? undefined) as FilterSpecification | undefined);
      footprintFilters.current.clear();
      cityHidden.current = '';
      return;
    }
    const source = (m.getLayer('kerros-city-3d') as unknown as { source: string }).source;
    const parcels = p.project.objects.filter(o => o.kind === 'parcel' && o.rings);
    const ids = cityIds.current;
    for (const b of p.project.buildings) if (b.sourceId !== undefined) ids.add(b.sourceId);
    for (const f of m.querySourceFeatures(source, { sourceLayer: fp.sourceLayer })) {
      const fid = f.properties?.[fp.idField] as string | number | undefined;
      if (fid === undefined || ids.has(fid)) continue;
      const g = f.geometry;
      const ring = g.type === 'Polygon' ? g.coordinates[0] : g.type === 'MultiPolygon' ? g.coordinates[0][0] : null;
      if (!ring) continue;
      const c = ring.reduce<Point>((s, pt) => [s[0] + pt[0] / ring.length, s[1] + pt[1] / ring.length], [0, 0]);
      const local = toLocal(c, p.project.origin);
      if (parcels.some(o => pointInRing(local, o.rings![0]))) ids.add(fid);
    }
    const next = JSON.stringify([...ids].sort());
    if (next === cityHidden.current) return;
    cityHidden.current = next;
    const mine = ['!', ['in', ['get', fp.idField], ['literal', [...ids]]]] as unknown as FilterSpecification;
    m.setFilter('kerros-city-3d', mine);
    // And out of the basemap's own flat building fill, which is the half of this that was missed.
    // A vector style paints its buildings as an opaque fill, and an opaque fill is drawn in a pass
    // of its own that writes depth — so however late the model's layer is added, the basemap's
    // building can still win over the floor plate inside it, while the walls, standing on the
    // footprint's edge, survive. That is the box of flat basemap colour over the building: the plan
    // is not missing, the map is drawn on top of it. Where our own model stands, the basemap's
    // building has nothing left to say.
    for (const layer of m.getStyle().layers) {
      if (layer.id === 'kerros-city-3d' || !('source-layer' in layer) || layer['source-layer'] !== fp.sourceLayer)
        continue;
      if (!footprintFilters.current.has(layer.id))
        footprintFilters.current.set(layer.id, m.getFilter(layer.id) ?? null);
      const was = footprintFilters.current.get(layer.id) as FilterSpecification | null;
      m.setFilter(layer.id, (was ? ['all', was, mine] : mine) as FilterSpecification);
    }
  };
  // Adopt tool: turn the clicked basemap building footprint (all tile pieces, unioned) into local
  // rings, carrying its stable source id so the grey massing hides once our own model exists.
  const adoptAt = (point: { x: number; y: number }) => {
    const m = map.current,
      p = latest.current;
    const fp = p.basemap?.vectorSchema?.footprints;
    if (!m || !fp) return;
    const layers = m
      .getStyle()
      .layers.filter(l => 'source-layer' in l && l['source-layer'] === fp.sourceLayer && l.id !== 'kerros-city-3d')
      .map(l => l.id);
    const hit = layers.length
      ? m
          .queryRenderedFeatures(
            [
              [point.x - 3, point.y - 3],
              [point.x + 3, point.y + 3],
            ],
            { layers },
          )
          .find(f => f.properties?.[fp.idField] !== undefined)
      : undefined;
    if (!hit) {
      p.onError(stringsRef.current.adoptMiss);
      return;
    }
    const id = hit.properties[fp.idField] as string | number;
    const polys: Point[][][] = [];
    for (const f of m.queryRenderedFeatures(undefined, {
      layers,
      filter: ['==', ['get', fp.idField], id] as unknown as FilterSpecification,
    })) {
      const g = f.geometry;
      if (g.type === 'Polygon') polys.push(g.coordinates.map(r => r.map(pt => toLocal(pt as Point, p.project.origin))));
      else if (g.type === 'MultiPolygon')
        for (const poly of g.coordinates)
          polys.push(poly.map(r => r.map(pt => toLocal(pt as Point, p.project.origin))));
    }
    try {
      const union = polygonClipping.union(...(polys.map(poly => [poly]) as [Point[][][]]));
      const best = ([...union] as Point[][][]).sort((a, b) => ringArea(b[0] as Point[]) - ringArea(a[0] as Point[]))[0];
      // Tile geometry is quantised; drop micro-edges so wall segments stay valid and clean.
      const tidy = (ring: Point[]) => {
        const out: Point[] = [];
        for (const pt of openRing(ring))
          if (!out.length || Math.hypot(pt[0] - out[out.length - 1][0], pt[1] - out[out.length - 1][1]) > 0.2)
            out.push(pt);
        while (
          out.length > 2 &&
          Math.hypot(out[0][0] - out[out.length - 1][0], out[0][1] - out[out.length - 1][1]) < 0.2
        )
          out.pop();
        return out;
      };
      const rings = best.map(tidy).filter(r => r.length >= 3);
      if (!rings.length) throw new Error('degenerate footprint');
      p.onAdopt?.({
        rings,
        sourceId: id,
        storeys: fp.storeys?.(hit.properties) ?? 1,
        name: fp.name?.(hit.properties) ?? 'City building',
      });
    } catch {
      p.onError(stringsRef.current.adoptFail);
    }
  };
  // Draft/hover geometry is a handful of points; updating it must never rebuild the whole plan.
  const syncDraft = () => {
    const m = map.current;
    if (!styleReady.current || !m?.getSource('kerros-draft')) return;
    for (const [name, data] of [
      ['kerros-draft', draftSourceData.current],
      ['kerros-guide', guideSourceData.current],
    ] as const) {
      (m.getSource(name) as GeoJSONSource).setData(data);
      appliedSourceData.current.set(name, data);
    }
  };
  const sync = () => {
    const m = map.current,
      p = latest.current;
    // style.load means layers can be added. isStyleLoaded() also waits for external tiles and
    // would incorrectly hide the plan while MML resources are pending or unavailable.
    if (!m || !styleReady.current) return;
    // Adding a source/layer throws while a freshly-swapped style is still resolving its own
    // sources; that must never abort the plan build. Retry once the map settles.
    try {
      syncLayers(m, p);
    } catch {
      m.once('idle', sync);
    }
  };
  const syncLayers = (m: GLMap, p: MapCanvasProps) => {
    // setStyle(diff:false) wipes registered images on every basemap swap; re-add here, not at mount.
    if (!m.hasImage('kerros-route-arrow')) m.addImage('kerros-route-arrow', routeArrowImage());
    const sources = {
      dim: DIM_FEATURES,
      entities: entityData.current,
      draft: draftSourceData.current,
      guide: guideSourceData.current,
      route: routeSourceData.current,
      navgraph: navSourceData.current,
    };
    for (const [id, data] of Object.entries(sources)) {
      const name = `kerros-${id}`;
      if (!m.getSource(name)) m.addSource(name, { type: 'geojson', data });
      else if (appliedSourceData.current.get(name) !== data) (m.getSource(name) as GeoJSONSource).setData(data);
      appliedSourceData.current.set(name, data);
    }
    if (!m.getLayer('kerros-areas')) {
      // Selection/hover/draft highlight colours come from the theme's mapStyle (host-brandable),
      // falling back to the built-in indigo.
      const ms = mapStyleRef.current;
      const sel = ms?.selection ?? '#5a52d5';
      const selFill = ms?.selectionFill ?? '#c8c4f5';
      const hoverColor = ms?.hover ?? sel;
      const draftColor = ms?.draft ?? sel;
      // Area fill opacity as a pure data expression, parameterised by what a `small` feature gets at
      // this zoom stop. Kept as a function so the two zoom stops cannot drift apart.
      const areaOpacity = (small: number): ExpressionSpecification =>
        [
          'case',
          ['==', ['get', 'kind'], 'coverage'],
          0.13,
          ['==', ['get', 'kind'], 'status-halo'],
          0.22,
          ['==', ['get', 'context'], 'lower'],
          0.35,
          ['==', ['get', 'context'], 'upper'],
          0,
          ['==', ['get', 'selected'], true],
          1,
          ['==', ['get', 'small'], true],
          small,
          1,
        ] as ExpressionSpecification;
      // Two-basemap composition: the real taustakartta below everything, and an opaque
      // architectural "drawing paper" clipped to the premises parcel above it. In dark mode a
      // translucent veil dims the basemap so the plan stays the brightest surface.
      m.addLayer({
        id: 'kerros-dim',
        type: 'fill',
        source: 'kerros-dim',
        paint: { 'fill-color': '#0d0f16', 'fill-opacity': 0.55 },
      });
      // Below-ground floors bury the basemap: streets, water and city context read as soil.
      m.addLayer({
        id: 'kerros-underground',
        type: 'fill',
        source: 'kerros-dim',
        paint: { 'fill-color': '#262320', 'fill-opacity': 0.985 },
      });
      m.addLayer({
        id: 'kerros-premises',
        type: 'fill',
        source: 'kerros-entities',
        filter: ['all', ['==', ['geometry-type'], 'Polygon'], ['==', ['get', 'kind'], 'parcel']],
        paint: { 'fill-color': '#f3f4f0', 'fill-opacity': 0.97 },
      });
      m.addLayer({
        id: 'kerros-premises-line',
        type: 'line',
        source: 'kerros-entities',
        filter: ['all', ['==', ['geometry-type'], 'Polygon'], ['==', ['get', 'kind'], 'parcel']],
        paint: { 'line-color': '#9aa0ac', 'line-width': 1.5, 'line-dasharray': [4, 2] },
      });
      m.addLayer({
        id: 'kerros-areas',
        type: 'fill',
        source: 'kerros-entities',
        filter: [
          'all',
          ['==', ['geometry-type'], 'Polygon'],
          ['!=', ['get', 'kind'], 'wall'],
          ['!=', ['get', 'kind'], 'parcel'],
        ],
        paint: {
          'fill-color': ['case', ['==', ['get', 'selected'], true], selFill, ['get', 'color']],
          // Zoom expressions must be the OUTERMOST expression in a paint property — MapLibre throws
          // (and silently drops the whole layer) if one is nested inside a `case`. So the data-driven
          // chain is evaluated at each zoom stop, differing only in what a `small` feature gets.
          'fill-opacity': ['interpolate', ['linear'], ['zoom'], 18.6, areaOpacity(0), 19.6, areaOpacity(1)],
        },
      });
      m.addLayer({
        id: 'kerros-outline',
        type: 'line',
        source: 'kerros-entities',
        filter: [
          'all',
          ['==', ['geometry-type'], 'Polygon'],
          ['!=', ['get', 'kind'], 'furniture'],
          ['!=', ['get', 'kind'], 'parcel'],
          ['!=', ['get', 'context'], 'upper'],
        ],
        paint: {
          'line-color': ['case', ['==', ['get', 'selected'], true], sel, '#a7adbb'],
          'line-width': ['case', ['==', ['get', 'selected'], true], 2, 0.8],
          // A narrow area is only a few pixels wide at building zoom; outlining hundreds of them
          // (a garage of bays, a warehouse of racks) reads as a hatch rather than a plan. Fade them
          // in once they are big enough to tell apart — a selected one always draws.
          'line-opacity': [
            'interpolate',
            ['linear'],
            ['zoom'],
            18.6,
            ['case', ['==', ['get', 'selected'], true], 1, ['==', ['get', 'small'], true], 0, 1],
            19.6,
            1,
          ],
        },
      });
      m.addLayer({
        id: 'kerros-detail',
        type: 'line',
        source: 'kerros-entities',
        filter: ['==', ['geometry-type'], 'LineString'],
        paint: { 'line-color': ['get', 'color'], 'line-width': 1 },
      });
      m.addLayer({
        id: 'kerros-walls',
        type: 'fill',
        source: 'kerros-entities',
        filter: ['==', ['get', 'kind'], 'wall'],
        paint: {
          'fill-color': ['case', ['==', ['get', 'selected'], true], sel, ['get', 'color']],
          'fill-opacity': ['case', ['==', ['get', 'context'], 'lower'], 0.3, 1],
        },
      });
      m.addLayer({
        id: 'kerros-context-upper',
        type: 'line',
        source: 'kerros-entities',
        filter: ['==', ['get', 'context'], 'upper'],
        paint: { 'line-color': '#8b90a0', 'line-width': 1.2, 'line-dasharray': [2, 2] },
      });
      // Dark mode lowers the whole drawing with one veil clipped to the parcel: pastel fills keep
      // their hue but drop enough brightness for the light-on-dark labels to stay legible.
      m.addLayer({
        id: 'kerros-plan-dim',
        type: 'fill',
        source: 'kerros-entities',
        filter: ['all', ['==', ['geometry-type'], 'Polygon'], ['==', ['get', 'kind'], 'parcel']],
        paint: { 'fill-color': '#0d0f16', 'fill-opacity': 0.58 },
      });
      m.addLayer({
        id: 'kerros-hover',
        type: 'line',
        source: 'kerros-entities',
        filter: ['==', ['get', 'id'], ''],
        paint: { 'line-color': hoverColor, 'line-width': 2.5 },
      });
      // Guides sit under the draft: the wall you are drawing should never be hidden by the hint
      // explaining it. line-dasharray is not data-driven, so both roles share one dash and separate
      // on weight and opacity instead.
      m.addLayer({
        id: 'kerros-guide-line',
        type: 'line',
        source: 'kerros-guide',
        paint: {
          'line-color': draftColor,
          'line-width': ['case', ['==', ['get', 'role'], 'proposal'], 3, 1.2],
          'line-opacity': ['case', ['==', ['get', 'role'], 'proposal'], 0.9, 0.45],
          'line-dasharray': [2, 2],
        },
      });
      m.addLayer({
        id: 'kerros-draft-fill',
        type: 'fill',
        source: 'kerros-draft',
        filter: ['==', ['geometry-type'], 'Polygon'],
        paint: { 'fill-color': draftColor, 'fill-opacity': 0.13 },
      });
      m.addLayer({
        id: 'kerros-draft-line',
        type: 'line',
        source: 'kerros-draft',
        paint: { 'line-color': draftColor, 'line-width': 2, 'line-dasharray': [3, 2] },
      });
      // Edit-mode nav graph (route tool): thin dashed edges under small node dots.
      m.addLayer({
        id: 'kerros-navgraph-edge',
        type: 'line',
        source: 'kerros-navgraph',
        filter: ['==', ['geometry-type'], 'LineString'],
        paint: {
          'line-color': [
            'case',
            ['==', ['get', 'selected'], true],
            '#5a52d5',
            ['==', ['get', 'kind'], 'door'],
            '#6a63d8',
            '#8d85dc',
          ],
          'line-width': 1.4,
          // A derived graph is drawn fainter and in longer dashes: it is what the plan implies, not
          // what anyone drew, and the difference matters the moment you start editing it.
          'line-dasharray': ['case', ['==', ['get', 'derived'], true], ['literal', [4, 3]], ['literal', [2, 2]]],
          'line-opacity': ['case', ['==', ['get', 'derived'], true], 0.5, 0.85],
        },
      });
      m.addLayer({
        id: 'kerros-navgraph-node',
        type: 'circle',
        source: 'kerros-navgraph',
        filter: ['==', ['geometry-type'], 'Point'],
        paint: {
          'circle-radius': ['case', ['==', ['get', 'vertical'], true], 5, ['==', ['get', 'bound'], true], 4.5, 3.5],
          'circle-color': [
            'case',
            ['==', ['get', 'selected'], true],
            '#5a52d5',
            ['==', ['get', 'vertical'], true],
            '#567c9a',
            ['==', ['get', 'bound'], true],
            '#6a63d8',
            '#8d85dc',
          ],
          'circle-stroke-width': 1.2,
          'circle-stroke-color': '#ffffff',
          'circle-opacity': ['case', ['==', ['get', 'derived'], true], 0.55, 1],
        },
      });
      // 2D route: casing + accent line + direction chevrons on the current floor, dashed ghost for
      // other floors' segments, circles at vertical transitions. 3D rendering lives in SceneLayer.
      m.addLayer({
        id: 'kerros-route-casing',
        type: 'line',
        source: 'kerros-route',
        filter: ['all', ['==', ['geometry-type'], 'LineString'], ['==', ['get', 'onFloor'], true]],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': '#ffffff',
          'line-width': ['interpolate', ['linear'], ['zoom'], 15, 5, 20, 11],
          'line-opacity': 0.9,
        },
      });
      m.addLayer({
        id: 'kerros-route',
        type: 'line',
        source: 'kerros-route',
        filter: ['all', ['==', ['geometry-type'], 'LineString'], ['==', ['get', 'onFloor'], true]],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': ['case', ['==', ['get', 'active'], true], '#5b50e6', '#8d85dc'],
          'line-width': [
            'interpolate',
            ['linear'],
            ['zoom'],
            15,
            ['case', ['==', ['get', 'active'], true], 3.5, 2.5],
            20,
            ['case', ['==', ['get', 'active'], true], 7.5, 5],
          ],
          'line-opacity': ['case', ['==', ['get', 'active'], true], 1, 0.8],
        },
      });
      m.addLayer({
        id: 'kerros-route-off',
        type: 'line',
        source: 'kerros-route',
        filter: ['all', ['==', ['geometry-type'], 'LineString'], ['!=', ['get', 'onFloor'], true]],
        paint: { 'line-color': '#8d85dc', 'line-width': 1.6, 'line-dasharray': [2, 2], 'line-opacity': 0.35 },
      });
      m.addLayer({
        id: 'kerros-route-arrows',
        type: 'symbol',
        source: 'kerros-route',
        filter: ['all', ['==', ['geometry-type'], 'LineString'], ['==', ['get', 'onFloor'], true]],
        layout: {
          'symbol-placement': 'line',
          'symbol-spacing': 60,
          'icon-image': 'kerros-route-arrow',
          'icon-size': ['interpolate', ['linear'], ['zoom'], 15, 0.5, 20, 0.9],
          'icon-rotation-alignment': 'map',
          'icon-allow-overlap': true,
          'icon-ignore-placement': true,
        },
      });
      m.addLayer({
        id: 'kerros-route-vertical',
        type: 'circle',
        source: 'kerros-route',
        filter: ['==', ['get', 'vertical'], true],
        paint: {
          'circle-radius': ['case', ['==', ['get', 'active'], true], 8, 6],
          'circle-color': ['case', ['==', ['get', 'active'], true], '#5b50e6', '#8d85dc'],
          'circle-stroke-width': 2,
          'circle-stroke-color': '#ffffff',
          'circle-opacity': ['case', ['==', ['get', 'onFloor'], true], 0.95, 0.4],
        },
      });
    }
    const underground = p.showPlan && undergroundView(p.project, p.floorId, p.threeD && p.stack).buried;
    for (const id of [
      'kerros-premises',
      'kerros-premises-line',
      'kerros-areas',
      'kerros-outline',
      'kerros-detail',
      'kerros-walls',
      'kerros-context-upper',
      'kerros-hover',
    ])
      m.setLayoutProperty(id, 'visibility', p.threeD || !p.showPlan ? 'none' : 'visible');
    if (m.getLayer('kerros-underground')) {
      m.setLayoutProperty('kerros-underground', 'visibility', underground && !p.threeD ? 'visible' : 'none');
      m.setPaintProperty('kerros-underground', 'fill-color', '#15130f');
    }
    // Evening lighting used to fall only on the 3D model, so the building sat at dusk inside a map
    // that was still at noon. Dusk is a property of the whole composition, so the basemap is veiled
    // too — lighter than the dark-mode veil, so the city stays legible.
    //
    // Cool, and on a ramp. A warm veil over a basemap whose buildings are already a warm stone read
    // as orange rather than as evening: the city looked lit by a fire rather than unlit by the sun.
    // And it arrived all at once at civil twilight, which is not how an evening happens — it follows
    // the sun down now, so the city loses its light over the hour the sun takes to go.
    const dusk = (1 - ambient(p.sun).day) * (p.dark || underground ? 0 : 1);
    const beam = sunlight(p.sun);
    // The basemap's own light follows the same sun as the model's, so the city's shadows fall the
    // way the building's do instead of the two disagreeing about the time of day.
    m.setLight({
      anchor: 'map',
      position: beam.mapPosition,
      color: beam.color,
      intensity: 0.28 + 0.14 * ambient(p.sun).day,
    });
    // The sky follows the sun down with everything else. Day blue through to an evening violet, over
    // a horizon that warms as the sun reaches it — which is the one part of a dusk that should be
    // warm, and the reason the ground no longer is.
    const daylight = ambient(p.sun).day;
    m.setSky({
      'sky-color': p.dark ? '#172435' : mixColor('#5d6488', '#92b9d2', daylight),
      'horizon-color': p.dark ? '#343b4c' : mixColor('#d9ac92', '#e8e4d9', daylight),
      'sky-horizon-blend': 0.65,
      'atmosphere-blend': p.threeD && !underground ? 0.65 : 0,
    });
    m.setLayoutProperty('kerros-dim', 'visibility', p.dark || underground || dusk > 0.02 ? 'visible' : 'none');
    m.setPaintProperty('kerros-dim', 'fill-color', dusk > 0 ? '#141a2b' : '#0d0f16');
    m.setPaintProperty('kerros-dim', 'fill-opacity', dusk > 0 ? 0.42 * dusk : 0.55);
    m.setPaintProperty('kerros-premises', 'fill-color', p.dark ? '#232734' : '#f3f4f0');
    m.setPaintProperty('kerros-premises-line', 'line-color', p.dark ? '#565d73' : '#9aa0ac');
    m.setLayoutProperty('kerros-plan-dim', 'visibility', p.dark && !p.threeD && p.showPlan ? 'visible' : 'none');
    const routeOn = !p.threeD && !!p.route;
    for (const id of [
      'kerros-route-casing',
      'kerros-route',
      'kerros-route-off',
      'kerros-route-arrows',
      'kerros-route-vertical',
    ])
      m.setLayoutProperty(id, 'visibility', routeOn ? 'visible' : 'none');
    const graphOn =
      !p.threeD &&
      p.canEdit &&
      ((p.tool as string) === 'route' ||
        !!p.project.navNodes?.some(n => n.id === p.selected) ||
        !!p.project.navEdges?.some(e => e.id === p.selected));
    for (const id of ['kerros-navgraph-edge', 'kerros-navgraph-node'])
      m.setLayoutProperty(id, 'visibility', graphOn ? 'visible' : 'none');
    m.setPaintProperty('kerros-route-casing', 'line-color', p.dark ? '#14161f' : '#ffffff');
    {
      const ms = mapStyleRef.current;
      if (ms?.route || ms?.routeActive) {
        const active = ms.routeActive ?? '#5b50e6',
          base = ms.route ?? '#8d85dc';
        m.setPaintProperty('kerros-route', 'line-color', [
          'case',
          ['==', ['get', 'active'], true],
          active,
          base,
        ] as unknown as string);
        m.setPaintProperty('kerros-route-vertical', 'circle-color', [
          'case',
          ['==', ['get', 'active'], true],
          active,
          base,
        ] as unknown as string);
        m.setPaintProperty('kerros-route-off', 'line-color', base);
      }
    }
    m.setPaintProperty('kerros-route-vertical', 'circle-stroke-color', p.dark ? '#14161f' : '#ffffff');
    m.setPaintProperty('kerros-navgraph-node', 'circle-stroke-color', p.dark ? '#14161f' : '#ffffff');
    if (m.getLayer('background')) m.setPaintProperty('background', 'background-color', p.dark ? '#14161f' : '#e6e8e4');
    // City context: extrude the basemap's building footprints in 3D, and (below grade) draw ghost
    // context layers. What the tiles are called comes from the host's vectorSchema; nothing here is
    // provider-specific. Adopted/underlying footprints are filtered out of the 3D massing.
    const fp = p.basemap?.vectorSchema?.footprints;
    const ctx = p.basemap?.vectorSchema?.context;
    const citySource =
      fp || ctx
        ? Object.entries(m.getStyle().sources).find(([, s]) => (s as { type?: string }).type === 'vector')?.[0]
        : undefined;
    if (citySource && fp) {
      if (!m.getLayer('kerros-city-3d'))
        m.addLayer(
          {
            id: 'kerros-city-3d',
            type: 'fill-extrusion',
            source: citySource,
            'source-layer': fp.sourceLayer,
            paint: {
              'fill-extrusion-opacity': 1,
              'fill-extrusion-vertical-gradient': true,
              'fill-extrusion-height': (fp.heightExpression ?? 6.5) as never,
            },
          },
          m.getLayer('kerros-3d') ? 'kerros-3d' : undefined,
        );
      m.setLayoutProperty(
        'kerros-city-3d',
        'visibility',
        p.threeD && p.cityBuildings && !underground ? 'visible' : 'none',
      );
      // Warm stone rather than pale blue-grey: the surrounding city is context, so it should read as
      // built mass with its own weight, not as a wash the modelled building disappears into.
      m.setPaintProperty(
        'kerros-city-3d',
        'fill-extrusion-color',
        p.dark
          ? '#343a49'
          : [
              'interpolate',
              ['linear'],
              ['to-number', fp.heightExpression ?? 6.5],
              0,
              '#c5beaf',
              12,
              '#bcb7aa',
              30,
              '#b0b4af',
              70,
              '#a3adb0',
            ],
      );
      refreshCityFilter();
    }
    // Below-grade "style": soil cover plus faint ghost layers so a basement plan reads against what
    // stands above it — dashed street centrelines, faint building outlines and darkened water.
    if (citySource && ctx) {
      if (ctx.waterLayer && !m.getLayer('kerros-ug-water'))
        m.addLayer(
          {
            id: 'kerros-ug-water',
            type: 'fill',
            source: citySource,
            'source-layer': ctx.waterLayer,
            paint: { 'fill-color': '#10151b', 'fill-opacity': 0.55 },
          },
          'kerros-premises',
        );
      if (ctx.roadLayer && !m.getLayer('kerros-ug-roads'))
        m.addLayer(
          {
            id: 'kerros-ug-roads',
            type: 'line',
            source: citySource,
            'source-layer': ctx.roadLayer,
            paint: {
              'line-color': '#7d766a',
              'line-opacity': 0.33,
              'line-width': ['interpolate', ['linear'], ['zoom'], 13, 0.5, 16, 2.5, 19, 8],
              'line-dasharray': [4, 3],
            },
          },
          'kerros-premises',
        );
      if (ctx.buildingLayer && !m.getLayer('kerros-ug-buildings'))
        m.addLayer(
          {
            id: 'kerros-ug-buildings',
            type: 'line',
            source: citySource,
            'source-layer': ctx.buildingLayer,
            paint: { 'line-color': '#8a8375', 'line-opacity': 0.4, 'line-width': 1 },
          },
          'kerros-premises',
        );
      for (const id of ['kerros-ug-water', 'kerros-ug-roads', 'kerros-ug-buildings'])
        if (m.getLayer(id)) m.setLayoutProperty(id, 'visibility', underground && !p.threeD ? 'visible' : 'none');
    }
    // Cadastral parcels (vector): thin themed boundary lines under the drawing paper plus sparse
    // parcel-id labels. Enabled only when the host's vectorSchema declares a cadastre source.
    const cad = p.basemap?.vectorSchema?.cadastre;
    if (cad) {
      if (!m.getSource('kerros-cadastre')) {
        m.addSource('kerros-cadastre', { type: 'vector', url: cad.tilejson, attribution: cad.attribution });
        // Near-invisible parcel fill keeps polygons queryable (parcel id on click) without paint.
        m.addLayer(
          {
            id: 'kerros-cadastre-fill',
            type: 'fill',
            source: 'kerros-cadastre',
            'source-layer': cad.parcelLayer,
            paint: { 'fill-color': 'rgba(255,255,255,0.02)' },
          },
          'kerros-premises',
        );
        m.addLayer(
          {
            id: 'kerros-cadastre-line',
            type: 'line',
            source: 'kerros-cadastre',
            'source-layer': cad.boundaryLayer,
            paint: { 'line-width': 1, 'line-dasharray': [5, 2, 1, 2] },
          },
          'kerros-premises',
        );
        m.addLayer(
          {
            id: 'kerros-cadastre-mark',
            type: 'circle',
            source: 'kerros-cadastre',
            'source-layer': cad.markLayer,
            minzoom: 17,
            paint: { 'circle-radius': 2.4, 'circle-stroke-width': 1 },
          },
          'kerros-premises',
        );
        m.addLayer(
          {
            id: 'kerros-cadastre-label',
            type: 'symbol',
            source: 'kerros-cadastre',
            'source-layer': cad.labelLayer,
            minzoom: 15.5,
            layout: {
              'text-field': ['get', cad.labelField],
              'text-font': [cad.font],
              'text-size': 10.5,
              'text-padding': 12,
            },
            paint: {},
          },
          'kerros-premises',
        );
      }
      for (const id of [
        'kerros-cadastre-fill',
        'kerros-cadastre-line',
        'kerros-cadastre-mark',
        'kerros-cadastre-label',
      ])
        m.setLayoutProperty(id, 'visibility', p.cadastre && !underground ? 'visible' : 'none');
      m.setPaintProperty('kerros-cadastre-line', 'line-color', p.dark ? '#8d80c9' : '#a5674f');
      m.setPaintProperty('kerros-cadastre-line', 'line-opacity', p.dark ? 0.75 : 0.8);
      m.setPaintProperty('kerros-cadastre-mark', 'circle-color', p.dark ? '#8d80c9' : '#a5674f');
      m.setPaintProperty('kerros-cadastre-mark', 'circle-stroke-color', p.dark ? '#14161f' : '#ffffff');
      m.setPaintProperty('kerros-cadastre-label', 'text-color', p.dark ? '#a89ddb' : '#96604c');
      m.setPaintProperty('kerros-cadastre-label', 'text-halo-color', p.dark ? '#14161f' : '#f4f2ee');
      m.setPaintProperty('kerros-cadastre-label', 'text-halo-width', 1.1);
    }
    if (p.threeD && p.showPlan) {
      if (!m.getLayer('kerros-3d')) {
        scene.current = new SceneLayer();
        m.addLayer(scene.current);
        scene.current.animateIn();
      }
      // The veils go under the model, and are put back under it here rather than trusted to stay.
      // They are added with the rest of the plan's layers and the 3D layer is added after them, so
      // the order is right the first time — but a basemap swap, a floor that dives below ground or
      // the plan being switched off and on again all re-add layers, and which of them ends up on top
      // then depends on which already existed. Get it the wrong way round and the dusk veil paints a
      // flat tinted lid across the floor plate while the walls, standing outside the veiled polygon,
      // keep their colour: a building with an orange box where its inside should be.
      for (const veil of ['kerros-dim', 'kerros-underground']) if (m.getLayer(veil)) m.moveLayer(veil, 'kerros-3d');
      scene.current?.setMapStyle(mapStyleRef.current);
      scene.current?.update(
        p.project,
        p.floorId,
        p.stack,
        p.selected,
        p.sun,
        p.statuses,
        p.excavation ?? false,
        p.walk ?? false,
      );
      scene.current?.setRoute(p.route ?? null, p.activeStep ?? null);
    } else if (m.getLayer('kerros-3d')) {
      m.removeLayer('kerros-3d');
      scene.current = null;
    }
    const validIds = new Set(p.project.drawings.map(d => `drawing-${d.id}`));
    for (const id of Object.keys(m.getStyle().sources).filter(id => id.startsWith('drawing-') && !validIds.has(id))) {
      if (m.getLayer(id)) m.removeLayer(id);
      m.removeSource(id);
    }
    for (const d of p.project.drawings) {
      const id = `drawing-${d.id}`,
        url = urls.current.get(d.assetId);
      if (!url) continue;
      const coordinates = drawingCorners(d).map(pt => toLngLat(pt, p.project.origin)) as [Point, Point, Point, Point];
      if (!m.getSource(id)) {
        m.addSource(id, { type: 'image', url, coordinates });
        m.addLayer(
          { id, source: id, type: 'raster', paint: { 'raster-opacity': d.opacity, 'raster-fade-duration': 0 } },
          'kerros-outline',
        );
      } else {
        (m.getSource(id) as ImageSource).setCoordinates(coordinates);
        m.setPaintProperty(id, 'raster-opacity', d.opacity);
      }
      m.setLayoutProperty(id, 'visibility', d.visible && d.floorId === p.floorId && !p.threeD ? 'visible' : 'none');
    }
  };
  useEffect(() => {
    if (!container.current) return;
    let m: GLMap;
    const cam = props.initialCamera;
    try {
      m = new maplibregl.Map({
        container: container.current,
        style: neutralBasemap.style,
        transformRequest: props.basemap?.transformRequest,
        center: cam?.center ?? toLngLat([0, -1], props.project.origin),
        zoom: cam?.zoom ?? 18.5,
        bearing: cam?.bearing ?? siteBearing(props.project),
        pitch: cam?.pitch ?? 0,
        maxZoom: 25,
        minZoom: 5,
        // Walk mode puts the eye ~2 m above the slab, and the only way MapLibre expresses that is a
        // very high zoom at a very steep pitch. The default ceiling of 60° leaves the horizon off
        // screen and the eye a storey too high; 85° is as far as the projection stays sane.
        maxPitch: 85,
        attributionControl: false,
        canvasContextAttributes: { antialias: true },
        dragRotate: false,
        pitchWithRotate: false,
      });
    } catch (error) {
      setMapError(`The map could not start: ${String(error)}`);
      return;
    }
    map.current = m;
    if (import.meta.env.DEV) (window as unknown as { __kerrosMap?: GLMap }).__kerrosMap = m;
    m.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');
    m.doubleClickZoom.disable();
    let lastPitch = 0;
    m.on('pitch', () => {
      const now = performance.now();
      if (now - lastPitch > 100) {
        lastPitch = now;
        setPitch(m.getPitch());
      }
    });
    m.on('pitchend', () => setPitch(m.getPitch()));
    // Re-aim after inclination changes: the depth-aim shift is pitch-dependent, so the focused
    // floor drifts off-centre unless the fit re-runs once tilting settles.
    let pitchTimer: ReturnType<typeof setTimeout> | undefined;
    m.on('pitchend', () => {
      const p = latest.current;
      if (!p.threeD || !p.floorId || journey.current?.playing || p.walk) return;
      clearTimeout(pitchTimer);
      pitchTimer = setTimeout(() => {
        if (journey.current?.playing) return;
        const f = latest.current.project.floors.find(x => x.id === latest.current.floorId);
        if (f && f.elevation !== 0) fit(latest.current.floorId);
      }, 220);
    });
    m.on('style.load', () => {
      styleReady.current = true;
      cityHidden.current = '';
      cityIds.current = new Set();
      footprintFilters.current = new Map();
      if (!m.getLayer('kerros-3d')) scene.current = null;
      sync();
      setReady(true);
      setFrame(n => n + 1);
      setMapError('');
    });
    m.on('load', () => {
      props.onReady?.(m);
      if (!props.initialCamera) fit();
    });
    // Continuous 'render' events caused a React re-render (marker LOD + collision culling over
    // every object) each painted frame. Positions follow imperatively via reposition(); the React
    // pass only needs a low rate while moving plus a final pass when the camera settles.
    let lastFrame = 0;
    const bumpFrame = () => setFrame(n => n + 1);
    m.on('move', () => {
      const now = performance.now();
      if (now - lastFrame > 150) {
        lastFrame = now;
        bumpFrame();
      }
    });
    // Chained journey eases fire moveend once per edge; skip the React pass while playing (the
    // throttled 'move' handler keeps a low rate) and fire one final bumpFrame when the journey ends.
    const guardedBump = () => {
      if (!journey.current?.playing) bumpFrame();
    };
    m.on('moveend', guardedBump);
    m.on('zoomend', guardedBump);
    m.on('idle', guardedBump);
    m.on('error', e => {
      const source = (e as unknown as { sourceId?: string }).sourceId;
      if (/source layer/i.test(e.error.message) || source === 'kerros-cadastre' || /tile/i.test(e.error.message))
        return;
      setMapError(stringsRef.current.basemapUnavailable);
    });
    m.on('mousemove', e => {
      const p = latest.current;
      const local = toLocal([e.lngLat.lng, e.lngLat.lat], p.project.origin);
      const neighbor = m.unproject([e.point.x + 10, e.point.y]);
      const near = toLocal([neighbor.lng, neighbor.lat], p.project.origin);
      p.onHover(local, Math.hypot(near[0] - local[0], near[1] - local[1]));
      let hover: string | null = null;
      if (p.threeD) {
        hover = scene.current?.pick(e.point) ?? null;
        scene.current?.setHover(hover);
      } else if (p.tool === 'select' && !m.isMoving() && m.getLayer('kerros-areas')) {
        const hits = m.queryRenderedFeatures(
          [
            [e.point.x - 3, e.point.y - 3],
            [e.point.x + 3, e.point.y + 3],
          ],
          { layers: ['kerros-walls', 'kerros-areas'].filter(id => m.getLayer(id)) },
        );
        hover =
          (hits.find(
            f =>
              f.properties.id &&
              !['parcel', 'building', 'coverage', 'status-halo', 'furniture'].includes(f.properties.kind),
          )?.properties.id as string | undefined) ?? null;
      }
      if (hover !== hoverId.current) {
        hoverId.current = hover;
        latest.current.onHoverObject?.(hover);
        if (m.getLayer('kerros-hover'))
          m.setFilter('kerros-hover', [
            'all',
            ['==', ['geometry-type'], 'Polygon'],
            ['==', ['get', 'id'], hover ?? ''],
          ]);
      }
      if (p.tool === 'select' || p.threeD) m.getCanvas().style.cursor = hover ? 'pointer' : '';
    });
    m.on('move', reposition);
    // In 3D the overlay projects through the scene camera, whose matrix only updates inside the
    // custom layer's render pass — 'move' fires before it, leaving symbols one frame behind the
    // basemap. Re-snap after every rendered frame so they track the model exactly.
    m.on('render', () => {
      if (latest.current.threeD) reposition();
    });
    const resize = new ResizeObserver(() => {
      m.resize();
      reposition();
    });
    resize.observe(container.current);
    // Two-finger zoom must keep working when the gesture starts over an overlay symbol: those are
    // HTML elements above the canvas, so re-dispatch their wheel events onto the map itself.
    const forwardWheel = (e: WheelEvent) => {
      if ((e.target as HTMLElement).closest('.map-overlay')) {
        e.preventDefault();
        e.stopPropagation();
        m.getCanvasContainer().dispatchEvent(
          new WheelEvent('wheel', {
            deltaX: e.deltaX,
            deltaY: e.deltaY,
            deltaMode: e.deltaMode,
            clientX: e.clientX,
            clientY: e.clientY,
            ctrlKey: e.ctrlKey,
            bubbles: true,
            cancelable: true,
          }),
        );
      }
    };
    const wrap = container.current?.parentElement;
    wrap?.addEventListener('wheel', forwardWheel, { capture: true, passive: false });
    m.on('idle', () => refreshCityFilter());
    m.on('click', e => {
      if (suppressClick.current) {
        suppressClick.current = false;
        return;
      }
      const p = latest.current;
      if (p.tool === 'adopt' && p.canEdit && !p.threeD) {
        adoptAt(e.point);
        return;
      }
      const ids = ['kerros-walls', 'kerros-areas'].filter(id => m.getLayer(id));
      const hits = p.threeD
        ? []
        : m.queryRenderedFeatures(
            [
              [e.point.x - 3, e.point.y - 3],
              [e.point.x + 3, e.point.y + 3],
            ],
            { layers: ids },
          );
      const hit = hits.find(
        f =>
          f.properties.id &&
          f.properties.kind !== 'parcel' &&
          f.properties.kind !== 'building' &&
          f.properties.kind !== 'coverage' &&
          f.properties.kind !== 'status-halo',
      );
      // Walking, a click is how you take hold of the pointer — not how you select a wall.
      if (p.walk) return;
      p.onClick(
        toLocal([e.lngLat.lng, e.lngLat.lat], p.project.origin),
        p.threeD ? (scene.current?.pick(e.point) ?? null) : (hit?.properties.id ?? null),
      );
    });
    return () => {
      clearTimeout(pitchTimer);
      journey.current?.stop();
      journey.current = null;
      resize.disconnect();
      wrap?.removeEventListener('wheel', forwardWheel, { capture: true });
      urls.current.forEach(URL.revokeObjectURL);
      urls.current.clear();
      m.remove();
      map.current = null;
    };
    // The map owns its lifecycle; live state is supplied through latest.current.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Without a scope, frames the building (or everything); scoped to a floor, frames that floor's
  // geometry — selecting a floor always brings it fully into view.
  function fit(scopeFloor?: string | null) {
    const m = map.current;
    if (!m) return;
    const p = latest.current;
    // Walk mode owns the camera outright. A fit here — from the map's load, from the floor changing,
    // from the fit button — would ease the eye a hundred metres into the air and leave it there,
    // because the walker only writes a pose when the walker moves.
    if (p.walk) return;
    const scoped =
      scopeFloor !== undefined
        ? [
            ...p.project.junctions.filter(j => j.floorId === scopeFloor).map(j => j.position),
            ...p.project.objects.filter(o => o.floorId === scopeFloor).flatMap(o => o.rings?.[0] ?? [o.position]),
          ]
        : [];
    const indoor = scoped.length
      ? scoped
      : [
          ...p.project.junctions.filter(j => j.floorId).map(j => j.position),
          ...p.project.objects.filter(o => o.floorId).flatMap(o => o.rings?.[0] ?? [o.position]),
        ];
    const points = indoor.length
      ? indoor
      : [...p.project.junctions.map(j => j.position), ...p.project.objects.flatMap(o => o.rings?.[0] ?? [o.position])];
    const safe = points.length
      ? points
      : ([
          [-40, -30],
          [40, 30],
        ] as Point[]);
    // Extend with every point, not the local AABB corners: on sites with a rotated origin the
    // rotated corner box inflates the geo bounds by up to ~40%, which read as "zoomed out".
    const bounds = new maplibregl.LngLatBounds();
    for (const pt of safe) bounds.extend(toLngLat(pt, p.project.origin));
    // Keep the focus tight on the floor itself — just enough padding to clear the floating chrome.
    // Keep the user's rotation (fitBounds would reset bearing), and in 3D follow the floor's
    // elevation: zoom compensates for depth so navigating floors sinks into the pit (or rises
    // with the towers) instead of viewing a distant plate from street height.
    const camera = m.cameraForBounds(bounds, {
      padding: { top: 64, bottom: p.canEdit && !p.threeD ? 150 : 72, left: 42, right: 42 },
      bearing: m.getBearing(),
      maxZoom: 20.5,
    });
    if (!camera) return;
    let zoom = camera.zoom ?? m.getZoom();
    const focusFloor = scopeFloor === undefined ? p.floorId : scopeFloor;
    const elev = undergroundView(p.project, focusFloor, p.stack).focusElevation;
    if (p.threeD && elev) {
      const perPixel = (156543.03392 * Math.cos((m.getCenter().lat * Math.PI) / 180)) / Math.pow(2, zoom);
      const screenDistance =
        (m as unknown as { transform?: { cameraToCenterDistance?: number } }).transform?.cameraToCenterDistance ??
        m.getCanvas().height * 1.5;
      const altitude = screenDistance * perPixel * Math.cos((m.getPitch() * Math.PI) / 180);
      const adjusted = altitude + elev;
      if (adjusted > 25) zoom += Math.log2(altitude / adjusted) * 0.85;
      // Aim at the floor itself, not the ground above it — aimCenter() is this fit's depth-aim
      // shift factored into journey.ts so the journey camera and the fit agree exactly.
      const at = maplibregl.LngLat.convert(camera.center as maplibregl.LngLatLike);
      camera.center = aimCenter([at.lng, at.lat], elev, m.getPitch(), m.getBearing());
    }
    m.easeTo({ center: camera.center, zoom, bearing: m.getBearing(), duration: 650 });
  }
  useEffect(() => {
    // A walker who climbs a stair stays where they are standing; re-fitting would throw them across
    // the floor plate the moment they arrived.
    if (ready && !journey.current?.playing && !props.walk) fit(props.floorId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.floorId, props.stack]);
  // ---------------------------------------------------------------- walk mode
  // The camera stops being a camera and becomes a person: WalkController owns the pose, this owns
  // the things only the document knows — which walls are solid, what a stair leads to, and what the
  // head-up display should say.
  const walker = useRef<WalkController | null>(null);
  const [walkHint, setWalkHint] = useState<WalkHint>(NO_HINT);
  const hintRef = useRef<WalkHint>(NO_HINT);
  const hintAt = useRef(0);
  /** Wall bodies the walker's shoulders meet. wallPieces() already splits a wall at its openings, so
   *  a doorway is a gap in this list and nothing has to know what a door is; the strip left over a
   *  door is a piece lifted clear of head height, which you walk under. */
  const walkWalls = useMemo(
    () =>
      props.walk
        ? wallPieces(props.project, props.floorId, false)
            .filter(piece => piece.base < HEAD_ROOM)
            .map(piece => piece.ring)
        : [],
    [props.walk, props.project, props.floorId],
  );
  /** Where to stand when walk mode opens. Under the camera if that is somewhere on this floor —
   *  entering walk mode should feel like stepping into the view you already had — and otherwise in
   *  the middle of the floor's largest space, rather than in the car park across the street. */
  const startPoint = (m: GLMap): Point => {
    const p = latest.current;
    const c = m.getCenter();
    const here = toLocal([c.lng, c.lat], p.project.origin);
    if (!p.floorId || spaceAt(p.project, p.floorId, here)) return here;
    const spaces = p.project.objects
      .filter(o => o.floorId === p.floorId && isSpace(o.kind) && o.rings?.length)
      .sort((a, b) => objectArea(b) - objectArea(a));
    // A concave plate's centroid can fall in its own courtyard, so take the largest space that
    // actually contains the point it offers.
    for (const space of spaces) {
      const at = spacePoint(p.project, space);
      if (inSpace(space, at)) return at;
    }
    return here;
  };
  /** The shaft the walker is standing in and where it could take them. */
  const climb = (at: Point) => {
    const p = latest.current;
    const shaft = p.project.objects.find(
      o => o.floorId === p.floorId && (o.kind === 'stairs' || o.kind === 'elevator') && inSpace(o, at),
    );
    const here = p.project.floors.find(f => f.id === p.floorId);
    if (!shaft || !here) return { shaft: null, up: null, down: null };
    const served = servedFloors(p.project, shaft);
    // An escalator carries you one way. Offering the other is offering to walk up the down staircase.
    const only = shaft.stairModel === 'escalator' ? (shaft.travel ?? 'up') : null;
    const above = served.filter(f => f.elevation > here.elevation)[0] ?? null;
    const below = served.filter(f => f.elevation < here.elevation).slice(-1)[0] ?? null;
    return { shaft, up: only === 'down' ? null : above, down: only === 'up' ? null : below };
  };
  useEffect(() => {
    const m = map.current;
    if (!m || !ready || !props.walk) return;
    const p = latest.current;
    const controller = new WalkController({
      onPose: (pose: WalkPose) => {
        const now = performance.now();
        if (now - hintAt.current < 150) return; // the pose changes every frame; what it means does not
        hintAt.current = now;
        const { up, down } = climb(pose.position);
        const room = spaceAt(latest.current.project, latest.current.floorId, pose.position);
        const next: WalkHint = {
          looking: pose.looking,
          up: up?.name ?? null,
          down: down?.name ?? null,
          where: room?.name ?? '',
        };
        if (
          next.looking !== hintRef.current.looking ||
          next.up !== hintRef.current.up ||
          next.down !== hintRef.current.down ||
          next.where !== hintRef.current.where
        ) {
          hintRef.current = next;
          setWalkHint(next);
        }
      },
      onUse: (down: boolean) => {
        const target = climb(walker.current?.position ?? [0, 0]);
        const floor = down ? target.down : target.up;
        if (floor) latest.current.onRequestFloor?.(floor.id);
      },
      onExit: () => latest.current.onWalkExit?.(),
    });
    walker.current = controller;
    if (import.meta.env.DEV) (window as unknown as { __kerrosWalk?: WalkController }).__kerrosWalk = controller;
    controller.attach(m, p.project.origin, {
      position: unstick(startPoint(m), walkWalls),
      heading: m.getBearing() - (p.project.origin[2] ?? 0),
    });
    return () => {
      controller.detach();
      walker.current = null;
      hintRef.current = NO_HINT;
      setWalkHint(NO_HINT);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, props.walk]);
  useEffect(() => {
    // Walk mode draws the active floor on the map's own ground plane (SceneLayer rebases it), so the
    // eye is the same height above it on every storey — only the walls change.
    walker.current?.setTerrain({ walls: walkWalls, eye: EYE + LIFT + SLAB });
  }, [walkWalls]);
  // Journey floor barrier: resolves once the app shows the target floor AND the view has rebuilt —
  // in 3D when the SceneLayer revision advances past the value captured HERE, before React flushes
  // the floor change (do not insert an await between requestFloor and this call), in 2D after two
  // rendered frames. The safety timeout keeps a host that ignores onRequestFloor from deadlocking.
  const waitForFloor = (target: string | null) =>
    new Promise<void>(resolve => {
      const m = map.current;
      if (!m) return resolve();
      const rev = scene.current?.diagnostics.revision ?? -1;
      let frames = 0;
      const done = () => {
        clearTimeout(timer);
        m.off('render', check);
        resolve();
      };
      const timer = setTimeout(done, 5000);
      const check = () => {
        const p = latest.current;
        if (p.floorId !== target) {
          frames = 0;
          return;
        }
        if (p.threeD ? (scene.current?.diagnostics.revision ?? rev + 1) > rev : ++frames >= 2) done();
      };
      m.on('render', check);
      m.triggerRepaint();
    });
  useEffect(() => {
    const m = map.current;
    if (props.playing && m && !journey.current) {
      const route = latest.current.route;
      if (!route) {
        latest.current.onJourneyEnd?.();
        return;
      }
      const j = new JourneyPlayer(m, {
        requestFloor: id => latest.current.onRequestFloor?.(id),
        waitForFloor,
        focusElevation: fid =>
          latest.current.threeD ? undergroundView(latest.current.project, fid, latest.current.stack).focusElevation : 0,
        onStep: i => latest.current.onJourneyStep?.(i),
        onEnd: () => {
          journey.current = null;
          setFrame(n => n + 1);
          latest.current.onJourneyEnd?.();
        },
      });
      journey.current = j;
      j.play(route, { origin: latest.current.project.origin, startFloorId: latest.current.floorId });
    } else if (!props.playing && journey.current) journey.current.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.playing]);
  // A deep-linked camera must survive the mount-time 3D tilt-in; later mode switches animate normally.
  const firstTilt = useRef(true);
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    const controller = new AbortController();
    const config = props.basemap ?? neutralBasemap;
    void loadBasemap(config, controller.signal)
      .then(style => {
        if (controller.signal.aborted) return;
        m.setTransformRequest(config.transformRequest ?? (url => ({ url })));
        styleReady.current = false;
        m.setStyle(style, { diff: false });
      })
      .catch(error => {
        if (error.name !== 'AbortError') setMapError(stringsRef.current.basemapUnavailablePlan);
      });
    return () => controller.abort();
  }, [props.basemap]);
  useEffect(() => {
    sync();
  }, [
    props.project,
    props.floorId,
    props.selected,
    props.threeD,
    props.stack,
    props.coverage,
    props.showPlan,
    props.sun,
    props.dark,
    props.cityBuildings,
    props.cadastre,
    props.statuses,
    props.route,
    props.activeStep,
    props.tool,
    props.canEdit,
    ready,
  ]);
  useEffect(() => {
    syncDraft();
  }, [props.draft, props.hover, props.guides, props.tool, ready]);
  // A React marker pass may commit positions computed before the camera's latest frame; snap them
  // to the current camera immediately after every commit so symbols never trail a pan.
  useEffect(() => {
    reposition();
  });
  useEffect(() => {
    let cancelled = false;
    const live = new Set(props.project.drawings.map(d => d.assetId));
    for (const [assetId, url] of urls.current)
      if (!live.has(assetId)) {
        URL.revokeObjectURL(url);
        urls.current.delete(assetId);
      }
    let missing: string | null = null;
    Promise.all(
      props.project.drawings.map(async d => {
        if (urls.current.has(d.assetId)) return;
        const blob = await props.assets.get(d.assetId).catch(() => undefined);
        // A missing blob must not stop the drawings that did resolve from rendering.
        if (!blob) missing = d.name;
        else if (!cancelled) urls.current.set(d.assetId, URL.createObjectURL(blob));
      }),
    ).then(() => {
      if (cancelled) return;
      sync();
      if (missing) props.onError(`Reference image “${missing}” is missing.`);
    });
    return () => {
      cancelled = true;
    };
  }, [props.project.drawings, props.assets]);
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    const skipEase = (firstTilt.current && !!props.initialCamera) || props.walk;
    firstTilt.current = false;
    if (!skipEase)
      m.easeTo({
        pitch: props.threeD ? 35 : 0,
        bearing: siteBearing(props.project) + (props.threeD ? -12 : 0),
        duration: 600,
      });
    if (props.threeD) {
      m.dragRotate.enable();
      m.touchZoomRotate.enableRotation();
    } else {
      m.dragRotate.disable();
      m.touchZoomRotate.disableRotation();
    } // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.threeD]);
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    m.getCanvas().style.cursor = props.tool === 'pan' ? 'grab' : props.tool === 'select' ? '' : 'crosshair';
  }, [props.tool]);
  useEffect(() => {
    const m = map.current;
    if (journey.current?.playing) return;
    const o = props.project.objects.find(o => o.id === props.focusId);
    if (m && o) m.easeTo({ center: toLngLat(objectPosition(props.project, o), props.project.origin), duration: 500 });
  }, [props.focusId]); // eslint-disable-line react-hooks/exhaustive-deps
  // Ground-plane projection: no elevation term, which is also how the markers are placed. Its
  // inverse is unproject, so a handle you grab and the point you drop it on are in the same frame
  // whether or not the view is pitched — which is what lets an object be dragged in 3D at all.
  const screen = (p: Point) => map.current?.project(toLngLat(p, props.project.origin));
  function startDrag(
    event: React.PointerEvent<HTMLButtonElement>,
    kind: 'junction' | 'ring' | 'object' | 'barrier' | 'node' | 'opening' | 'rotate' | 'coverage',
    id: string,
    ring?: number,
    vertex?: number,
  ) {
    event.stopPropagation();
    event.preventDefault();
    const m = map.current;
    if (!m || !props.canEdit || (kind === 'node' ? !routeTool : props.tool !== 'select')) return;
    m.dragPan.disable();
    const target = event.currentTarget;
    const origin = { x: event.clientX, y: event.clientY };
    let moved = false;
    // Live preview: temporary lines track the cursor through the lightweight draft source, so the
    // full plan only rebuilds once on release.
    const preview = (clientX: number, clientY: number) => {
      const rect = m.getContainer().getBoundingClientRect();
      const ll = m.unproject([clientX - rect.left, clientY - rect.top]);
      const local = toLocal([ll.lng, ll.lat], latest.current.project.origin);
      const p = latest.current;
      const lines: Point[][] = [];
      if (kind === 'object') {
        const o = p.project.objects.find(x => x.id === id);
        if (o?.rings) {
          const dx = local[0] - o.position[0],
            dy = local[1] - o.position[1];
          lines.push(closeRing(o.rings[0].map(pt => [pt[0] + dx, pt[1] + dy] as Point)));
        }
      } else if (kind === 'ring') {
        const o = p.project.objects.find(x => x.id === id);
        const points = o?.rings?.[ring ?? 0];
        if (points) {
          const open = openRing(points);
          lines.push([
            open[((vertex ?? 0) + open.length - 1) % open.length],
            local,
            open[((vertex ?? 0) + 1) % open.length],
          ]);
        }
      } else if (kind === 'barrier') {
        // Translating a whole wall along its normal only (orthogonal slide); walls sharing those
        // junctions stretch to follow, so the mesh stays connected.
        const b = p.project.barriers.find(x => x.id === id);
        if (b) {
          const [a, c] = barrierEnds(p.project, b);
          const mid: Point = [(a[0] + c[0]) / 2, (a[1] + c[1]) / 2];
          const len = Math.hypot(c[0] - a[0], c[1] - a[1]);
          const nx = -(c[1] - a[1]) / len,
            ny = (c[0] - a[0]) / len;
          const s = (local[0] - mid[0]) * nx + (local[1] - mid[1]) * ny;
          const dx = nx * s,
            dy = ny * s;
          const a2: Point = [a[0] + dx, a[1] + dy],
            c2: Point = [c[0] + dx, c[1] + dy];
          lines.push([a2, c2]);
          for (const other of p.project.barriers.filter(
            x =>
              x.id !== id &&
              (x.startId === b.startId || x.endId === b.startId || x.startId === b.endId || x.endId === b.endId),
          )) {
            const [oa, oc] = barrierEnds(p.project, other);
            const movedStart = other.startId === b.startId || other.startId === b.endId;
            const anchor = movedStart ? oc : oa;
            const movedEnd = (movedStart ? other.startId : other.endId) === b.startId ? a2 : c2;
            lines.push([anchor, movedEnd]);
          }
        }
      } else if (kind === 'opening') {
        // Where the leaf will land: the drop projected onto its wall and clamped so the opening
        // stays wholly on the segment — the same arithmetic the commit does, so the ghost is not a
        // near-miss of the result.
        const opening = p.project.objects.find(o => o.id === id);
        const barrier = p.project.barriers.find(b => b.id === opening?.barrierId);
        if (opening && barrier) {
          const [a, b] = barrierEnds(p.project, barrier);
          const hit = segmentProjection(local, a, b);
          const half = opening.width / 2;
          if (hit.length >= opening.width) {
            const offset = Math.max(half, Math.min(hit.length - half, hit.t * hit.length));
            const ux = (b[0] - a[0]) / hit.length,
              uy = (b[1] - a[1]) / hit.length;
            const at: Point = [a[0] + ux * offset, a[1] + uy * offset];
            lines.push([
              [at[0] - ux * half, at[1] - uy * half],
              [at[0] + ux * half, at[1] + uy * half],
            ]);
            // A tick across the wall, so a leaf being slid is legible against the wall it slides on.
            const t = barrier.thickness;
            lines.push([
              [at[0] + uy * t, at[1] - ux * t],
              [at[0] - uy * t, at[1] + ux * t],
            ]);
          }
        }
      } else if (kind === 'rotate') {
        const o = p.project.objects.find(x => x.id === id);
        if (o) {
          const degrees = Math.atan2(local[1] - o.position[1], local[0] - o.position[0]);
          lines.push([o.position, local]);
          // An object with a footprint shows that footprint turned; one without — a camera, a
          // marker — is legible from the arm alone.
          if (o.rings?.[0]) {
            const cos = Math.cos(degrees - ((o.rotation ?? 0) * Math.PI) / 180),
              sin = Math.sin(degrees - ((o.rotation ?? 0) * Math.PI) / 180);
            lines.push(
              closeRing(
                o.rings[0].map(pt => {
                  const dx = pt[0] - o.position[0],
                    dy = pt[1] - o.position[1];
                  return [o.position[0] + dx * cos - dy * sin, o.position[1] + dx * sin + dy * cos] as Point;
                }),
              ),
            );
          }
        }
      } else if (kind === 'coverage') {
        // The cone as the release will leave it: reach from the handle's distance, spread from its
        // bearing either side of the object's facing.
        const o = p.project.objects.find(x => x.id === id);
        if (o) {
          const dx = local[0] - o.position[0],
            dy = local[1] - o.position[1];
          const range = Math.max(1, Math.min(120, Math.hypot(dx, dy)));
          const bearing = (Math.atan2(dy, dx) * 180) / Math.PI;
          const half = Math.min(
            175,
            Math.max(5, Math.abs(((((bearing - (o.rotation ?? 0)) % 360) + 540) % 360) - 180)),
          );
          const facing = ((o.rotation ?? 0) * Math.PI) / 180;
          const arc: Point[] = [o.position];
          const steps = 24;
          for (let k = 0; k <= steps; k++) {
            const th = facing + ((-half + (2 * half * k) / steps) * Math.PI) / 180;
            arc.push([o.position[0] + Math.cos(th) * range, o.position[1] + Math.sin(th) * range]);
          }
          arc.push(o.position);
          lines.push(arc);
        }
      } else if (kind === 'node') {
        const node = p.project.navNodes?.find(n => n.id === id);
        for (const edge of (p.project.navEdges ?? []).filter(e => e.aId === id || e.bId === id)) {
          const other = p.project.navNodes?.find(n => n.id === (edge.aId === id ? edge.bId : edge.aId));
          if (other && node && other.floorId === node.floorId) lines.push([other.position, local]);
        }
      } else
        for (const b of p.project.barriers.filter(b => b.startId === id || b.endId === id)) {
          const j = p.project.junctions.find(j => j.id === (b.startId === id ? b.endId : b.startId));
          if (j) lines.push([j.position, local]);
        }
      (m.getSource('kerros-draft') as GeoJSONSource | undefined)?.setData({
        type: 'FeatureCollection',
        features: lines.map(points => ({
          type: 'Feature',
          properties: {},
          geometry: { type: 'LineString', coordinates: points.map(pt => toLngLat(pt, p.project.origin)) },
        })),
      } as GeoJSON.FeatureCollection);
    };
    const move = (e: PointerEvent) => {
      moved = Math.hypot(e.clientX - origin.x, e.clientY - origin.y) > 3;
      if (moved) {
        const rect = m.getContainer().getBoundingClientRect();
        target.style.left = `${e.clientX - rect.left}px`;
        target.style.top = `${e.clientY - rect.top}px`;
        preview(e.clientX, e.clientY);
      }
    };
    const up = (e: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      m.dragPan.enable();
      syncDraft();
      if (moved) {
        suppressClick.current = true;
        const rect = m.getContainer().getBoundingClientRect();
        const ll = m.unproject([e.clientX - rect.left, e.clientY - rect.top]);
        latest.current.onVertexMove(
          kind,
          id,
          toLocal([ll.lng, ll.lat], props.project.origin),
          ring,
          vertex,
          e.shiftKey,
        );
        setFrame(n => n + 1);
        setTimeout(() => {
          suppressClick.current = false;
        }, 100);
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up, { once: true });
  }
  const selectedObject = props.project.objects.find(o => o.id === props.selected);
  const selectedBarrier = props.project.barriers.find(b => b.id === props.selected);
  const floor = props.project.floors.find(f => f.id === props.floorId);
  const depthView = undergroundView(props.project, props.floorId, props.threeD && props.stack);
  const m = map.current;
  let scaleWidth = 70;
  if (m && ready) {
    const a = screen([0, 0]),
      b = screen([10, 0]);
    if (a && b) scaleWidth = Math.hypot(b.x - a.x, b.y - a.y);
  }
  // Zoom LOD, pass 1 — cheap thresholds: a symbol class only becomes a candidate once the scale
  // could fit it, and a room label must fit inside its own footprint.
  const ppm = scaleWidth / 10;
  const pinned = (o: { id: string; feedId?: string }) =>
    o.id === props.selected || !!(o.feedId && statusTone(props.statuses.get(o.feedId)) === 'critical');
  // Tiered by zoom: full symbol → small colour-coded dot that reveals its name on hover → hidden.
  const tier = (o: {
    kind: string;
    id: string;
    feedId?: string;
    name: string;
    width: number;
  }): 'full' | 'mini' | null => {
    if (pinned(o)) return 'full';
    if (o.kind === 'room' || o.kind === 'zone')
      // An area only earns a dot once it is big enough on screen to be worth pointing at. Without the
      // width test a dense plan (a garage of 2.5 m bays, a warehouse of racks) peppers the view with
      // markers for shapes a few pixels across.
      return ppm >= 3.5 && o.name.length * 6.5 <= o.width * ppm * 1.2
        ? 'full'
        : ppm >= 1.8 && o.width * ppm >= 26
          ? 'mini'
          : null;
    if (o.kind === 'poi' || o.kind === 'gate') return ppm >= 1.2 ? 'full' : ppm >= 0.5 ? 'mini' : null;
    return (['door', 'reader', 'turnstile'].includes(o.kind) ? ppm >= 6 : ppm >= 5)
      ? 'full'
      : ppm >= 2.4
        ? 'mini'
        : null;
  };
  // Outdoor symbols (gates, POIs, parking labels) only accompany the outdoor view and the ground
  // floor; on other levels they are distracting clutter under the building.
  const groundSymbols =
    props.floorId === null || (props.project.floors.find(f => f.id === props.floorId)?.elevation ?? 0) === 0;
  // Pass 2 — screen-space collision culling: symbols claim space in priority order (site wayfinding
  // first, dense per-door hardware last); whatever would overlap stays hidden until zoomed closer.
  const PRIORITY: Record<string, number> = {
    poi: 1,
    gate: 2,
    zone: 3,
    room: 4,
    camera: 5,
    elevator: 6,
    stairs: 7,
    turnstile: 8,
    reader: 9,
    door: 10,
  };
  const items: {
    o: SiteObject;
    s: { x: number; y: number };
    world: Point;
    isLabel: boolean;
    mini: boolean;
    voidLabel: boolean;
  }[] = [];
  if (ready && props.showPlan)
    for (const o of props.project.objects) {
      if (
        !onFloor(props.project, o, props.floorId) ||
        !(groundSymbols || o.floorId !== null || pinned(o)) ||
        ['window', 'building', 'parcel', 'office', 'container', 'storage', 'fixture', 'landscape'].includes(o.kind)
      )
        continue;
      const t = tier(o);
      if (!t) continue;
      const isLabel = o.kind === 'room' || o.kind === 'zone';
      if (isLabel && (!props.showLabels || (props.threeD && props.stack && o.floorId !== props.floorId))) continue;
      const world = objectPosition(props.project, o);
      const s = props.threeD ? scene.current?.projectObject(o) : screen(world);
      if (!s || ('visible' in s && !s.visible)) continue;
      const voidLabel = isLabel && !!o.rings?.slice(1).some(ring => pointInRing(world, ring));
      items.push({ o, s, world, isLabel: isLabel && t === 'full', mini: t === 'mini', voidLabel });
    }
  items.sort((a, b) => (pinned(a.o) ? 0 : (PRIORITY[a.o.kind] ?? 9)) - (pinned(b.o) ? 0 : (PRIORITY[b.o.kind] ?? 9)));
  const placed: { x: number; y: number; w: number; h: number }[] = [];
  const markers = items.filter(({ o, s, isLabel, mini, voidLabel }) => {
    const w = mini ? 8 : isLabel ? (voidLabel ? 90 : Math.max(36, o.name.length * 3.6)) : 19,
      h = mini ? 8 : isLabel ? (voidLabel ? 36 : 16) : 19;
    if (!pinned(o) && placed.some(q => Math.abs(q.x - s.x) < q.w + w && Math.abs(q.y - s.y) < q.h + h)) return false;
    placed.push({ x: s.x, y: s.y, w, h });
    return true;
  });
  const st = mapStyleRef.current?.statusTones;
  const TONE: Record<string, string> = {
    normal: st?.normal ?? '#2e9e6b',
    warning: st?.warning ?? '#e39d3b',
    critical: st?.critical ?? '#e0524e',
    unknown: st?.unknown ?? '#9a9daf',
  };
  const MINI: Record<string, string> = {
    room: '#a9b3c2',
    zone: '#96a58b',
    poi: '#1d2038',
    gate: '#5d6390',
    door: '#6a63d8',
    camera: '#7b74dd',
    elevator: '#567c9a',
    stairs: '#6d7a90',
    reader: '#4a7fb5',
    turnstile: '#4a7fb5',
    sensor: '#5b9bd0',
    alarm: '#e0524e',
    equipment: '#9a8f74',
  };
  return (
    <div className={`map-wrap ${props.threeD ? 'perspective' : ''}`} data-frame={frame > 0 ? 'ready' : 'loading'}>
      <div className="map-surface" ref={container} data-testid="map-canvas" />
      <div className="map-overlay" ref={overlay}>
        {markers.map(({ o, s, world, isLabel, mini, voidLabel }) => {
          const status = o.feedId ? props.statuses.get(o.feedId) : undefined;
          if (mini)
            return (
              <button
                key={o.id}
                onMouseEnter={clampTooltip}
                className={`mini-marker ${o.category ? 'cat-' + o.category : ''}`}
                data-wx={world[0]}
                data-wy={world[1]}
                data-oid={o.id}
                data-kind={o.kind}
                data-category={o.category}
                style={{
                  left: s.x,
                  top: s.y,
                  background:
                    mapStyleRef.current?.objectColor?.(o) ??
                    (o.feedId ? TONE[statusTone(status)] : (MINI[o.kind] ?? o.color ?? '#9a9daf')),
                }}
                title={`${o.name}${o.feedId ? ` · ${statusLabel(status)}` : ''}`}
                aria-label={o.name}
                onClick={e => {
                  e.stopPropagation();
                  if (props.tool === 'select' || props.threeD) props.onSelect(o.id);
                  else props.onClick(objectPosition(props.project, o), o.id);
                }}
              >
                <span className="marker-tooltip">
                  {o.name}
                  {o.feedId ? ` · ${statusLabel(status)}` : ''}
                </span>
              </button>
            );
          return isLabel ? (
            <div
              key={o.id}
              className={`space-label ${o.floorId === null ? 'outdoor' : ''} ${voidLabel ? 'void-label' : ''}`}
              data-wx={world[0]}
              data-wy={world[1]}
              data-oid={o.id}
              style={{ left: s.x, top: s.y }}
            >
              <span>{o.name}</span>
              {o.kind === 'room' && <small>{Math.round(objectArea(o))} m²</small>}
              {voidLabel && o.kind === 'zone' && floor && (
                <small>
                  {floor.code ? `${floor.code} · ` : ''}
                  {floor.elevation.toFixed(0)} m
                </small>
              )}
            </div>
          ) : (
            <button
              key={o.id}
              onMouseEnter={clampTooltip}
              className={`entity-marker ${o.kind === 'poi' ? 'poi' : ''} ${o.category ? 'cat-' + o.category : ''} ${statusTone(status)} ${props.selected === o.id ? 'selected' : ''}`}
              data-wx={world[0]}
              data-wy={world[1]}
              data-oid={o.id}
              data-kind={o.kind}
              data-category={o.category}
              style={{ left: s.x, top: s.y }}
              title={`${o.name}${o.feedId ? ` · ${statusLabel(status)}` : ''}`}
              aria-label={o.name}
              onClick={e => {
                e.stopPropagation();
                if (props.tool === 'select' || props.threeD) props.onSelect(o.id);
                else props.onClick(objectPosition(props.project, o), o.id);
              }}
            >
              <EntityIcon
                kind={o.kind}
                size={o.kind === 'door' ? 14 : 17}
                symbol={o.symbol}
                travel={status?.travel ?? o.travel}
              />
              {o.feedId && <i className={`status-dot ${statusTone(status)}`} />}
              <span className="marker-tooltip">{o.name}</span>
            </button>
          );
        })}
        {props.canEdit &&
          props.tool === 'select' &&
          !props.threeD &&
          selectedObject?.rings?.flatMap((r, ri) =>
            openRing(r).map((p, i) => {
              const s = screen(p);
              return s ? (
                <button
                  key={`${ri}-${i}`}
                  aria-label={`Move vertex ${i + 1}`}
                  className="vertex-handle"
                  data-wx={p[0]}
                  data-wy={p[1]}
                  style={{ left: s.x, top: s.y }}
                  onPointerDown={e => startDrag(e, 'ring', selectedObject.id, ri, i)}
                />
              ) : null;
            }),
          )}
        {props.canEdit &&
          props.tool === 'select' &&
          selectedObject &&
          (() => {
            const s = screen(selectedObject.position);
            // An opening cannot go wherever the pointer went — it belongs to its wall. Same handle,
            // different constraint: the drop is projected back onto the barrier it is fitted to.
            const attached = !!selectedObject.barrierId;
            return s ? (
              <button
                className="move-handle"
                aria-label={attached ? 'Slide along the wall' : 'Move selected object'}
                data-wx={selectedObject.position[0]}
                data-wy={selectedObject.position[1]}
                style={{ left: s.x, top: s.y }}
                onPointerDown={e => startDrag(e, attached ? 'opening' : 'object', selectedObject.id)}
              >
                ✥
              </button>
            ) : null;
          })()}
        {props.canEdit &&
          props.tool === 'select' &&
          selectedObject &&
          !selectedObject.barrierId &&
          selectedObject.rotation !== undefined &&
          (() => {
            // A turned object had no visible affordance at all: the angle was a number in a panel.
            // The handle stands off along the object's own facing, at arm's length from its footprint.
            const reach = Math.max(1.6, (Math.abs(selectedObject.width) + Math.abs(selectedObject.depth)) / 2 + 0.8);
            const at = add(selectedObject.position, rotate([reach, 0], selectedObject.rotation));
            const s = screen(at);
            return s ? (
              <button
                className="rotate-handle"
                aria-label="Turn selected object"
                data-wx={at[0]}
                data-wy={at[1]}
                style={{ left: s.x, top: s.y }}
                onPointerDown={e => startDrag(e, 'rotate', selectedObject.id)}
              />
            ) : null;
          })()}
        {props.canEdit &&
          props.tool === 'select' &&
          selectedObject?.kind === 'camera' &&
          (() => {
            // One handle for the whole cone: how far it reaches is the distance, how wide it opens
            // is twice the angle off the camera's facing. Dragging it does both at once, which is
            // how you actually aim a camera — pull it to the thing you want in frame.
            const range = selectedObject.coverageRange ?? 12;
            const half = (selectedObject.coverageAngle ?? 70) / 2;
            const at = add(selectedObject.position, rotate([range, 0], selectedObject.rotation + half));
            const s = screen(at);
            return s ? (
              <button
                className="coverage-handle"
                aria-label="Camera reach and field of view"
                data-wx={at[0]}
                data-wy={at[1]}
                style={{ left: s.x, top: s.y }}
                onPointerDown={e => startDrag(e, 'coverage', selectedObject.id)}
              />
            ) : null;
          })()}
        {props.canEdit &&
          props.tool === 'select' &&
          !props.threeD &&
          selectedBarrier &&
          barrierEnds(props.project, selectedBarrier).map((p, i) => {
            const s = screen(p);
            return s ? (
              <button
                key={i}
                className="vertex-handle"
                aria-label={`Move wall endpoint ${i + 1}`}
                data-wx={p[0]}
                data-wy={p[1]}
                style={{ left: s.x, top: s.y }}
                onPointerDown={e => startDrag(e, 'junction', i ? selectedBarrier.endId : selectedBarrier.startId)}
              />
            ) : null;
          })}
        {props.canEdit &&
          props.tool === 'select' &&
          !props.threeD &&
          selectedBarrier &&
          (() => {
            const [a, b] = barrierEnds(props.project, selectedBarrier);
            const mid: Point = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
            const s = screen(mid);
            return s ? (
              <button
                className="move-handle"
                aria-label="Move whole wall"
                title="Drag to move the wall; connected walls follow"
                data-wx={mid[0]}
                data-wy={mid[1]}
                style={{ left: s.x, top: s.y }}
                onPointerDown={e => startDrag(e, 'barrier', selectedBarrier.id)}
              >
                ✥
              </button>
            ) : null;
          })()}
        {props.canEdit &&
          routeTool &&
          !props.threeD &&
          (props.project.navNodes ?? [])
            .filter(n => visibleOnFloor(n, props.floorId))
            .map(n => {
              const s = screen(n.position);
              return s ? (
                <button
                  key={n.id}
                  className="vertex-handle nav-node-handle"
                  aria-label="Move route node"
                  title="Drag to move this route node"
                  data-wx={n.position[0]}
                  data-wy={n.position[1]}
                  style={{ left: s.x, top: s.y }}
                  onPointerDown={e => startDrag(e, 'node', n.id)}
                />
              ) : null;
            })}
        {props.draft.map((p, i) => {
          const s = screen(p);
          return s ? (
            <i key={i} className="draft-node" data-wx={p[0]} data-wy={p[1]} style={{ left: s.x, top: s.y }} />
          ) : null;
        })}
        {props.alignment?.map.map((p, i) => {
          const s = screen(p);
          return s ? (
            <b key={i} className="alignment-pin" data-wx={p[0]} data-wy={p[1]} style={{ left: s.x, top: s.y }}>
              {i + 1}
            </b>
          ) : null;
        })}
      </div>
      {props.threeD && (
        <label className="pitch-control" title="Camera inclination (⇧W / ⇧S)">
          <Mountain size={14} />
          <input
            type="range"
            min={0}
            max={75}
            step={1}
            value={Math.round(pitch)}
            aria-label="Camera inclination"
            onChange={e => map.current?.easeTo({ pitch: Number(e.target.value), duration: 0 })}
          />
        </label>
      )}
      <div className="map-navigator">
        <button title="Zoom in" aria-label="Zoom in" onClick={() => map.current?.zoomIn()}>
          <Plus size={18} />
        </button>
        <button title="Zoom out" aria-label="Zoom out" onClick={() => map.current?.zoomOut()}>
          <Minus size={18} />
        </button>
        <div />
        {props.threeD && (
          <>
            <button
              title="Tilt view"
              aria-label="Tilt view"
              onClick={() => {
                const m = map.current;
                if (m) m.easeTo({ pitch: m.getPitch() >= 50 ? 20 : m.getPitch() + 15, duration: 400 });
              }}
            >
              <Mountain size={17} />
            </button>
            <button
              title="Rotate left"
              aria-label="Rotate left"
              onClick={() => {
                const m = map.current;
                if (m) m.easeTo({ bearing: m.getBearing() - 45, duration: 450 });
              }}
            >
              <RotateCcw size={17} />
            </button>
            <button
              title="Rotate right"
              aria-label="Rotate right"
              onClick={() => {
                const m = map.current;
                if (m) m.easeTo({ bearing: m.getBearing() + 45, duration: 450 });
              }}
            >
              <RotateCw size={17} />
            </button>
            <div />
          </>
        )}
        <button title="Fit floor" aria-label="Fit floor" onClick={() => fit(props.floorId)}>
          <LocateFixed size={18} />
        </button>
        <button
          title="Reset north"
          aria-label="Reset north"
          onClick={() => map.current?.easeTo({ bearing: siteBearing(props.project), pitch: props.threeD ? 35 : 0 })}
        >
          <Compass size={18} />
        </button>
      </div>
      {props.walk && (
        <div className="walk-hud">
          <div className="walk-status">
            {walkHint.where && <b>{walkHint.where}</b>}
            {walkHint.up && (
              <span>
                <kbd>F</kbd> up to {walkHint.up}
              </span>
            )}
            {walkHint.down && (
              <span>
                <kbd>⇧F</kbd> down to {walkHint.down}
              </span>
            )}
          </div>
          <div className={`walk-keys ${walkHint.looking ? 'busy' : ''}`}>
            <span>Drag to look around</span>
            <span>
              <kbd>W</kbd>
              <kbd>A</kbd>
              <kbd>S</kbd>
              <kbd>D</kbd> walk
            </span>
            <span>
              <kbd>←</kbd>
              <kbd>→</kbd> turn
            </span>
            <span>
              <kbd>Shift</kbd> hurry
            </span>
            <span>
              <kbd>Esc</kbd> leave
            </span>
          </div>
        </div>
      )}
      <div className="map-scale">
        <span style={{ width: scaleWidth }} />
        10 m <i />{' '}
        {props.threeD
          ? `${props.stack ? 'Building stack' : (floor?.name ?? 'Outdoor site')} · ${depthView.buried ? `${floor ? `${Math.abs(floor.elevation).toFixed(1)} m below ground` : 'Below-ground structure'}${depthView.compressed ? (floor ? ` · shown at ${Math.abs(depthView.focusElevation).toFixed(1)} m` : ' · depth compressed') : ''}` : 'cutaway'}`
          : 'metres'}
      </div>
      {mapError && (
        <button className="map-error" onClick={() => setMapError('')}>
          {mapError} ×
        </button>
      )}
      {!ready && !mapError && (
        <div className="map-loading">
          <span className="loading-orbit" />
          Preparing your space…
        </div>
      )}
    </div>
  );
}
