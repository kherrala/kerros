import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDownToLine,
  ArrowLeft,
  ArrowUpFromLine,
  Bell,
  Box,
  Building2,
  ChevronDown,
  ChevronRight,
  Compass,
  ChevronUp,
  CircleHelp,
  Eye,
  Copy,
  FileImage,
  Hand,
  Landmark,
  Layers3,
  Leaf,
  MapPin,
  Maximize2,
  Minimize2,
  Moon,
  MousePointer2,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Plus,
  Radio,
  Redo2,
  Ruler,
  Rows2,
  Shapes,
  Scissors,
  SquareDashedBottom,
  Search,
  Settings2,
  ShieldCheck,
  Sun,
  Undo2,
  Waypoints,
  X,
} from 'lucide-react';
import type { Map as GLMap } from 'maplibre-gl';
import type {
  Barrier,
  Drawing,
  Floor,
  NavNode,
  ObjectKind,
  Point,
  ProjectDocument,
  SiteObject,
  Tool,
} from './model/types';
import type { StatusReading } from './model/live';
import type { SitePlannerProps } from './model/host';
import { isArea, isDevice, isOpening, uid } from './model/types';
import {
  add,
  addBarrier,
  alignDrawing,
  barrierEnds,
  segmentProjection,
  centroid,
  closeRing,
  distance,
  duplicateFloor,
  removeBarrier,
  removeFloor,
  objectArea,
  objectPosition,
  openRing,
  pointInRing,
  ringArea,
  rectangle,
  snapPoint,
  splitRoom,
  toLngLat,
} from './model/geometry';
import { fitOpening, proposeWall, referenceAxis, type OpeningFit, type WallProposal } from './model/walls';
import { divideSpaces, mergeSpaces, spacesRejoinedBy } from './model/inference';
import { enclosedRegion, enclosedRegions, refitEnclosedRooms } from './model/spaces';
import { pruneOntology } from './model/ontology';
import { derivedGraph } from './model/topology';
import { importPlanEntities, type PlanImportReport } from './import/planImport';
import { addNavEdge, addNavNode, chainVertical, findRoute } from './model/navigation';
import { createObject } from './model/factory';
import { transformObject } from './model/project';
import { commitHistory, makeHistory, redoHistory, undoHistory } from './model/history';
import { exportProject } from './adapters/persistence';
import { transact } from './model/validate';
import { useProjectPersistence } from './adapters/useProjectPersistence';
import { neutralBasemap } from './adapters/basemap';
import { openingFloorId } from './model/project';
import { statusTone } from './adapters/status';
import { MapCanvas } from './map/MapCanvas';
import { EntityIcon } from './components/Icons';
import { Inspector } from './components/Inspector';
import { NavigatePanel } from './components/NavigatePanel';
import { StructureView } from './components/StructureView';
import { AlignmentPanel, ImportDialog, makeDrawing, type PreparedDrawing } from './components/ImportDialog';
import { FloorSelect, Modal, Toggle } from './components/controls';
import { EXTERIOR_PRESETS, type ExteriorPreset } from './model/materials';
import { useDarkMode, useKerrosTheme, useStrings } from './theme';

interface Alignment {
  prepared: PreparedDrawing;
  imagePoints: Point[];
  mapPoints: Point[];
  drawing: Drawing;
  preview: boolean;
}
const DRAW_TOOLS: Tool[] = ['wall', 'fence', 'zone', 'room', 'rectangle', 'hole', 'measure', 'evacuation'];
/** Snap labels that mean "an angle is being held", and so deserve naming what it is held to. */
const HELD = new Set(['Parallel', 'Square', '45°']);
/** Default leaf widths, so the preview can size itself before the object exists. Matches factory.ts. */
const OPENING_WIDTH: Record<string, number> = { door: 0.9, window: 1.2, gate: 3.5 };
const PLACE_TOOLS: Tool[] = [
  'door',
  'window',
  'gate',
  'turnstile',
  'reader',
  'camera',
  'elevator',
  'stairs',
  'office',
  'container',
  'storage',
  'poi',
  'sensor',
  'alarm',
  'equipment',
];
function download(text: string, name: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function SitePlanner({
  project: initial,
  adapters,
  onChange,
  onSelectionChange,
  onBack,
  initialView,
  onViewChange,
  onModeChange,
  renderStatusPanel,
  readOnly = false,
}: SitePlannerProps & { readOnly?: boolean }) {
  const [dark, toggleDark] = useDarkMode();
  const [history, setHistory] = useState(() => makeHistory(initial));
  const project = history.present;
  const [floorId, setFloorId] = useState<string | null>(
      initialView?.floor !== undefined &&
        (initialView.floor === null || initial.floors.some(f => f.id === initialView.floor))
        ? initialView.floor
        : openingFloorId(initial),
    ),
    [selected, setSelected] = useState<string | null>(null),
    [focusId, setFocusId] = useState<string | null>(null);
  // Three chrome modes: 'view' browses the plan read-only without live data, 'edit' is the full
  // authoring experience, 'live' overlays the host's status feed on the read-only plan. The last
  // exists only when the host supplied a StatusFeed — with no feed there is nothing to monitor.
  const monitoring = !!adapters.status;
  const [mode, setMode] = useState<'view' | 'edit' | 'live'>(() => {
    const wanted = initialView?.mode;
    if (wanted === 'edit') return readOnly ? 'view' : 'edit';
    if (wanted === 'live') return monitoring ? 'live' : 'view';
    if (wanted === 'view') return 'view';
    return readOnly && monitoring ? 'live' : 'view';
  });
  const editing = mode === 'edit',
    live = mode === 'live';
  const [threeD, setThreeD] = useState(initialView?.threeD ?? initialView?.mode !== 'edit'),
    [stack, setStack] = useState(initialView?.stack ?? false),
    [tool, setTool] = useState<Tool>('select'),
    [draft, setDraft] = useState<Point[]>([]),
    [hover, setHover] = useState<Point | null>(null),
    [proposal, setProposal] = useState<WallProposal | null>(null),
    [openingFit, setOpeningFit] = useState<OpeningFit | null>(null),
    [merge, setMerge] = useState<{ wallId: string; a: SiteObject; b: SiteObject } | null>(null),
    [held, setHeld] = useState(false),
    [snapLabel, setSnapLabel] = useState(''),
    [snapping, setSnapping] = useState(true);
  // The editor owns its document through history, so `project` is the *initial* document — a host's
  // in-flight-edit echoes (same id) are ignored. But swapping to a genuinely different document
  // (new id) without remounting must reset the editor onto it, not silently keep editing the old one.
  const loadedProjectId = useRef(initial.id);
  useEffect(() => {
    if (initial.id === loadedProjectId.current) return;
    loadedProjectId.current = initial.id;
    setHistory(makeHistory(initial));
    setSelected(null);
    setDraft([]);
    setFloorId(openingFloorId(initial));
  }, [initial]);
  const [coverage, setCoverage] = useState(false),
    [showLabels, setShowLabels] = useState(true),
    [basemapMode, setBasemapMode] = useState<'plan' | 'host'>(adapters.basemap ? 'host' : 'plan'),
    [settings, setSettings] = useState(false),
    [palette, setPalette] = useState(false),
    [fullscreen, setFullscreen] = useState(false),
    [showPlan, setShowPlan] = useState(true),
    [evening, setEvening] = useState(false),
    // Opening straight into the editor brings the editor's chrome with it, as enterEdit does.
    [sidebarOpen, setSidebarOpen] = useState(initialView?.mode === 'edit' && !readOnly),
    [inspectorOpen, setInspectorOpen] = useState(false),
    // A soil section explains a basement, and a single cellar does not need explaining: the floor
    // selector already says how far down it is, and the block is bigger than the house. Below two
    // storeys of depth it is scenery in the way; below twenty it is the whole story.
    [excavation, setExcavation] = useState(() => project.floors.filter(f => f.elevation < 0).length > 1),
    [cityBuildings, setCityBuildings] = useState(true),
    [cadastre, setCadastre] = useState(true);
  const [importOpen, setImportOpen] = useState(false),
    [floorModal, setFloorModal] = useState(false),
    [helpOpen, setHelpOpen] = useState(false),
    [deleteOpen, setDeleteOpen] = useState(false),
    [floorDeleteId, setFloorDeleteId] = useState<string | null>(null),
    [alignment, setAlignment] = useState<Alignment | null>(null);
  const [toast, setToast] = useState(''),
    [search, setSearch] = useState(''),
    [activeTab, setActiveTab] = useState<'structure' | 'objects'>('structure'),
    [statuses, setStatuses] = useState<Map<string, StatusReading>>(new Map());
  // Indoor navigation: route-tool chaining anchor, the A-to-B panel and journey playback state.
  const [routeAnchor, setRouteAnchor] = useState<string | null>(null),
    [navigating, setNavigating] = useState(false),
    [structuring, setStructuring] = useState(false),
    [navFrom, setNavFrom] = useState<string | null>(null),
    [navTo, setNavTo] = useState<string | null>(null),
    [playing, setPlaying] = useState(false),
    [playStep, setPlayStep] = useState<number | null>(null);
  const playingRef = useRef(false); // Set imperatively so the final writeHash on journey end is not skipped by a stale ref.
  const stopPlaying = useCallback(() => {
    playingRef.current = false;
    setPlaying(false);
  }, []);
  const route = useMemo(
    () => (navFrom && navTo ? findRoute(history.present, navFrom, navTo) : null),
    [history.present, navFrom, navTo],
  );
  useEffect(() => {
    stopPlaying();
    setPlayStep(null);
  }, [navFrom, navTo, stopPlaying]);
  useEffect(() => {
    if (!route && playingRef.current) stopPlaying();
  }, [route, stopPlaying]);
  const [newFloorName, setNewFloorName] = useState('New floor'),
    [newFloorElevation, setNewFloorElevation] = useState(3),
    [newFloorBuilding, setNewFloorBuilding] = useState(project.buildings[0].id),
    [newBuildingName, setNewBuildingName] = useState(''),
    [collapsedBuildings, setCollapsedBuildings] = useState<Set<string>>(new Set()),
    [showKeys, setShowKeys] = useState(false);
  const mapRef = useRef<GLMap | null>(null),
    toleranceRef = useRef(0.7),
    latestProject = useRef(project),
    onChangeRef = useRef(onChange),
    onViewChangeRef = useRef(onViewChange);
  latestProject.current = project;
  onChangeRef.current = onChange;
  onViewChangeRef.current = onViewChange;
  // The current view (floor, mode, camera pose) is emitted through onViewChange on state changes and
  // on every camera moveend; hosts persist it however they like (the reference app writes a deep-link
  // fragment). The library itself touches no URL. writeHash keeps its name for its call sites.
  const viewRef = useRef({ floorId, threeD, stack });
  viewRef.current = { floorId, threeD, stack };
  const writeHash = useCallback(() => {
    const m = mapRef.current;
    if (!m || playingRef.current) return;
    const v = viewRef.current,
      c = m.getCenter();
    onViewChangeRef.current?.({
      floor: v.floorId,
      threeD: v.threeD,
      stack: v.stack,
      camera: { center: [c.lng, c.lat], zoom: m.getZoom(), bearing: m.getBearing(), pitch: m.getPitch() },
    });
  }, []);
  useEffect(() => {
    writeHash();
  }, [floorId, threeD, stack, writeHash]);
  const theme = useKerrosTheme();
  const en = useStrings();
  const notify = useCallback(
    (message: string) => {
      if (theme.notify) theme.notify(message);
      else setToast(message);
    },
    [theme],
  );
  // Any selection, from any code path, reveals the properties panel (closed by default).
  useEffect(() => {
    if (selected) setInspectorOpen(true);
  }, [selected]);
  const { state: saveState, flush } = useProjectPersistence(project, adapters.projects, !readOnly, notify);
  const leave = async () => {
    try {
      await flush();
      onBack?.();
    } catch {
      /* Keep the editable project open on a failed save. */
    }
  };
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(''), 6500);
    return () => clearTimeout(t);
  }, [toast]);
  // Every edit is a transaction: transact works on a clone, runs the full rule set, and returns a
  // frozen document or the reason it refused — the plan on screen is always a valid one.
  const commit = (change: (draft: ProjectDocument) => void): boolean => {
    if (!editing) return false;
    const result = transact(project, change);
    if (!result.ok) {
      notify(result.error);
      return false;
    }
    setHistory(current => commitHistory(current, result.project));
    return true;
  };
  /** Commit a change that moves walls, and let the rooms those walls define follow them.
   *
   *  A room keeps its own outline — that is what lets a space exist where no wall does — so without
   *  this, editing a wall and resizing the room beside it are two jobs, and the plan quietly drifts
   *  out of agreement with itself. Snapshotting the enclosed regions either side of the change is
   *  what tells the two apart: a room that was standing in one of them was being defined by the
   *  walls and takes its new shape; a room that was drawn freehand is nobody's business but its
   *  author's. Every mutation that moves, thickens, adds or removes a wall goes through here. */
  const reshape = (change: (draft: ProjectDocument) => void): boolean =>
    commit(p => {
      const enclosed = enclosedRegions(p, floorId);
      change(p);
      refitEnclosedRooms(p, floorId, enclosed);
    });
  useEffect(() => {
    if (!readOnly) onChangeRef.current?.(project);
  }, [project, readOnly]);
  const bindingKey = project.objects
    .filter(o => o.feedId)
    .map(o => o.feedId)
    .sort()
    .join('|');
  useEffect(() => {
    setStatuses(new Map());
  }, [project.id]);
  useEffect(() => {
    return adapters.status?.subscribe(latestProject.current, values =>
      setStatuses(current => {
        const next = new Map(current);
        for (const status of values) next.set(status.feedId, status);
        return next;
      }),
    );
  }, [adapters.status, bindingKey, project.id]);
  useEffect(() => {
    const timer = setInterval(() => setStatuses(current => new Map(current)), 5000);
    return () => clearInterval(timer);
  }, []);
  // Plan viewer browses pure architecture; the editor keeps statuses visible (authors simulate
  // bindings while wiring them) and 'live' is the dedicated monitoring surface.
  const shownStatuses = useMemo(
    () => (mode === 'view' ? new Map<string, StatusReading>() : statuses),
    [mode, statuses],
  );
  const basemap = basemapMode === 'host' && adapters.basemap ? adapters.basemap : neutralBasemap;
  // A host basemap that declares a vectorSchema unlocks the schema-driven features; each is gated on
  // the specific part it needs (footprints → adopt/3D-city, cadastre → the parcel overlay).
  const surveyed = basemapMode === 'host' && !!adapters.basemap?.vectorSchema;
  const canAdopt = surveyed && !!adapters.basemap?.vectorSchema?.footprints;
  const hasCadastre = surveyed && !!adapters.basemap?.vectorSchema?.cadastre;
  const floor = project.floors.find(f => f.id === floorId);
  const alarms = useMemo(
    () => project.objects.filter(o => o.feedId && statusTone(statuses.get(o.feedId)) === 'critical'),
    [statuses, project],
  );
  const alarmFloors = useMemo(() => new Set(alarms.map(o => o.floorId)), [alarms]);
  // Report the current surface to the host (a monitoring host can start/stop its feed's traffic here).
  const onModeChangeRef = useRef(onModeChange);
  onModeChangeRef.current = onModeChange;
  useEffect(() => {
    onModeChangeRef.current?.(mode);
  }, [mode]);
  // Live view auto-attention: if the user has been idle for 5 s and a new alarm is active on the
  // open floor, pan to it (each alarm pans once; a cleared-then-retriggered binding pans again).
  const lastInput = useRef(Date.now()),
    autoPanned = useRef(new Set<string>());
  useEffect(() => {
    const mark = () => {
      lastInput.current = Date.now();
    };
    const types = ['pointerdown', 'wheel', 'keydown', 'touchstart'];
    for (const t of types) window.addEventListener(t, mark, true);
    return () => {
      for (const t of types) window.removeEventListener(t, mark, true);
    };
  }, []);
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => {
      const active = new Set(alarms.map(o => o.id));
      for (const id of autoPanned.current) if (!active.has(id)) autoPanned.current.delete(id);
      if (Date.now() - lastInput.current < 5000) return;
      const target = alarms.find(o => o.floorId === floorId && !autoPanned.current.has(o.id));
      if (target) {
        autoPanned.current.add(target.id);
        setFocusId(target.id);
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [live, alarms, floorId]); // eslint-disable-line react-hooks/exhaustive-deps
  // Mode entry keeps the chrome consistent: only the editor needs the side panels open by default.
  function enterView() {
    setMode('view');
    setTool('select');
    setDraft([]);
    setSidebarOpen(false);
    setInspectorOpen(false);
    setThreeD(true);
  }
  function enterEdit() {
    if (readOnly) return;
    setMode('edit');
    setThreeD(false);
    setSidebarOpen(true);
  }
  function enterLive() {
    setMode('live');
    setTool('select');
    setDraft([]);
    setSidebarOpen(false);
    setInspectorOpen(false);
    setThreeD(true);
  }
  function floorBand() {
    return project.floors
      .filter(f => f.buildingId === (floor?.buildingId ?? project.buildings[0].id))
      .sort((a, b) => a.elevation - b.elevation);
  }
  function floorCode(f: Floor) {
    if (f.code) return f.code;
    return f.mezzanine
      ? 'M'
      : f.elevation < 0
        ? 'B' +
          project.floors.filter(
            x => x.buildingId === f.buildingId && !x.mezzanine && x.elevation < 0 && x.elevation >= f.elevation,
          ).length
        : String(
            project.floors.filter(
              x => x.buildingId === f.buildingId && !x.mezzanine && x.elevation >= 0 && x.elevation < f.elevation,
            ).length,
          ).padStart(2, '0');
  }
  function stepFloor(direction: 1 | -1) {
    const list = floorBand();
    const index = list.findIndex(f => f.id === floorId);
    const next = index < 0 ? (direction === 1 ? list[0] : list[list.length - 1]) : list[index + direction];
    if (next) changeFloor(next.id);
  }
  const keyHint = (label: string) => (showKeys ? <kbd className="key-hint">{label}</kbd> : null);
  function select(id: string | null, focus = false) {
    const entity =
      project.objects.find(o => o.id === id) ??
      project.barriers.find(b => b.id === id) ??
      project.drawings.find(d => d.id === id);
    if (entity && entity.floorId !== floorId && entity.floorId !== null) {
      setFloorId(entity.floorId);
      setDraft([]);
      setRouteAnchor(null);
      if (tool !== 'select' && tool !== 'pan') setTool('select');
    }
    setSelected(id);
    onSelectionChange?.(id);
    if (id) setInspectorOpen(true);
    if (focus) setFocusId(id);
  }
  function changeFloor(id: string | null) {
    setFloorId(id);
    setSelected(null);
    setDraft([]);
    setTool('select');
    setAlignment(null);
    setRouteAnchor(null);
  }
  function chooseTool(next: Tool) {
    if (next === 'hole') {
      const o = project.objects.find(o => o.id === selected);
      if (!o?.rings) {
        notify('Select an area first, then use Cut a hole.');
        return;
      }
    }
    setTool(next);
    setDraft([]);
    setProposal(null);
    setOpeningFit(null);
    setPalette(false);
    setThreeD(false);
    setRouteAnchor(null);
  }
  function updateObject(id: string, patch: Partial<SiteObject>) {
    commit(p => transformObject(p.objects.find(o => o.id === id)!, patch));
  }
  function finish() {
    if (tool === 'wall' || tool === 'fence' || tool === 'measure') {
      setDraft([]);
      setTool('select');
      return;
    }
    if (!['zone', 'room', 'hole', 'evacuation'].includes(tool) || draft.length < 3) {
      notify('Add at least three points to finish an area.');
      return;
    }
    const rings = [closeRing(draft)];
    const success = commit(p => {
      if (tool === 'hole') {
        const o = p.objects.find(o => o.id === selected);
        if (!o?.rings) throw new Error('Select an area first.');
        o.rings.push(rings[0]);
      } else {
        const object = createObject(tool as ObjectKind, centroid(draft), floorId);
        object.rings = rings;
        const xs = draft.map(p => p[0]),
          ys = draft.map(p => p[1]);
        object.width = Math.max(...xs) - Math.min(...xs);
        object.depth = Math.max(...ys) - Math.min(...ys);
        p.objects.push(object);
        setSelected(object.id);
      }
    });
    if (success) {
      setDraft([]);
      setTool('select');
    }
  }
  function mapClick(raw: Point, id: string | null) {
    // On small screens the sidebar is a slide-over sheet: touching the map puts the map first.
    if (window.matchMedia('(max-width: 840px)').matches) setSidebarOpen(false);
    if (alignment) {
      if (alignment.preview || alignment.imagePoints.length < 2 || alignment.mapPoints.length >= 2) return;
      setAlignment({ ...alignment, mapPoints: [...alignment.mapPoints, raw] });
      return;
    }
    if (!editing || tool === 'select' || threeD) {
      select(id);
      return;
    }
    if (tool === 'pan') return;
    if (tool === 'partition') {
      // Recomputed from the click rather than reused from hover, so a tap that never hovered (touch)
      // creates exactly the wall a pointer would have been shown.
      const offer = proposeWall(project, floorId, raw);
      if (offer)
        commit(p => {
          addBarrier(p, offer.segment[0], offer.segment[1], floorId, 'wall');
          divideSpaces(p, floorId, offer.segment[0], offer.segment[1]);
        });
      setProposal(null);
      return;
    }
    // Read a space off the walls that already surround the click, rather than asking someone to
    // trace an outline the drawing has already stated. The click lands in exactly one enclosed
    // region or in none, so there is nothing to aim at but the room itself.
    if (tool === 'enclose') {
      const ring = enclosedRegion(project, floorId, raw);
      if (!ring) {
        notify('Nothing encloses that point. The walls around it have a gap, or it is outside the building.');
        return;
      }
      const existing = project.objects.find(
        o => o.floorId === floorId && o.kind === 'room' && o.rings?.length && pointInRing(raw, o.rings[0]),
      );
      const done = commit(p => {
        if (existing) {
          // Clicking inside a room that has drifted from its walls re-fits it instead of stacking a
          // second room on top of the first. Same operation as a wall drag performs, asked for
          // directly — and it keeps the room's name and bindings, which a delete-and-redraw loses.
          const room = p.objects.find(o => o.id === existing.id)!;
          room.rings = [closeRing(ring), ...(room.rings ?? []).slice(1)];
          room.position = centroid(ring);
          const xs = ring.map(q => q[0]),
            ys = ring.map(q => q[1]);
          room.width = Math.max(...xs) - Math.min(...xs);
          room.depth = Math.max(...ys) - Math.min(...ys);
          setSelected(room.id);
          return;
        }
        const room = createObject('room', centroid(ring), floorId, 'Room');
        room.rings = [closeRing(ring)];
        const xs = ring.map(q => q[0]),
          ys = ring.map(q => q[1]);
        room.width = Math.max(...xs) - Math.min(...xs);
        room.depth = Math.max(...ys) - Math.min(...ys);
        p.objects.push(room);
        setSelected(room.id);
      });
      // Only when it took. A rejected commit has already said why, and a second toast claiming
      // success on top of it would contradict the first.
      if (done)
        notify(
          existing
            ? `“${existing.name}” re-fitted to the walls around it · ${Math.abs(ringArea(ring)).toFixed(1)} m²`
            : `Space taken from the walls · ${Math.abs(ringArea(ring)).toFixed(1)} m²`,
        );
      return;
    }
    const anchor = draft.at(-1);
    const axis = snapping && anchor ? heldAxis(anchor).angle : 0;
    const point = snapping ? snapPoint(project, floorId, raw, toleranceRef.current, anchor, true, axis).point : raw;
    if (tool === 'wall' || tool === 'fence') {
      if (!draft.length) setDraft([point]);
      else if (
        commit(p => {
          addBarrier(p, draft.at(-1)!, point, floorId, tool);
          // A wall across a space really does divide it. Leaving the space whole would model both
          // halves as the same place: routing walks through the wall, and they cannot be told apart
          // by a zone. Walls only: a fence is left to enclose ground without carving it up, since
          // outdoor space is usually one large area and splitting it at every fence line surprises
          // more often than it helps. Draw the compound as its own space when you want that.
          if (tool === 'wall') divideSpaces(p, floorId, draft.at(-1)!, point);
        })
      )
        setDraft([point]);
      return;
    }
    if (tool === 'rectangle') {
      if (!draft.length) {
        setDraft([point]);
        return;
      }
      const a = draft[0];
      if (
        commit(p => {
          const o = createObject('zone', [(a[0] + point[0]) / 2, (a[1] + point[1]) / 2], floorId, 'New area');
          o.width = Math.abs(a[0] - point[0]);
          o.depth = Math.abs(a[1] - point[1]);
          o.rings = [rectangle(o.position, o.width, o.depth)];
          p.objects.push(o);
          setSelected(o.id);
        })
      ) {
        setDraft([]);
        setTool('select');
      }
      return;
    }
    if (['zone', 'room', 'hole', 'evacuation'].includes(tool)) {
      if (draft.length >= 3 && distance(point, draft[0]) < toleranceRef.current) finish();
      else setDraft([...draft, point]);
      return;
    }
    if (tool === 'measure') {
      setDraft(draft.length >= 2 ? [point] : [...draft, point]);
      return;
    }
    if (tool === 'split') {
      if (!draft.length) {
        setDraft([point]);
        return;
      }
      // The room being split is the smallest room/zone containing the cut's midpoint.
      const mid: Point = [(draft[0][0] + point[0]) / 2, (draft[0][1] + point[1]) / 2];
      const target = project.objects
        .filter(
          o =>
            o.floorId === floorId &&
            (o.kind === 'room' || o.kind === 'zone') &&
            o.rings &&
            pointInRing(mid, o.rings[0]),
        )
        .sort((a, b) => objectArea(a) - objectArea(b))[0];
      if (!target) {
        notify('Draw the cut across a room — you can start and end past the walls.');
        return;
      }
      if (
        commit(p => {
          const twin = splitRoom(p, target.id, draft[0], point);
          setSelected(twin);
        })
      ) {
        setDraft([]);
        setTool('select');
      }
      return;
    }
    if (tool === 'route') {
      // Route authoring chains nav nodes: lifts/stairs thread all served floors (chainVertical),
      // doors/POIs/rooms get a bound node at the object, anywhere else a free node at the snap
      // point. A kept anchor links each new node to the previous one — 'door' edges when either
      // end binds a door/gate/turnstile — and every mutation runs through commit() for undo.
      const hit = id ? project.objects.find(o => o.id === id) : undefined;
      let targetId: string | null = null;
      const ok = commit(p => {
        const obj = hit ? p.objects.find(o => o.id === hit.id) : undefined;
        let target: NavNode | undefined;
        if (obj && (obj.kind === 'elevator' || obj.kind === 'stairs')) {
          const chain = chainVertical(p, obj);
          target = chain.find(n => n.floorId === floorId);
          if (!target)
            throw new Error(`${obj.name} does not serve this floor — set its served floors in the properties panel.`);
        } else if (obj && ['door', 'gate', 'turnstile', 'poi', 'room'].includes(obj.kind))
          target = addNavNode(p, obj.floorId, objectPosition(p, obj), obj.id);
        else target = addNavNode(p, floorId, point);
        const anchor = routeAnchor ? (p.navNodes ?? []).find(n => n.id === routeAnchor) : undefined;
        if (anchor && anchor.id !== target.id) {
          const doorOf = (n: NavNode) => {
            const o = n.objectId ? p.objects.find(x => x.id === n.objectId) : undefined;
            return o && ['door', 'gate', 'turnstile'].includes(o.kind) ? o : undefined;
          };
          const doorObj = doorOf(anchor) ?? doorOf(target);
          addNavEdge(p, doorObj ? 'door' : 'walk', anchor, target, doorObj?.id);
        }
        targetId = target.id;
      });
      if (ok) setRouteAnchor(targetId);
      return;
    }
    if (PLACE_TOOLS.includes(tool)) {
      // One click, one object, and the tool is done. These tools place a single thing and leave it
      // selected, so staying armed means the next click — on the thing you just placed, to move it
      // or read it — drops another one on top instead. Drawing tools are different: a wall or a zone
      // takes several clicks, so they stay until the shape is finished.
      const placed = commit(p => {
        const o = createObject(tool as ObjectKind, point, floorId);
        if (isOpening(o.kind)) {
          // The very fit the preview drew. Two copies of this rule would drift apart, and a preview
          // that disagrees with the click is worse than no preview at all.
          const fit = fitOpening(p, floorId, o.kind as 'door', raw, o.width, openingReach());
          if (!fit) throw new Error(`Place this ${o.kind} on a ${o.kind === 'gate' ? 'fence' : 'wall'}.`);
          o.barrierId = fit.barrierId;
          o.offset = fit.offset;
          o.position = fit.position;
        }
        if (isDevice(o.kind)) o.feedId = `device-${o.id}`;
        if (isArea(o.kind)) o.rings = [rectangle(o.position, o.width, o.depth)];
        p.objects.push(o);
        setSelected(o.id);
      });
      if (placed) setTool('select');
    }
  }
  // A basemap building becomes a first-class model: its own building entry (carrying the basemap
  // source id), estimated storeys with facade walls and a zone per floor — ready to edit further.
  function adoptBuilding({
    rings,
    sourceId,
    storeys,
    name,
  }: {
    rings: Point[][];
    sourceId: string | number;
    storeys: number;
    name: string;
  }) {
    let groundFloor = '';
    const success = commit(p => {
      if (p.buildings.some(b => b.sourceId === sourceId))
        throw new Error('That building is already part of this project.');
      const bid = uid();
      p.buildings.push({ id: bid, name, sourceId });
      const outline = rings[0];
      const xs = outline.map(pt => pt[0]),
        ys = outline.map(pt => pt[1]);
      const copyRings = () => rings.map(r => closeRing(r.map(pt => [...pt] as Point)));
      const footprint = createObject('building', centroid(outline), null, name);
      footprint.rings = copyRings();
      footprint.width = Math.max(...xs) - Math.min(...xs);
      footprint.depth = Math.max(...ys) - Math.min(...ys);
      p.objects.push(footprint);
      for (let i = 0; i < storeys; i++) {
        const fid = uid();
        if (!i) groundFloor = fid;
        p.floors.push({
          id: fid,
          buildingId: bid,
          name: `${name} · ${i ? `floor ${i}` : 'ground'}`,
          elevation: i * 3.5,
          height: 3.5,
        });
        const zone = createObject('zone', centroid(outline), fid, name);
        zone.rings = copyRings();
        zone.width = footprint.width;
        zone.depth = footprint.depth;
        zone.color = '#f7f8f6';
        p.objects.push(zone);
        const from = p.barriers.length;
        const closed = closeRing(outline.map(pt => [...pt] as Point));
        for (let k = 1; k < closed.length; k++) addBarrier(p, closed[k - 1], closed[k], fid, 'wall');
        p.barriers.slice(from).forEach(b => {
          b.name = 'Facade wall';
          b.thickness = 0.45;
          b.color = '#a6acb8';
        });
      }
    });
    if (success) {
      setTool('select');
      if (groundFloor) changeFloor(groundFloor);
      notify(
        `Adopted “${name}” from the basemap · ${storeys} floor${storeys > 1 ? 's' : ''} created from MML attributes.`,
      );
    }
  }
  /** How far away a wall can be and still be the thing a new wall lines up with. Derived from the
   *  view's own tolerance so it stays a roughly constant distance on screen at any zoom. */
  const axisReach = () => toleranceRef.current * 8;
  /** How far an opening looks for a wall. Shared, so a preview cannot promise a fit the click refuses. */
  const openingReach = () => Math.max(2, toleranceRef.current * 2);
  const isOpeningTool = (t: string) => t === 'door' || t === 'window' || t === 'gate';
  const heldAxis = (anchor: Point) => referenceAxis(project, floorId, anchor, axisReach());
  const onHover = (point: Point, tolerance: number) => {
    toleranceRef.current = tolerance;
    if (tool === 'select' || tool === 'pan' || threeD || !editing) return;
    if (isOpeningTool(tool)) {
      // Show the leaf on the wall it would land on, before the click rather than after it. Placing an
      // opening used to be blind: you clicked and either it took or you got an error telling you to
      // aim at a wall you could not see the edge of.
      setHover(point);
      setOpeningFit(fitOpening(project, floorId, tool as 'door', point, OPENING_WIDTH[tool] ?? 0.9, openingReach()));
      return;
    }
    if (tool === 'partition') {
      // Deliberately not gated on `snapping`: that toggle governs pulling a point onto a junction or
      // the grid, whereas inferring the wall is the entire tool. Off, it would just do nothing.
      setHover(point);
      setProposal(proposeWall(project, floorId, point));
      return;
    }
    const anchor = draft.at(-1);
    // The wall lines up with what is near where it starts, not where the pointer has wandered to —
    // otherwise the reference flips mid-drag and the wall swings with it.
    const axis = snapping && anchor ? heldAxis(anchor) : null;
    const snap = snapping
      ? snapPoint(project, floorId, point, tolerance, anchor, true, axis?.angle ?? 0)
      : { point, label: '' };
    const holding = !!axis && HELD.has(snap.label);
    setHover(snap.point);
    setHeld(holding);
    setSnapLabel(holding ? `${snap.label} to ${axis.source}` : snap.label);
  };
  /** What the map draws to explain the wall about to exist: the axis a wall is being held to — run
   *  past both ends so it reads as a line the wall lies on rather than as the wall — or the whole
   *  segment the partition tool is offering. */
  const guides = useMemo<{ line: [Point, Point]; role: 'guide' | 'proposal' }[]>(() => {
    if (!editing || threeD) return [];
    if (isOpeningTool(tool)) return openingFit ? [{ line: openingFit.span, role: 'proposal' }] : [];
    if (tool === 'partition') return proposal ? [{ line: proposal.segment, role: 'proposal' }] : [];
    const anchor = draft.at(-1);
    if (!held || !anchor || !hover) return [];
    const length = distance(anchor, hover);
    if (length < 0.01) return [];
    const ux = (hover[0] - anchor[0]) / length,
      uy = (hover[1] - anchor[1]) / length,
      tail = 8;
    return [
      {
        line: [
          [anchor[0] - ux * tail, anchor[1] - uy * tail],
          [hover[0] + ux * tail, hover[1] + uy * tail],
        ],
        role: 'guide',
      },
    ];
  }, [editing, threeD, tool, proposal, openingFit, draft, hover, held]);
  function vertexMove(
    kind: 'junction' | 'ring' | 'object' | 'barrier' | 'node' | 'opening' | 'rotate' | 'coverage',
    id: string,
    raw: Point,
    ringIndex = 0,
    index = 0,
    free = false,
  ) {
    // Shift releases the drop from the grid — the escape hatch for a camera that has to point at a
    // particular corner, or a wall that genuinely runs at 3°.
    const grid = snapping && !free;
    const point: Point = grid ? [Math.round(raw[0] * 2) / 2, Math.round(raw[1] * 2) / 2] : raw;
    if (kind === 'object') {
      updateObject(id, { position: point });
      return;
    }
    // An opening lives on its wall, so a drag slides it along that wall rather than moving it to
    // where the pointer went. Offset is clamped so the leaf stays wholly on the segment — the same
    // rule validation enforces, applied while dragging instead of refused afterwards.
    if (kind === 'opening') {
      const opening = project.objects.find(o => o.id === id);
      const barrier = project.barriers.find(b => b.id === opening?.barrierId);
      if (!opening || !barrier) return;
      const [a, b] = barrierEnds(project, barrier);
      const hit = segmentProjection(raw, a, b);
      const half = opening.width / 2;
      if (hit.length < opening.width) return;
      const offset = Math.max(half, Math.min(hit.length - half, hit.t * hit.length));
      const ux = (b[0] - a[0]) / hit.length,
        uy = (b[1] - a[1]) / hit.length;
      updateObject(id, { offset, position: [a[0] + ux * offset, a[1] + uy * offset] });
      return;
    }
    if (kind === 'rotate') {
      const object = project.objects.find(o => o.id === id);
      if (!object) return;
      const degrees = (Math.atan2(raw[1] - object.position[1], raw[0] - object.position[0]) * 180) / Math.PI;
      // Snapping holds a turned object to 15° detents; Shift lets it point anywhere.
      updateObject(id, { rotation: grid ? Math.round(degrees / 15) * 15 : Math.round(degrees * 10) / 10 });
      return;
    }
    // One handle carries both halves of a camera's cone: its distance is the reach, its bearing off
    // the camera's facing is half the field of view.
    if (kind === 'coverage') {
      const object = project.objects.find(o => o.id === id);
      if (!object) return;
      const dx = raw[0] - object.position[0],
        dy = raw[1] - object.position[1];
      const range = Math.max(1, Math.min(120, Math.hypot(dx, dy)));
      const bearing = (Math.atan2(dy, dx) * 180) / Math.PI;
      const half = Math.abs(((((bearing - (object.rotation ?? 0)) % 360) + 540) % 360) - 180);
      const spread = Math.max(10, Math.min(350, half * 2));
      updateObject(id, {
        coverageRange: Math.round(range * 10) / 10,
        coverageAngle: grid ? Math.round(spread / 5) * 5 : Math.round(spread),
      });
      return;
    }
    if (kind === 'node') {
      commit(p => {
        const n = (p.navNodes ?? []).find(n => n.id === id);
        if (n) n.position = point;
      });
      return;
    }
    reshape(p => {
      if (kind === 'junction') {
        const j = p.junctions.find(j => j.id === id)!;
        j.position = point;
        for (const b of p.barriers.filter(b => b.startId === id || b.endId === id))
          if (distance(...barrierEnds(p, b)) < 0.1) throw new Error('A wall must remain at least 0.1 m long.');
      } else if (kind === 'barrier') {
        // Whole-wall translation constrained to the wall's normal: the wall slides orthogonally to
        // itself (resizing the rooms it separates); junctions are shared so adjacent walls stretch
        // to follow and the mesh stays connected. Snapping quantises the slide distance.
        const b = p.barriers.find(b => b.id === id)!;
        const [a, c] = barrierEnds(p, b);
        const len = distance(a, c);
        const nx = -(c[1] - a[1]) / len,
          ny = (c[0] - a[0]) / len;
        let s = (raw[0] - (a[0] + c[0]) / 2) * nx + (raw[1] - (a[1] + c[1]) / 2) * ny;
        if (snapping) s = Math.round(s * 2) / 2;
        const dx = nx * s,
          dy = ny * s;
        for (const jid of [b.startId, b.endId]) {
          const j = p.junctions.find(j => j.id === jid)!;
          j.position = [j.position[0] + dx, j.position[1] + dy];
        }
        for (const other of p.barriers.filter(
          x => x.startId === b.startId || x.endId === b.startId || x.startId === b.endId || x.endId === b.endId,
        ))
          if (distance(...barrierEnds(p, other)) < 0.1) throw new Error('A wall must remain at least 0.1 m long.');
      } else {
        const o = p.objects.find(o => o.id === id)!;
        const points = openRing(o.rings![ringIndex]);
        points[index] = point;
        o.rings![ringIndex] = closeRing(points);
        o.position = centroid(o.rings![0]);
      }
    });
  }
  /** Write the derived graph into the document, so it can be edited.
   *
   *  A plan with no authored graph still routes: navNodes() falls back to the dual of spaces and
   *  portals, recomputed from the geometry, and that is usually the right thing to leave alone —
   *  a stored graph is a second description of what connects to what, and two descriptions drift.
   *  What you cannot do with a derived graph is change it. Adopting it freezes the current one into
   *  the document as a starting point; from then on it is yours, and it stops following the plan. */
  function adoptDerivedGraph() {
    const { nodes, edges } = derivedGraph(project);
    if (
      commit(p => {
        p.navNodes = nodes.map(n => ({ ...n }));
        p.navEdges = edges.map(e => ({ ...e }));
      })
    )
      notify(
        `Adopted ${nodes.length} node${nodes.length === 1 ? '' : 's'} and ${edges.length} edges · the graph no longer follows the plan.`,
      );
  }
  function duplicateSelected() {
    if (!selected) return;
    commit(p => {
      const o = p.objects.find(o => o.id === selected);
      if (!o || o.barrierId) return;
      const clone = structuredClone(o);
      clone.id = uid();
      clone.name += ' copy';
      clone.feedId = undefined;
      clone.parentId = undefined;
      clone.position = add(clone.position, [2, -2]);
      clone.rings = clone.rings?.map(r => r.map(pt => add(pt, [2, -2])));
      p.objects.push(clone);
      setSelected(clone.id);
    });
  }
  /** Deleting a floor takes its contents with it, so it always confirms — via the host's dialog when
   *  one is supplied, otherwise the built-in modal. */
  function floorLoss(id: string) {
    const objects = project.objects.filter(o => o.floorId === id).length;
    const barriers = project.barriers.filter(b => b.floorId === id).length;
    const parts = [
      objects && `${objects} object${objects > 1 ? 's' : ''}`,
      barriers && `${barriers} wall${barriers > 1 ? 's' : ''}`,
    ].filter(Boolean);
    return parts.length ? `This also removes ${parts.join(' and ')}.` : 'This floor is empty.';
  }
  function deleteFloorNow(id: string) {
    const fallback = project.floors.filter(f => f.id !== id).sort((a, b) => a.elevation - b.elevation);
    if (commit(p => void removeFloor(p, id))) {
      if (floorId === id) changeFloor(fallback.find(f => f.elevation === 0)?.id ?? fallback[0]?.id ?? null);
      notify('Floor removed with everything on it. Undo restores it.');
    }
    setFloorDeleteId(null);
  }
  async function requestDeleteFloor(id: string) {
    if (project.floors.length <= 1) {
      notify('A project needs at least one floor.');
      return;
    }
    if (!theme.confirm) {
      setFloorDeleteId(id);
      return;
    }
    const floor = project.floors.find(f => f.id === id);
    if (
      await theme.confirm({
        title: `Delete ${floor?.name ?? 'this floor'}?`,
        body: floorLoss(id),
        danger: true,
        confirmLabel: 'Delete floor',
      })
    )
      deleteFloorNow(id);
  }
  async function requestDelete() {
    if (!selected) return;
    if (!theme.confirm) {
      setDeleteOpen(true);
      return;
    }
    if (
      await theme.confirm({
        title: 'Delete selected object?',
        body: deleteCount
          ? `This also removes ${deleteCount} attached opening${deleteCount > 1 ? 's' : ''}.`
          : 'Child zones become independent areas.',
        danger: true,
        confirmLabel: 'Delete object',
      })
    )
      deleteSelected();
  }
  function deleteSelected() {
    if (!selected) return;
    // A wall that was the only thing between two spaces leaves them open to each other. Saying
    // nothing would leave the plan showing two rooms where there is now one; merging silently would
    // destroy a name, its feed bindings and its zone memberships. So ask, and let the answer say which.
    const rejoin = project.barriers.some(b => b.id === selected) ? spacesRejoinedBy(project, selected) : null;
    if (rejoin && !merge) {
      // One question at a time. The delete prompt has been answered — the wall is going — and what
      // is left to settle is what happens to the two spaces it separated. Leaving it open stacks a
      // second dialog on a first that is already spent, and answering the merge leaves the delete
      // prompt standing there asking again.
      setDeleteOpen(false);
      setMerge({ wallId: selected, a: rejoin[0], b: rejoin[1] });
      return;
    }
    if (
      // reshape, not commit: deleting a wall leaves the rooms it bounded the wrong shape. Where the
      // deletion merges two rooms' regions into one the re-fit declines — that ambiguity is what the
      // merge prompt above exists to settle.
      reshape(p => {
        p.objects = p.objects.filter(o => o.id !== selected && o.barrierId !== selected);
        p.objects.forEach(o => {
          if (o.parentId === selected) o.parentId = undefined;
        });
        p.barriers = p.barriers.filter(b => b.id !== selected);
        p.drawings = p.drawings.filter(d => d.id !== selected);
        p.junctions = p.junctions.filter(j => p.barriers.some(b => b.startId === j.id || b.endId === j.id));
        // Navigation cascade: drop the nav node itself if selected, nodes bound to any removed object,
        // and every edge that lost an endpoint or its bound object (validateNavigation rejects dangling refs).
        if (p.navNodes?.length) {
          const objectIds = new Set(p.objects.map(o => o.id));
          p.navNodes = p.navNodes.filter(
            n => n.id !== selected && (n.objectId === undefined || objectIds.has(n.objectId)),
          );
          const nodeIds = new Set(p.navNodes.map(n => n.id));
          p.navEdges = (p.navEdges ?? []).filter(
            e => nodeIds.has(e.aId) && nodeIds.has(e.bId) && (e.objectId === undefined || objectIds.has(e.objectId)),
          );
        }
        // The ontology references objects too, and every reference is validated — without this the
        // whole delete is refused and nothing appears to happen.
        pruneOntology(p);
      })
    ) {
      select(null);
      setDeleteOpen(false);
      if (routeAnchor === selected) setRouteAnchor(null);
    }
  }
  // Seek the panel/journey to an instruction step: pause playback, emphasise the step, and bring
  // the view there — a floor switch lets MapCanvas's own fit frame the level; a same-floor seek
  // glides to the step's last node.
  function seekStep(index: number) {
    if (!route) return;
    const clamped = Math.max(0, Math.min(route.steps.length - 1, index));
    const step = route.steps[clamped];
    stopPlaying();
    setPlayStep(clamped);
    const moved = step.floorId !== floorId;
    if (moved) setFloorId(step.floorId);
    const node = (project.navNodes ?? []).find(n => n.id === step.nodeIds.at(-1));
    if (!moved && node && mapRef.current)
      mapRef.current.easeTo({
        center: toLngLat(node.position, project.origin),
        zoom: Math.max(mapRef.current.getZoom(), 18),
        duration: 550,
      });
  }
  async function doExport() {
    try {
      download(
        await exportProject(project, adapters.assets),
        `${project.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.json`,
      );
      notify('Portable project exported with reference drawings.');
    } catch (e) {
      notify((e as Error).message);
    }
  }
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input, textarea, select, dialog')) return;
      const cmd = e.metaKey || e.ctrlKey;
      if (cmd && e.key.toLowerCase() === 'z' && editing) {
        e.preventDefault();
        setHistory(h => (e.shiftKey ? redoHistory(h) : undoHistory(h)));
        setDraft([]);
        setRouteAnchor(null);
        return;
      }
      if (cmd && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void doExport();
        return;
      }
      if (e.key === 'Escape') {
        setDraft([]);
        setTool('select');
        setPalette(false);
        setInspectorOpen(false);
        setRouteAnchor(null);
        if (navigating) {
          stopPlaying();
          setNavigating(false);
        }
        if (alignment) setAlignment(null);
        else select(null);
      }
      if (e.key === 'Enter' && draft.length) {
        e.preventDefault();
        finish();
      }
      // Chrome shortcuts work in every mode; single letters stay free because tools use their own set.
      if (!cmd) {
        const key = e.key.toLowerCase();
        if (e.key === '?') {
          setHelpOpen(true);
          return;
        }
        if (e.key === '1') {
          enterView();
          return;
        }
        if (e.key === '2') {
          enterEdit();
          return;
        }
        if (e.key === '3') {
          enterLive();
          return;
        }
        if (key === 't') {
          if (threeD) setThreeD(false);
          else {
            setThreeD(true);
            setTool('select');
            setDraft([]);
          }
          return;
        }
        if (key === 'x' && threeD) {
          setStack(!stack);
          return;
        }
        if (key === 'b') {
          setSidebarOpen(!sidebarOpen);
          return;
        }
        if (key === 'i') {
          setInspectorOpen(!inspectorOpen);
          return;
        }
        if (key === 'f') {
          setFullscreen(!fullscreen);
          return;
        }
        if (key === 'g') {
          if (navigating) stopPlaying();
          setNavigating(!navigating);
          return;
        }
        if (key === 'n') {
          toggleDark();
          return;
        }
        if (e.key === '[') {
          stepFloor(-1);
          return;
        }
        if (e.key === ']') {
          stepFloor(1);
          return;
        }
      }
      if (!editing) return;
      if ((e.key === 'Delete' || e.key === 'Backspace') && selected) {
        e.preventDefault();
        setDeleteOpen(true);
      }
      if (cmd && e.key.toLowerCase() === 'd') {
        e.preventDefault();
        duplicateSelected();
      }
      if (!cmd && !e.shiftKey) {
        const shortcut: Record<string, Tool> = {
          v: 'select',
          h: 'pan',
          w: 'wall',
          p: 'partition',
          d: 'door',
          c: 'camera',
          z: 'zone',
          m: 'measure',
          s: 'split',
          e: 'enclose',
        };
        if (shortcut[e.key.toLowerCase()]) chooseTool(shortcut[e.key.toLowerCase()]);
      }
    };
    // Shift+Up/Down steps floors — registered in capture phase so it wins over MapLibre's
    // shift-pitch handling when the map canvas has focus. AltGr symbols are avoided on purpose.
    const floorKeys = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input, textarea, select, dialog')) return;
      const m = mapRef.current;
      if (e.key.startsWith('Arrow')) {
        e.preventDefault();
        e.stopPropagation();
        if (!e.shiftKey)
          m?.panBy(
            [
              e.key === 'ArrowLeft' ? -140 : e.key === 'ArrowRight' ? 140 : 0,
              e.key === 'ArrowUp' ? -140 : e.key === 'ArrowDown' ? 140 : 0,
            ],
            { duration: 250 },
          );
        else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') stepFloor(e.key === 'ArrowUp' ? 1 : -1);
        else m?.easeTo({ bearing: m.getBearing() + (e.key === 'ArrowRight' ? 45 : -45), duration: 450 });
        return;
      }
      if (e.shiftKey && threeD && m && (e.key.toLowerCase() === 'w' || e.key.toLowerCase() === 's')) {
        e.preventDefault();
        e.stopPropagation();
        m.easeTo({
          pitch: Math.max(0, Math.min(75, m.getPitch() + (e.key.toLowerCase() === 'w' ? 10 : -10))),
          duration: 300,
        });
      }
    };
    // Holding Shift reveals each dock tool's shortcut as a badge on the button.
    const shiftDown = (e: KeyboardEvent) => {
      if (e.key === 'Shift') setShowKeys(true);
    };
    const shiftUp = (e: KeyboardEvent) => {
      if (e.key === 'Shift') setShowKeys(false);
    };
    const blur = () => setShowKeys(false);
    window.addEventListener('keydown', handler);
    window.addEventListener('keydown', floorKeys, true);
    window.addEventListener('keydown', shiftDown);
    window.addEventListener('keyup', shiftUp);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', handler);
      window.removeEventListener('keydown', floorKeys, true);
      window.removeEventListener('keydown', shiftDown);
      window.removeEventListener('keyup', shiftUp);
      window.removeEventListener('blur', blur);
    };
  });
  async function startAlignment(prepared: PreparedDrawing) {
    const drawing = makeDrawing(prepared, floorId);
    try {
      await adapters.assets.put(drawing.assetId, prepared.blob);
      setAlignment({ prepared, drawing, imagePoints: [], mapPoints: [], preview: false });
      setThreeD(false);
      setTool('select');
    } catch (e) {
      notify(`Could not store drawing: ${(e as Error).message}`);
    }
  }
  function previewAlignment() {
    if (!alignment) return;
    try {
      const transform = alignDrawing(alignment.imagePoints as [Point, Point], alignment.mapPoints as [Point, Point]);
      setAlignment({ ...alignment, drawing: { ...alignment.drawing, ...transform }, preview: true });
    } catch (e) {
      notify((e as Error).message);
    }
  }
  function confirmAlignment() {
    if (!alignment) return;
    if (commit(p => p.drawings.push(alignment.drawing))) {
      setSelected(alignment.drawing.id);
      setAlignment(null);
      notify('Drawing aligned. Trace walls and rooms over the reference.');
    }
  }
  function calibrate(metres: number) {
    if (!alignment || alignment.imagePoints.length !== 2 || !Number.isFinite(metres) || metres <= 0) return;
    const pixels = distance(alignment.imagePoints[0], alignment.imagePoints[1]);
    if (pixels < 1) {
      notify('Choose two distinct image points.');
      return;
    }
    const drawing = { ...alignment.drawing, scale: metres / pixels };
    if (commit(p => p.drawings.push(drawing))) {
      setSelected(drawing.id);
      setAlignment(null);
    }
  }
  function traceFootprint(id: string) {
    const footprint = project.objects.find(o => o.id === id);
    if (!footprint?.rings) return;
    if (floorId === null) {
      notify('Select a destination floor, then select the footprint in Objects to create its walls.');
      return;
    }
    commit(p => {
      for (const ring of footprint.rings!) {
        const closed = closeRing(ring);
        for (let i = 1; i < closed.length; i++) addBarrier(p, closed[i - 1], closed[i], floorId, 'wall');
      }
      const area = createObject('zone', footprint.position, floorId, floor?.name ?? 'Floor');
      area.width = footprint.width;
      area.depth = footprint.depth;
      area.rings = structuredClone(footprint.rings);
      p.objects.push(area);
    });
  }
  const displayProject = alignment?.preview
    ? { ...project, drawings: [...project.drawings, alignment.drawing] }
    : project;
  const filteredObjects = project.objects.filter(
    o =>
      (search ? o.name.toLowerCase().includes(search.toLowerCase()) : o.floorId === floorId || o.kind === 'building') &&
      o.kind !== 'window',
  );
  const selectedBarrier = project.barriers.find(b => b.id === selected);
  const deleteCount = selectedBarrier ? project.objects.filter(o => o.barrierId === selected).length : 0;
  return (
    <div className={`kerros-root app-shell ${fullscreen ? 'fullscreen' : ''}`}>
      <header className="app-header">
        <a
          className="brand"
          href="#"
          onClick={e => {
            e.preventDefault();
            void leave();
          }}
        >
          <span className="brand-mark">
            <Layers3 size={22} strokeWidth={2} />
          </span>
          <strong>{en.brand}</strong>
          <span className="brand-divider" />
          <span className="brand-product">{en.app}</span>
        </a>
        <div className="mode-switch">
          <button className={mode === 'view' ? 'active' : ''} onClick={enterView}>
            <Eye size={15} />
            <span className="mode-label">{en.viewer}</span>
            {keyHint('1')}
          </button>
          {!readOnly && (
            <button className={mode === 'edit' ? 'active' : ''} onClick={enterEdit}>
              <MousePointer2 size={15} />
              <span className="mode-label">{en.editor}</span>
              {keyHint('2')}
            </button>
          )}
          {monitoring && (
            <button className={mode === 'live' ? 'active' : ''} onClick={enterLive}>
              <Radio size={15} />
              <span className="mode-label">{en.monitor}</span>
              {keyHint('3')}
            </button>
          )}
        </div>
        <div className="header-right">
          <span className={`save-status ${saveState}`}>
            <span />
            {readOnly
              ? 'Read-only viewer'
              : en[saveState === 'saved' ? 'saved' : saveState === 'saving' ? 'saving' : 'saveError']}
          </span>
          <button
            className="icon-button"
            title={dark ? 'Switch to light mode' : 'Switch to dark mode'}
            aria-label={dark ? 'Switch to light mode' : 'Switch to dark mode'}
            onClick={toggleDark}
          >
            {dark ? <Sun size={18} /> : <Moon size={18} />}
            {keyHint('N')}
          </button>
          <button
            className="icon-button help-button"
            title="Help and shortcuts (?)"
            aria-label="Help and shortcuts"
            onClick={() => setHelpOpen(true)}
          >
            <CircleHelp size={19} />
            {keyHint('?')}
          </button>
          <span className="avatar">KH</span>
        </div>
      </header>
      <div className="workspace">
        {sidebarOpen && (
          <aside className="sidebar">
            <button className="back-link" onClick={leave}>
              <ArrowLeft size={14} />
              All spaces
            </button>
            <div className="site-card">
              <div className="site-icon">
                <Building2 size={24} />
              </div>
              <div>
                <h1>{project.name}</h1>
                <span>
                  <MapPin size={11} />
                  {project.description.split('·').at(-1)?.trim()}
                </span>
              </div>
              <button className="icon-button" aria-label="Switch project" onClick={leave}>
                <ChevronDown size={15} />
              </button>
            </div>
            <div className="site-badge">
              <span />
              WORKSPACE
              <span className="badge-right">
                {project.buildings.length} building{project.buildings.length > 1 ? 's' : ''}
              </span>
            </div>
            <div className="sidebar-tabs">
              <button className={activeTab === 'structure' ? 'active' : ''} onClick={() => setActiveTab('structure')}>
                Structure
              </button>
              <button className={activeTab === 'objects' ? 'active' : ''} onClick={() => setActiveTab('objects')}>
                Objects<span>{project.objects.filter(o => o.kind !== 'window').length}</span>
              </button>
            </div>
            <div className="sidebar-scroll">
              {activeTab === 'structure' ? (
                <>
                  {!readOnly && (
                    <button
                      className="anchor-entry"
                      title="Where the plan is pinned and which way it faces"
                      onClick={() => {
                        // Reachable from the plan viewer too — landing there after reopening a
                        // project and finding no way to square it onto its plot is the whole
                        // complaint. Adjusting the anchor is an edit, so take the editor with you.
                        if (!editing) enterEdit();
                        select(null);
                        setInspectorOpen(true);
                      }}
                    >
                      <Compass size={16} />
                      <span>
                        Site anchor
                        <small>
                          {(project.origin[2] ?? 0).toFixed(1)}° · {project.origin[1].toFixed(5)},{' '}
                          {project.origin[0].toFixed(5)}
                        </small>
                      </span>
                      <ChevronRight size={15} />
                    </button>
                  )}
                  <div className="section-label">
                    {en.floors}
                    {editing && (
                      <button
                        className="icon-button"
                        aria-label="Add floor"
                        onClick={() => {
                          setNewFloorElevation(Math.max(...project.floors.map(f => f.elevation + f.height)));
                          setFloorModal(true);
                        }}
                      >
                        <Plus size={15} />
                      </button>
                    )}
                  </div>
                  <button
                    className={`floor-item outdoor ${floorId === null ? 'active' : ''}`}
                    onClick={() => changeFloor(null)}
                  >
                    <Leaf size={17} />
                    <span>
                      Outdoor site<small>Perimeters & surroundings</small>
                    </span>
                  </button>
                  {project.buildings.map(building => {
                    const open = !collapsedBuildings.has(building.id);
                    return (
                      <div className="building-group" key={building.id}>
                        <button
                          className="building-label"
                          aria-expanded={open}
                          onClick={() =>
                            setCollapsedBuildings(prev => {
                              const next = new Set(prev);
                              if (next.has(building.id)) next.delete(building.id);
                              else next.add(building.id);
                              return next;
                            })
                          }
                        >
                          <Building2 size={13} />
                          {building.name}
                          {mode !== 'view' &&
                            project.floors.some(f => f.buildingId === building.id && alarmFloors.has(f.id)) && (
                              <span className="floor-alarm" title="Active alarm in this building" />
                            )}
                          <span className="building-count">
                            {project.floors.filter(f => f.buildingId === building.id).length}
                          </span>
                          {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                        </button>
                        {open &&
                          project.floors
                            .filter(f => f.buildingId === building.id)
                            .sort((a, b) => b.elevation - a.elevation)
                            .map(f => (
                              <button
                                key={f.id}
                                className={`floor-item ${floorId === f.id ? 'active' : ''}`}
                                onClick={() => changeFloor(f.id)}
                              >
                                <span className="floor-number">{floorCode(f)}</span>
                                <span>
                                  {f.name}
                                  <small>{f.elevation.toFixed(1)} m elevation</small>
                                </span>
                                {mode !== 'view' && alarmFloors.has(f.id) && (
                                  <span className="floor-alarm" title="Active alarm on this floor" />
                                )}
                                {floorId === f.id && <span className="active-floor-dot" />}
                              </button>
                            ))}
                      </div>
                    );
                  })}
                  {editing && floorId && (
                    <button
                      className="duplicate-floor"
                      onClick={() => {
                        let id = '';
                        if (
                          commit(p => {
                            id = duplicateFloor(p, floorId);
                          })
                        ) {
                          setFloorId(id);
                          notify('Floor duplicated with new IDs and cleared feed bindings.');
                        }
                      }}
                    >
                      <Copy size={13} />
                      Duplicate current floor
                    </button>
                  )}
                  <div className="section-label drawings-heading">
                    {en.drawings}
                    {editing && (
                      <button
                        className="icon-button"
                        aria-label="Import reference drawing"
                        onClick={() => setImportOpen(true)}
                      >
                        <Plus size={15} />
                      </button>
                    )}
                  </div>
                  {project.drawings.filter(d => d.floorId === floorId).length ? (
                    project.drawings
                      .filter(d => d.floorId === floorId)
                      .map(d => (
                        <button
                          className={`drawing-item ${selected === d.id ? 'active' : ''}`}
                          key={d.id}
                          onClick={() => select(d.id)}
                        >
                          <FileImage size={18} />
                          <span>
                            {d.name}
                            <small>
                              {d.locked ? 'Locked' : 'Aligned reference'} · {Math.round(d.opacity * 100)}%
                            </small>
                          </span>
                        </button>
                      ))
                  ) : (
                    <button className="empty-drawings" onClick={() => editing && setImportOpen(true)}>
                      <div>
                        <FileImage size={20} />
                        <Plus size={12} />
                      </div>
                      <strong>Add a floor drawing</strong>
                      <span>Align a plan. Trace your space.</span>
                      <small>PNG, JPEG or PDF</small>
                    </button>
                  )}
                </>
              ) : (
                <>
                  <label className="object-search">
                    <Search size={15} />
                    <input
                      aria-label="Search objects"
                      placeholder="Find a space or object…"
                      value={search}
                      onChange={e => setSearch(e.target.value)}
                    />
                  </label>
                  <div className="section-label">
                    {search ? 'Search all floors' : (floor?.name ?? 'Outdoor objects')}
                    <span>{filteredObjects.length}</span>
                  </div>
                  {filteredObjects.map(o => (
                    <button
                      key={o.id}
                      className={`object-row list-object ${selected === o.id ? 'active' : ''}`}
                      onClick={() => select(o.id, true)}
                    >
                      <EntityIcon kind={o.kind} symbol={o.symbol} />
                      <span>
                        {o.name}
                        <small>{o.kind}</small>
                      </span>
                      {o.feedId && <span className={`status-dot ${statusTone(statuses.get(o.feedId))}`} />}
                    </button>
                  ))}
                  {!filteredObjects.length && <p className="helper padded">No matching objects.</p>}
                </>
              )}
            </div>
            <div className="sidebar-footer">
              <span className="workspace-avatar">K</span>
              <div>
                <strong>Kerros workspace</strong>
                <small>Local prototype</small>
              </div>
              <Settings2 size={16} />
            </div>
          </aside>
        )}
        <main className="canvas-column">
          <div className="canvas-header">
            <button
              className="icon-button"
              aria-label={sidebarOpen ? 'Hide side panel' : 'Show side panel'}
              title={sidebarOpen ? 'Hide side panel' : 'Show side panel'}
              onClick={() => setSidebarOpen(!sidebarOpen)}
            >
              {sidebarOpen ? <PanelLeftClose size={17} /> : <PanelLeftOpen size={17} />}
              {keyHint('B')}
            </button>
            <div className="breadcrumb">
              <span>{project.name}</span>
              <ChevronRight size={13} />
              <strong>{floor?.name ?? 'Outdoor site'}</strong>
              <span className="mode-pill">{editing ? 'EDITING' : 'VIEWING'}</span>
            </div>
            <div>
              {editing && (
                <button className="button secondary small" onClick={() => setImportOpen(true)}>
                  <ArrowUpFromLine size={14} />
                  Import
                </button>
              )}
              <button
                className="icon-button"
                aria-label="Export project"
                title="Export portable project"
                onClick={doExport}
              >
                <ArrowDownToLine size={17} />
              </button>
              <button
                className={`icon-button ${structuring ? 'active-nav' : ''}`}
                aria-label={structuring ? 'Hide structure panel' : 'Show structure panel'}
                title="Structure — zones and portals"
                onClick={() => {
                  setStructuring(!structuring);
                  if (!structuring) setNavigating(false);
                }}
              >
                <Shapes size={17} />
              </button>
              <button
                className={`icon-button ${navigating ? 'active-nav' : ''}`}
                aria-label={navigating ? 'Hide navigation panel' : 'Show navigation panel'}
                title="Navigate (G)"
                onClick={() => {
                  if (navigating) stopPlaying();
                  setNavigating(!navigating);
                  if (!navigating) setStructuring(false);
                }}
              >
                <Waypoints size={17} />
                {keyHint('G')}
              </button>
              <button
                className="icon-button"
                aria-label={inspectorOpen ? 'Hide properties panel' : 'Show properties panel'}
                title={inspectorOpen ? 'Hide properties panel' : 'Show properties panel'}
                onClick={() => setInspectorOpen(!inspectorOpen)}
              >
                {inspectorOpen ? <PanelRightClose size={17} /> : <PanelRightOpen size={17} />}
                {keyHint('I')}
              </button>
            </div>
          </div>
          <div className="canvas-body">
            <MapCanvas
              project={displayProject}
              canEdit={editing}
              floorId={floorId}
              selected={selected}
              tool={tool}
              draft={draft}
              hover={hover}
              guides={guides}
              threeD={threeD}
              stack={stack}
              coverage={coverage}
              showLabels={showLabels}
              showPlan={showPlan}
              evening={evening}
              dark={dark}
              excavation={excavation}
              cityBuildings={cityBuildings}
              cadastre={cadastre}
              basemap={basemap}
              assets={adapters.assets}
              statuses={shownStatuses}
              focusId={focusId}
              alignment={alignment ? { image: alignment.imagePoints, map: alignment.mapPoints } : undefined}
              onClick={mapClick}
              onAdopt={adoptBuilding}
              onHover={onHover}
              onSelect={id => select(id)}
              onVertexMove={vertexMove}
              onError={notify}
              route={route}
              activeStep={playStep}
              playing={playing}
              onJourneyStep={index => setPlayStep(index)}
              onJourneyEnd={() => {
                stopPlaying();
                writeHash();
              }}
              onRequestFloor={id => setFloorId(id)}
              onReady={map => {
                mapRef.current = map;
                map.on('moveend', writeHash);
                writeHash();
              }}
              initialCamera={initialView?.camera}
            />
            <div className="canvas-top-left">
              <div className="floor-chip">
                <Layers3 size={17} />
                <FloorSelect
                  ariaLabel="Active floor"
                  value={floorId ?? 'outdoors'}
                  onPick={id => changeFloor(id === 'outdoors' ? null : id)}
                  entries={[
                    { id: 'outdoors', code: 'OUT', name: 'Outdoor site' },
                    ...project.buildings.flatMap(b =>
                      project.floors
                        .filter(f => f.buildingId === b.id)
                        .sort((a, c) => c.elevation - a.elevation)
                        .map(f => ({
                          id: f.id,
                          code: floorCode(f),
                          name: mode !== 'view' && alarmFloors.has(f.id) ? `⚠ ${f.name}` : f.name,
                          hint: project.buildings.length > 1 ? b.name : undefined,
                        })),
                    ),
                  ]}
                />
                {keyHint('⇧↑↓')}
              </div>
              <div className="view-switch">
                <button className={!threeD ? 'active' : ''} onClick={() => setThreeD(false)}>
                  2D{threeD && keyHint('T')}
                </button>
                <button
                  className={threeD ? 'active' : ''}
                  onClick={() => {
                    setThreeD(true);
                    setTool('select');
                    setDraft([]);
                  }}
                >
                  <Box size={14} />
                  3D{!threeD && keyHint('T')}
                </button>
              </div>
              {threeD && (
                <button className={`stack-button ${stack ? 'active' : ''}`} onClick={() => setStack(!stack)}>
                  <Layers3 size={15} />
                  {stack ? 'All floors' : 'Cutaway'}
                  {keyHint('X')}
                </button>
              )}
            </div>
            {(() => {
              const band = floorBand();
              const index = band.findIndex(f => f.id === floorId);
              const above = index < 0 ? band[0] : band[index + 1],
                below = index < 0 ? undefined : band[index - 1];
              return (
                <div className="floor-step">
                  <button aria-label="Floor up" title="Floor up (⇧↑)" disabled={!above} onClick={() => stepFloor(1)}>
                    <ChevronUp size={14} />
                    {above && <b>{floorCode(above)}</b>}
                  </button>
                  <span className="floor-step-current">{floor ? floorCode(floor) : 'OUT'}</span>
                  <button
                    aria-label="Floor down"
                    title="Floor down (⇧↓)"
                    disabled={!below}
                    onClick={() => stepFloor(-1)}
                  >
                    {below && <b>{floorCode(below)}</b>}
                    <ChevronDown size={14} />
                  </button>
                </div>
              );
            })()}
            <div className="canvas-top-right">
              {monitoring && mode !== 'view' && (
                <button
                  className={`live-badge ${alarms.length ? 'has-alarm' : ''}`}
                  onClick={() => {
                    if (alarms[0]) select(alarms[0].id, true);
                    else notify('Everything bound to the feed is reporting without active alarms.');
                  }}
                >
                  {alarms.length ? <Bell size={14} /> : <span className="live-pip" />}
                  {alarms.length ? `${alarms.length} active alarm${alarms.length > 1 ? 's' : ''}` : 'Status feed'}
                </button>
              )}
              <button
                className={`floating-icon ${fullscreen ? 'active' : ''}`}
                aria-label={fullscreen ? 'Exit full screen' : 'Full-screen map'}
                title={fullscreen ? 'Exit full screen' : 'Full-screen map'}
                onClick={() => setFullscreen(!fullscreen)}
              >
                {fullscreen ? <Minimize2 size={18} /> : <Maximize2 size={18} />}
                {keyHint('F')}
              </button>
              <button
                className={`floating-icon ${settings ? 'active' : ''}`}
                aria-label="Map settings"
                onClick={() => setSettings(!settings)}
              >
                <Settings2 size={18} />
              </button>
            </div>
            {settings && (
              <div className="map-settings">
                <h3>
                  Map display
                  <button className="icon-button" aria-label="Close map settings" onClick={() => setSettings(false)}>
                    <X size={15} />
                  </button>
                </h3>
                <label className="field">
                  <span>Basemap</span>
                  <select
                    aria-label="Basemap"
                    value={basemapMode}
                    onChange={e => setBasemapMode(e.target.value as typeof basemapMode)}
                  >
                    <option value="plan">Plan background · offline</option>
                    {adapters.basemap && <option value="host">{adapters.basemap.label ?? 'Map background'}</option>}
                  </select>
                </label>
                {editing &&
                  (() => {
                    const building =
                      project.buildings.find(b => b.id === project.floors.find(f => f.id === floorId)?.buildingId) ??
                      project.buildings[0];
                    return (
                      <label className="field">
                        <span>Exterior finish · {building.name}</span>
                        <select
                          aria-label="Exterior finish"
                          value={building.exteriorPreset ?? ''}
                          onChange={e =>
                            commit(p => {
                              p.buildings.find(b => b.id === building.id)!.exteriorPreset = (e.target.value ||
                                undefined) as ExteriorPreset | undefined;
                            })
                          }
                        >
                          <option value="">Original materials</option>
                          {Object.entries(EXTERIOR_PRESETS).map(([id, preset]) => (
                            <option key={id} value={id}>
                              {preset.name}
                            </option>
                          ))}
                        </select>
                        <small>Applies to the exterior on every floor.</small>
                      </label>
                    );
                  })()}
                <Toggle
                  label="Architecture plan"
                  description="Hide to see the basemap under this floor"
                  value={showPlan}
                  onChange={() => setShowPlan(!showPlan)}
                />
                <Toggle label="Space labels" value={showLabels} onChange={() => setShowLabels(!showLabels)} />
                <Toggle label="Camera coverage" value={coverage} onChange={() => setCoverage(!coverage)} />
                <Toggle
                  label="Evening lighting"
                  description="Dusk sky and garden lamps in 3D"
                  value={evening}
                  onChange={() => setEvening(!evening)}
                />
                <Toggle
                  label="Ground section"
                  description="Cut the earth away around below-grade floors"
                  value={excavation}
                  onChange={() => setExcavation(!excavation)}
                />
                <Toggle
                  label="3D city buildings"
                  description="Raise surrounding basemap buildings by their MML attributes"
                  value={cityBuildings}
                  onChange={() => setCityBuildings(!cityBuildings)}
                />
                {hasCadastre && (
                  <Toggle
                    label="Property boundaries"
                    description="MML cadastral parcel overlay"
                    value={cadastre}
                    onChange={() => setCadastre(!cadastre)}
                  />
                )}
                {editing && (
                  <Toggle label="Snap to geometry & grid" value={snapping} onChange={() => setSnapping(!snapping)} />
                )}
                <p className="helper">
                  {surveyed
                    ? 'Vector map background; attribution is shown on the map.'
                    : 'A quiet background for detailed floor planning.'}
                </p>
              </div>
            )}
            {editing && !threeD && !alignment && (
              <div className="drawing-dock-wrap">
                {tool === 'route' && !project.navNodes && (
                  <button className="button secondary adopt-graph" onClick={adoptDerivedGraph}>
                    <Waypoints size={14} />
                    Adopt inferred graph
                  </button>
                )}
                {tool !== 'select' && tool !== 'pan' && (
                  <div className="tool-instruction">
                    <span className="tool-instruction-dot" />
                    <strong>{en.tools[tool]}</strong>
                    <span>
                      {tool === 'route'
                        ? routeAnchor
                          ? 'Click to chain the next route node · Esc ends the chain'
                          : project.navNodes
                            ? 'Click to place route nodes · lifts, stairs, doors and POIs link automatically'
                            : 'Showing the graph the plan implies — spaces joined by their portals. Adopt it to edit it.'
                        : tool === 'partition'
                          ? proposal
                            ? 'Click to build the wall shown · it squares to what it is nearest'
                            : 'Hover inside a space to be offered the wall it is missing'
                          : tool === 'enclose'
                            ? 'Click inside a room the walls close around · click a space again to re-fit it'
                            : tool === 'split'
                              ? draft.length
                                ? 'Now click the opposite wall to cut the room in two'
                                : 'Click one wall of a room to start the cut'
                              : tool === 'adopt'
                                ? 'Click a building on the basemap to bring it into the project'
                                : tool === 'measure' && draft.length === 2
                                  ? `${distance(draft[0], draft[1]).toFixed(2)} m`
                                  : DRAW_TOOLS.includes(tool)
                                    ? draft.length
                                      ? `${draft.length} point${draft.length > 1 ? 's' : ''} · ${snapLabel}`
                                      : 'Click on the map to start'
                                    : isOpening(tool as ObjectKind)
                                      ? 'Click a supporting wall or fence'
                                      : 'Click on the map to place'}{' '}
                    </span>
                    {draft.length > 0 && tool !== 'rectangle' && (
                      <button onClick={finish}>
                        Finish <kbd>↵</kbd>
                      </button>
                    )}
                    <button aria-label="Cancel drawing" onClick={() => chooseTool('select')}>
                      <X size={14} />
                    </button>
                  </div>
                )}
                {palette && (
                  <div className="tool-palette">
                    <div>
                      <h3>Draw your space</h3>
                      {(['wall', 'fence', 'room', 'enclose', 'zone', 'rectangle', 'hole'] as Tool[]).map(t => (
                        <button key={t} onClick={() => chooseTool(t)}>
                          <EntityIcon kind={t} />
                          {en.tools[t]}
                        </button>
                      ))}
                    </div>
                    <div>
                      <h3>Openings &amp; devices</h3>
                      {(['door', 'window', 'gate', 'turnstile', 'reader', 'camera', 'alarm'] as Tool[]).map(t => (
                        <button key={t} onClick={() => chooseTool(t)}>
                          <EntityIcon kind={t} />
                          {en.tools[t]}
                        </button>
                      ))}
                    </div>
                    <div>
                      <h3>Site objects</h3>
                      {(['elevator', 'stairs', 'office', 'container', 'storage', 'poi'] as Tool[]).map(t => (
                        <button key={t} onClick={() => chooseTool(t)}>
                          <EntityIcon kind={t} />
                          {en.tools[t]}
                        </button>
                      ))}
                      <button onClick={() => chooseTool('route')}>
                        <Waypoints size={17} strokeWidth={1.75} />
                        {en.tools.route}
                      </button>
                    </div>
                    <div>
                      <h3>Sensors &amp; areas</h3>
                      {(['sensor', 'equipment', 'evacuation'] as Tool[]).map(t => (
                        <button key={t} onClick={() => chooseTool(t)}>
                          <EntityIcon kind={t} />
                          {en.tools[t]}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                <div className="drawing-dock">
                  {(() => {
                    const KEYS: Partial<Record<Tool, string>> = {
                      select: 'V',
                      pan: 'H',
                      wall: 'W',
                      zone: 'Z',
                      door: 'D',
                      camera: 'C',
                      measure: 'M',
                      split: 'S',
                      enclose: 'E',
                    };
                    const hint = (t: Tool) => (showKeys && KEYS[t] ? <kbd className="key-hint">{KEYS[t]}</kbd> : null);
                    return (
                      <>
                        <button
                          className={tool === 'select' ? 'active' : ''}
                          aria-label="Select tool"
                          title="Select (V)"
                          onClick={() => chooseTool('select')}
                        >
                          <MousePointer2 size={20} />
                          {hint('select')}
                        </button>
                        <button
                          className={tool === 'pan' ? 'active' : ''}
                          aria-label="Pan tool"
                          title="Pan (H)"
                          onClick={() => chooseTool('pan')}
                        >
                          <Hand size={19} />
                          {hint('pan')}
                        </button>
                        <i />
                        {(['wall', 'zone', 'door', 'camera', 'poi'] as Tool[]).map(t => (
                          <button
                            key={t}
                            className={tool === t ? 'active' : ''}
                            aria-label={`${en.tools[t]} tool`}
                            title={KEYS[t] ? `${en.tools[t]} (${KEYS[t]})` : en.tools[t]}
                            onClick={() => chooseTool(t)}
                          >
                            <EntityIcon kind={t} size={20} />
                            {hint(t)}
                          </button>
                        ))}
                        <button
                          className={tool === 'partition' ? 'active' : ''}
                          aria-label="Partition tool"
                          title="Partition (P)"
                          onClick={() => chooseTool('partition')}
                        >
                          <Rows2 size={19} />
                          {hint('partition')}
                        </button>
                        <button
                          className={tool === 'enclose' ? 'active' : ''}
                          aria-label="Space from walls tool"
                          title="Space from walls (E)"
                          onClick={() => chooseTool('enclose')}
                        >
                          <SquareDashedBottom size={19} />
                          {hint('enclose')}
                        </button>
                        <button
                          className={tool === 'split' ? 'active' : ''}
                          aria-label="Split room tool"
                          title="Split room (S)"
                          onClick={() => chooseTool('split')}
                        >
                          <Scissors size={19} />
                          {hint('split')}
                        </button>
                        <button
                          className={tool === 'route' ? 'active' : ''}
                          aria-label="Route path tool"
                          title="Route path"
                          onClick={() => chooseTool('route')}
                        >
                          <Waypoints size={19} />
                        </button>
                        <button
                          className={palette ? 'active' : ''}
                          aria-label="All drawing tools"
                          title="All drawing tools"
                          onClick={() => setPalette(!palette)}
                        >
                          <Plus size={20} />
                        </button>
                        <i />
                        <button
                          className={tool === 'measure' ? 'active' : ''}
                          aria-label="Measure tool"
                          title="Measure (M)"
                          onClick={() => chooseTool('measure')}
                        >
                          <Ruler size={19} />
                          {hint('measure')}
                        </button>
                      </>
                    );
                  })()}
                  {canAdopt && (
                    <button
                      className={tool === 'adopt' ? 'active' : ''}
                      aria-label="Adopt building from map"
                      title="Adopt building from map"
                      onClick={() => chooseTool('adopt')}
                    >
                      <Landmark size={19} />
                    </button>
                  )}
                  <i />
                  <button
                    aria-label="Undo"
                    title="Undo (⌘Z)"
                    disabled={!history.past.length}
                    onClick={() => {
                      setHistory(undoHistory);
                      setDraft([]);
                      setRouteAnchor(null);
                    }}
                  >
                    <Undo2 size={18} />
                  </button>
                  <button
                    aria-label="Redo"
                    title="Redo (⌘⇧Z)"
                    disabled={!history.future.length}
                    onClick={() => {
                      setHistory(redoHistory);
                      setDraft([]);
                      setRouteAnchor(null);
                    }}
                  >
                    <Redo2 size={18} />
                  </button>
                </div>
                <div className="dock-caption">
                  {tool === 'select' ? 'Click to select · drag handles to edit' : 'Escape to cancel'}
                  <span>⌘ Z to undo</span>
                </div>
              </div>
            )}
            {mode !== 'view' && (
              <div className="map-legend">
                <span>
                  <i className="status-dot normal" />
                  Normal
                </span>
                <span>
                  <i className="status-dot warning" />
                  Attention
                </span>
                <span>
                  <i className="status-dot critical" />
                  Alarm
                </span>
                <span>
                  <i className="status-dot unknown" />
                  Unknown
                </span>
              </div>
            )}
          </div>
          <div className="canvas-statusbar">
            <span>
              <span className="status-dot normal" />
              {editing ? 'Editor ready' : live ? 'Live view ready' : 'Plan viewer ready'}
            </span>
            <span>
              {project.barriers.length} barriers <i />
              {project.objects.length} objects <i />
              {project.floors.length} floors
            </span>
            <span>
              {snapping ? 'Snapping on · 0.5 m' : 'Free positioning'}
              <kbd>?</kbd>
            </span>
          </div>
        </main>
        {alignment ? (
          <AlignmentPanel
            drawing={alignment.prepared}
            imagePoints={alignment.imagePoints}
            mapPoints={alignment.mapPoints}
            preview={alignment.preview}
            setImagePoints={imagePoints => setAlignment({ ...alignment, imagePoints, mapPoints: [], preview: false })}
            onCancel={() => setAlignment(null)}
            onPreview={previewAlignment}
            onConfirm={confirmAlignment}
            onKnownDistance={calibrate}
          />
        ) : structuring ? (
          <StructureView
            project={project}
            selected={selected}
            onSelect={setSelected}
            onFloorChange={changeFloor}
            // Same commit path as every map tool, so zones land in history and undo like anything else.
            onEdit={editing ? change => commit(change) : undefined}
          />
        ) : navigating ? (
          <NavigatePanel
            project={project}
            from={navFrom}
            to={navTo}
            route={route}
            playing={playing}
            activeStep={playStep}
            editing={editing}
            onFrom={setNavFrom}
            onTo={setNavTo}
            onSwap={() => {
              setNavFrom(navTo);
              setNavTo(navFrom);
            }}
            onClear={() => {
              setNavFrom(null);
              setNavTo(null);
            }}
            onPlay={() => {
              playingRef.current = true;
              setPlayStep(0);
              setPlaying(true);
            }}
            onPause={stopPlaying}
            onStep={delta => seekStep((playStep ?? (delta === 1 ? -1 : 1)) + delta)}
            onSeek={seekStep}
            onClose={() => {
              stopPlaying();
              setNavigating(false);
            }}
          />
        ) : inspectorOpen ? (
          <Inspector
            onEdit={editing ? change => commit(change) : undefined}
            project={project}
            floorId={floorId}
            selected={selected}
            statuses={shownStatuses}
            monitoring={monitoring}
            editing={editing}
            live={live}
            renderStatusPanel={renderStatusPanel}
            onClose={() => {
              select(null);
              setInspectorOpen(false);
              if (window.matchMedia('(max-width: 840px)').matches) setSidebarOpen(false);
            }}
            onUpdateObject={updateObject}
            onUpdateBarrier={(id: string, patch: Partial<Barrier>) =>
              // Thickness is geometry: a wall that grows eats into the rooms on either side of it.
              reshape(p => Object.assign(p.barriers.find(b => b.id === id)!, patch))
            }
            onUpdateDrawing={(id: string, patch: Partial<Drawing>) =>
              commit(p => Object.assign(p.drawings.find(d => d.id === id)!, patch))
            }
            onUpdateFloor={(id: string, patch: Partial<Floor>) =>
              commit(p => Object.assign(p.floors.find(f => f.id === id)!, patch))
            }
            onDeleteFloor={requestDeleteFloor}
            onSetInitialFloor={(id: string | null) =>
              commit(p => {
                // Clearing drops the field entirely — an explicit null would mean "open outdoors",
                // which is a different intent from having no preference.
                if (id === null) delete p.initialFloorId;
                else p.initialFloorId = id;
              })
            }
            onDuplicate={duplicateSelected}
            onDelete={requestDelete}
            onSelect={id => select(id, true)}
            onFloor={changeFloor}
            onTraceFootprint={traceFootprint}
          />
        ) : null}
      </div>
      {toast && (
        <div className="toast" role="status">
          <InfoIcon />
          <span>{toast}</span>
          <button aria-label="Dismiss notification" onClick={() => setToast('')}>
            <X size={16} />
          </button>
        </div>
      )}
      {importOpen && (
        <ImportDialog
          project={project}
          floorId={floorId}
          assets={adapters.assets}
          importProjections={adapters.importProjections}
          onClose={() => setImportOpen(false)}
          onDrawing={startAlignment}
          onProject={async p => {
            await flush();
            setHistory(makeHistory(p));
            setFloorId(p.floors[0]?.id ?? null);
            setNewFloorBuilding(p.buildings[0].id);
            select(null);
          }}
          onOrigin={bearing => {
            commit(d => {
              const [lng, lat] = d.origin;
              d.origin = (bearing ? [lng, lat, bearing] : [lng, lat]) as typeof d.origin;
            });
          }}
          onPlan={(entities, target, layers) => {
            let outcome: PlanImportReport | undefined;
            if (
              commit(d => {
                outcome = importPlanEntities(d, entities, layers ? { floorId: target, layers } : { floorId: target });
              }) &&
              outcome
            ) {
              if (target !== floorId) setFloorId(target);
              setActiveTab('structure');
              const skipped = outcome.skipped.length ? ` · ${outcome.skipped.length} skipped` : '';
              notify(
                `Plan imported: ${outcome.walls} walls, ${outcome.rooms} rooms, ${outcome.doors} doors, ${outcome.windows} windows${outcome.passages ? ` · ${outcome.passages} open passages` : ''}${skipped}.`,
              );
            }
          }}
          onFootprints={objects => {
            if (commit(p => p.objects.push(...objects))) {
              setSelected(objects[0]?.id ?? null);
              setActiveTab('objects');
              const first = objects[0];
              if (first && mapRef.current)
                mapRef.current.easeTo({ center: toLngLat(first.position, project.origin), zoom: 18 });
              notify(
                `Imported ${objects.length} ${objects.length === 1 ? 'footprint' : 'footprints'}. Select a floor to generate its walls.`,
              );
            }
          }}
        />
      )}
      {floorModal && (
        <Modal
          title="Add a floor"
          subtitle="Create a level at its real elevation relative to the site."
          onClose={() => setFloorModal(false)}
        >
          <label className="field">
            <span>Floor name</span>
            <input aria-label="New floor name" value={newFloorName} onChange={e => setNewFloorName(e.target.value)} />
          </label>
          <div className="field-grid">
            <label className="field">
              <span>Building</span>
              <select value={newFloorBuilding} onChange={e => setNewFloorBuilding(e.target.value)}>
                {project.buildings.map(b => (
                  <option value={b.id} key={b.id}>
                    {b.name}
                  </option>
                ))}
                <option value="new">+ New building</option>
              </select>
            </label>
            <label className="field">
              <span>Elevation (m)</span>
              <input
                aria-label="New floor elevation"
                type="number"
                value={newFloorElevation}
                onChange={e => setNewFloorElevation(Number(e.target.value))}
              />
            </label>
          </div>
          {newFloorBuilding === 'new' && (
            <label className="field">
              <span>Building name</span>
              <input value={newBuildingName} onChange={e => setNewBuildingName(e.target.value)} />
            </label>
          )}
          <footer>
            <button className="button secondary" onClick={() => setFloorModal(false)}>
              Cancel
            </button>
            <button
              className="button primary"
              disabled={!newFloorName.trim() || (newFloorBuilding === 'new' && !newBuildingName.trim())}
              onClick={() => {
                const id = uid();
                if (
                  commit(p => {
                    let buildingId = newFloorBuilding;
                    if (buildingId === 'new') {
                      buildingId = uid();
                      p.buildings.push({ id: buildingId, name: newBuildingName });
                    }
                    p.floors.push({ id, name: newFloorName, buildingId, elevation: newFloorElevation, height: 3.5 });
                  })
                ) {
                  changeFloor(id);
                  setFloorModal(false);
                }
              }}
            >
              Create floor
              <Plus size={16} />
            </button>
          </footer>
        </Modal>
      )}
      {merge && (
        <Modal
          title="This wall was dividing two spaces"
          subtitle={`Removing it leaves “${merge.a.name}” and “${merge.b.name}” open to each other. Keeping them apart is fine — they simply become connected. Merging is not reversible by redrawing the wall: the space that is absorbed loses its name, its feed binding and any zones it had joined.`}
          onClose={() => setMerge(null)}
        >
          <footer>
            <button className="button secondary" onClick={() => setMerge(null)}>
              Cancel
            </button>
            <button
              className="button secondary"
              onClick={() => {
                const wallId = merge.wallId;
                setMerge(null);
                reshape(p => {
                  removeBarrier(p, wallId);
                  pruneOntology(p);
                });
                select(null);
              }}
            >
              Keep both spaces
            </button>
            {[
              [merge.a, merge.b],
              [merge.b, merge.a],
            ].map(([keep, absorbed]) => (
              <button
                key={keep.id}
                className="button"
                onClick={() => {
                  const wallId = merge.wallId;
                  setMerge(null);
                  commit(p => {
                    removeBarrier(p, wallId);
                    mergeSpaces(p, keep.id, absorbed.id);
                    pruneOntology(p);
                  });
                  select(null);
                }}
              >
                Merge into “{keep.name}”
              </button>
            ))}
          </footer>
        </Modal>
      )}
      {deleteOpen && (
        <Modal
          title="Delete selected object?"
          subtitle={
            deleteCount
              ? `This also removes ${deleteCount} attached opening${deleteCount > 1 ? 's' : ''}. The operation can be undone.`
              : 'This operation can be undone. Child zones become independent areas.'
          }
          onClose={() => setDeleteOpen(false)}
        >
          <footer>
            <button className="button secondary" onClick={() => setDeleteOpen(false)}>
              Cancel
            </button>
            <button className="button danger" onClick={deleteSelected}>
              Delete object
            </button>
          </footer>
        </Modal>
      )}
      {floorDeleteId && (
        <Modal
          title={`Delete ${project.floors.find(f => f.id === floorDeleteId)?.name ?? 'floor'}?`}
          subtitle={`${floorLoss(floorDeleteId)} This operation can be undone.`}
          onClose={() => setFloorDeleteId(null)}
        >
          <footer>
            <button className="button secondary" onClick={() => setFloorDeleteId(null)}>
              Cancel
            </button>
            <button className="button danger" onClick={() => deleteFloorNow(floorDeleteId)}>
              Delete floor
            </button>
          </footer>
        </Modal>
      )}
      {helpOpen && (
        <Modal
          title="A few tools. A whole new perspective."
          subtitle="Everything you need to model and monitor your site."
          onClose={() => setHelpOpen(false)}
        >
          <div className="help-content">
            <h3>Start with your sources</h3>
            <p>
              Import footprint GeoJSON or an architectural PNG, JPEG, or PDF. Align two image points to two map points,
              then trace walls and zones. Choose a drawing in Reference drawings to fine-tune its position.
            </p>
            <h3>Connected by design</h3>
            <p>
              Walls snap to junctions. Doors and windows attach to walls; gates attach to fences. Select an area and use
              “Cut a hole” for courtyards or exclusions. Parent zones must contain their children.
            </p>
            <h3>Explore and monitor</h3>
            <p>
              Switch to 3D for a floor cutaway or a building stack. Basement cutaways rebase the view while preserving
              saved elevations. Select any bound object to inspect its live status.
            </p>
            <div className="shortcut-grid">
              {[
                ['1 · 2 · 3', 'Viewer · Editor · Live'],
                ['T', '2D / 3D'],
                ['X', 'Cutaway / all floors'],
                ['⇧ ↑ / ⇧ ↓', 'Floor up / down'],
                ['⇧ ← / ⇧ →', 'Rotate map'],
                ['↑ ↓ ← →', 'Pan map'],
                ['⇧ W / ⇧ S', 'Tilt 3D camera'],
                ['N', 'Dark / light mode'],
                ['B', 'Side panel'],
                ['I', 'Properties panel'],
                ['G', 'Navigate & directions'],
                ['F', 'Full-screen map'],
                ['⇧ (hold)', 'Show shortcuts'],
                ['V', 'Select'],
                ['H', 'Pan'],
                ['W', 'Wall'],
                ['D', 'Door'],
                ['C', 'Camera'],
                ['Z', 'Zone'],
                ['S', 'Split room'],
                ['M', 'Measure'],
                ['Enter', 'Finish drawing'],
                ['Esc', 'Close panel / cancel'],
                ['⌘/Ctrl Z', 'Undo'],
                ['⌘/Ctrl ⇧ Z', 'Redo'],
                ['⌘/Ctrl D', 'Duplicate'],
                ['⌘/Ctrl S', 'Export'],
              ].map(([key, name]) => (
                <div key={key}>
                  <span>{name}</span>
                  <kbd>{key}</kbd>
                </div>
              ))}
            </div>
            <p className="helper">
              Projects save in this browser. Export a portable JSON backup to move projects and their reference drawings
              between them.
            </p>
          </div>
        </Modal>
      )}
    </div>
  );
}
function InfoIcon() {
  return <ShieldCheck size={18} />;
}
export function SiteViewer(props: SitePlannerProps) {
  return <SitePlanner {...props} readOnly />;
}
