import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Bell,
  ChevronRight,
  CircleHelp,
  Eye,
  Layers3,
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
  Settings2,
  Shapes,
  ShieldCheck,
  Sun,
  Waypoints,
  X,
} from 'lucide-react';
import type { Map as GLMap } from 'maplibre-gl';
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { exportProject } from './adapters/persistence';
import { statusTone } from './adapters/status';
import { useProjectPersistence } from './adapters/useProjectPersistence';
import { AlignmentPanel, ImportDialog } from './components/ImportDialog';
import { Inspector } from './components/Inspector';
import { NavigatePanel } from './components/NavigatePanel';
import { StructureView, type StructureTarget } from './components/StructureView';
import { Modal } from './components/controls';
import { importPlanEntities, type PlanImportReport } from './import/planImport';
import { loadAiImportSession } from './import/session';
import { MapCanvas } from './map/MapCanvas';
import { floorAim } from './map/journey';
import type { WalkAvatar } from './map/walk';
import { boundaryEdges, connectSpace, disconnectSpace } from './model/boundaries';
import { createObject } from './model/factory';
import {
  add,
  addBarrier,
  closeRing,
  duplicateFloor,
  footprint,
  moveOrigin,
  removeBarrier,
  removeFloor,
  toLngLat,
} from './model/geometry';
import { commitHistory, makeHistory, redoHistory, undoHistory } from './model/history';
import type { CameraState, SitePlannerProps } from './model/host';
import { mergeSpaces, spacesRejoinedBy } from './model/inference';
import type { StatusReading } from './model/live';
import { findRoute, HERE, type RouteEnd } from './model/navigation';
import { pruneOntology } from './model/ontology';
import { openingFloorId } from './model/project';
import { derivedGraph } from './model/topology';
import type { Barrier, Drawing, Floor, Point, ProjectDocument, SiteObject } from './model/types';
import { uid } from './model/types';
import { transact, validateProject } from './model/validate';
import { DrawingDock } from './planner/DrawingDock';
import { FloorControls } from './planner/FloorControls';
import { MapSettings } from './planner/MapSettings';
import { PlannerHelp } from './planner/PlannerHelp';
import { ProjectSidebar, useProjectSidebar } from './planner/ProjectSidebar';
import { floorBand } from './planner/floors';
import { useDrawingTools } from './planner/useDrawingTools';
import { useMapDisplay } from './planner/useMapDisplay';
import { usePlannerKeyboard } from './planner/usePlannerKeyboard';
import { useReferenceAlignment } from './planner/useReferenceAlignment';
import { useDarkMode, useKerrosTheme, useStrings } from './theme';
const NavigationGraph = lazy(() =>
  import('./components/NavigationGraph').then(module => ({ default: module.NavigationGraph })),
);

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
  elevators,
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
  const [aiRunning, setAiRunning] = useState(false);
  const editing = mode === 'edit' && !aiRunning,
    live = mode === 'live';
  const [threeD, setThreeD] = useState(initialView?.threeD ?? initialView?.mode !== 'edit'),
    [stack, setStack] = useState(initialView?.stack ?? false),
    [walk, setWalk] = useState(initialView?.walk ?? false);
  const [merge, setMerge] = useState<{ wallId: string; a: SiteObject; b: SiteObject } | null>(null);
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
  const [palette, setPalette] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(initialView?.mode === 'edit' && !readOnly);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const display = useMapDisplay(project, adapters.basemap, initialView);
  const {
    coverage,
    showLabels,
    showPlan,
    sun,
    excavation,
    cityBuildings,
    cadastre,
    settings,
    setSettings,
    basemap,
    canAdopt,
  } = display;
  const sidebar = useProjectSidebar();
  const [planImportOpen, setPlanImportOpen] = useState(false);
  const [planImportMounted, setPlanImportMounted] = useState(false);
  useEffect(() => {
    if (!adapters.aiImport || readOnly) return;
    let active = true;
    void loadAiImportSession(adapters.assets, initial.id)
      .then(session => {
        if (active && session) {
          setPlanImportMounted(true);
          setPlanImportOpen(true);
          setMode('edit');
          setSidebarOpen(true);
        }
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [adapters.aiImport, adapters.assets, initial.id, readOnly]);
  const [importOpen, setImportOpen] = useState(false),
    [floorModal, setFloorModal] = useState(false),
    [helpOpen, setHelpOpen] = useState(false),
    [deleteOpen, setDeleteOpen] = useState(false),
    [floorDeleteId, setFloorDeleteId] = useState<string | null>(null);
  const [toast, setToast] = useState(''),
    [activeTab, setActiveTab] = useState<'structure' | 'objects'>('structure'),
    [statuses, setStatuses] = useState<Map<string, StatusReading>>(new Map());
  // The person, apart from the camera: where the last walk ended, or where the person marker was
  // dropped. Survives leaving the walk — the 2D plan shows them standing there — and not the project.
  const [avatar, setAvatar] = useState<WalkAvatar | null>(null);
  const [graphView, setGraphView] = useState(false);
  const [graphFloor, setGraphFloor] = useState<string | null | undefined>(undefined);
  const graphCamera = useRef<CameraState | undefined>(undefined);
  const pendingLocate = useRef<{ points: Point[] } | null>(null);
  useEffect(() => setAvatar(null), [project.id]);
  // Indoor navigation: route-tool chaining anchor, the A-to-B panel and journey playback state.
  const [navigating, setNavigating] = useState(false),
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
  // "Where you are" is the avatar — where the last walk left the person, or where the marker was
  // dropped — and it is the start most people want, so the panel proposes it. It is a point, not
  // an object, and the router takes it as one.
  // While a route is being played the person is being carried along it, and a start that followed
  // them would shorten the route under the playback step by step. The start is frozen where the
  // play began and follows the person again once it stops.
  const playStart = useRef<WalkAvatar | null>(null);
  const route = useMemo(() => {
    const at = playing ? (playStart.current ?? avatar) : avatar;
    const end = (id: string | null): RouteEnd | null =>
      id === HERE ? (at ? { floorId: at.floorId, position: at.position } : null) : id;
    const a = end(navFrom),
      b = end(navTo);
    return a && b
      ? findRoute(history.present, a, b, {
          statuses: new Map([...statuses, ...(elevators?.statuses ?? []).map(s => [s.feedId, s] as const)]),
        })
      : null;
  }, [history.present, navFrom, navTo, avatar, playing, statuses, elevators?.statuses]);
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
    [newBuildingName, setNewBuildingName] = useState('');
  const mapRef = useRef<GLMap | null>(null),
    latestProject = useRef(project),
    onChangeRef = useRef(onChange),
    onViewChangeRef = useRef(onViewChange);
  latestProject.current = project;
  onChangeRef.current = onChange;
  onViewChangeRef.current = onViewChange;
  // The current view (floor, mode, camera pose) is emitted through onViewChange on state changes and
  // on every camera moveend; hosts persist it however they like (the reference app writes a deep-link
  // fragment). The library itself touches no URL. writeHash keeps its name for its call sites.
  const viewRef = useRef({ floorId, threeD, stack, walk });
  viewRef.current = { floorId, threeD, stack, walk };
  // `force` distinguishes a state change from a camera move. Walking writes a camera every animation
  // frame, and every write here is a history.replaceState — so while walking only the mode change
  // itself is published, and the pose it publishes is the one you set off from.
  const writeHash = useCallback((force = false) => {
    const m = mapRef.current;
    if (!m || playingRef.current) return;
    const v = viewRef.current;
    if (v.walk && !force) return;
    const c = m.getCenter();
    onViewChangeRef.current?.({
      floor: v.floorId,
      threeD: v.threeD,
      stack: v.stack,
      walk: v.walk,
      camera: { center: [c.lng, c.lat], zoom: m.getZoom(), bearing: m.getBearing(), pitch: m.getPitch() },
    });
  }, []);
  useEffect(() => {
    writeHash(true);
  }, [floorId, threeD, stack, walk, writeHash]);
  // The three ways of looking at a plan. 2D is the drawing, 3D is the model, walk is standing in it —
  // one cycle so a single key reaches all three, and one setter so the modes cannot half-overlap
  // (walking a stack of every floor at once is not a thing a person can do).
  const viewMode: 'walk' | '3d' | '2d' = walk ? 'walk' : threeD ? '3d' : '2d';
  const nextView = viewMode === '2d' ? '3d' : viewMode === '3d' ? 'walk' : '2d';
  const chooseMode = (next: 'walk' | '3d' | '2d') => {
    setWalk(next === 'walk');
    setThreeD(next !== '2d');
    if (next === 'walk') setStack(false);
    if (next !== '2d') {
      setTool('select');
      setDraft([]);
    }
  };
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
  const { state: saveState, flush, saveNow } = useProjectPersistence(project, adapters.projects, !readOnly, notify);
  const applyAiProject = useCallback(
    async (document: ProjectDocument) => {
      const next = validateProject({ ...document, id: latestProject.current.id, updatedAt: new Date().toISOString() });
      latestProject.current = next;
      setHistory(current => ({ ...commitHistory(current, next), present: next }));
      setFloorId(current => (next.floors.some(f => f.id === current) ? current : openingFloorId(next)));
      setSelected(null);
      setDraft([]);
      // Use the same ordered writer as ordinary autosave, without waiting for its debounce.
      await saveNow(next);
    },
    [saveNow],
  );
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
  const drawing = useDrawingTools({
    project,
    floorId,
    selected,
    editing,
    threeD,
    commit,
    notify,
    setSelected,
    onSelect: select,
    onFloorChange: changeFloor,
    onChooseTool: () => {
      setPalette(false);
      setThreeD(false);
    },
  });
  const {
    tool,
    setTool,
    draft,
    setDraft,
    hover,
    snapping,
    setSnapping,
    routeAnchor,
    setRouteAnchor,
    chooseTool,
    finish,
    adoptBuilding,
    onHover,
    guides,
    geometryPreview,
    vertexMove,
    updateObject,
  } = drawing;
  const { alignment, setAlignment, startAlignment, previewAlignment, confirmAlignment, calibrate, displayProject } =
    useReferenceAlignment({
      project,
      floorId,
      assets: adapters.assets,
      commit,
      notify,
      setSelected,
      onStart: () => {
        setThreeD(false);
        setTool('select');
      },
    });
  // Geometry synchronization lives in transact, including host edits and every drawing tool.
  const reshape = commit;
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
    () =>
      new Map([...(mode === 'view' ? [] : statuses), ...(elevators?.statuses ?? []).map(s => [s.feedId, s] as const)]),
    [mode, statuses, elevators?.statuses],
  );
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
  function stepFloor(direction: 1 | -1) {
    const list = floorBand(project, floorId);
    const index = list.findIndex(f => f.id === floorId);
    const next = index < 0 ? (direction === 1 ? list[0] : list[list.length - 1]) : list[index + direction];
    if (next) changeFloor(next.id);
  }
  const keyHint = (label: string) => (showKeys ? <kbd className="key-hint">{label}</kbd> : null);
  function select(id: string | null, focus = false) {
    const entity =
      project.objects.find(o => o.id === id) ??
      project.barriers.find(b => b.id === id) ??
      project.virtualBoundaries?.find(b => b.id === id) ??
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
  function openGraph(floor?: string | null) {
    const map = mapRef.current;
    if (map) {
      const center = map.getCenter();
      graphCamera.current = {
        center: [center.lng, center.lat],
        zoom: map.getZoom(),
        pitch: map.getPitch(),
        bearing: map.getBearing(),
      };
    }
    stopPlaying();
    setWalk(false);
    setGraphFloor(floor);
    setGraphView(true);
    mapRef.current = null;
  }
  function frameLocated() {
    const target = pendingLocate.current,
      map = mapRef.current;
    if (!target || !map) return;
    pendingLocate.current = null;
    if (!target.points.length) return;
    let west = Infinity,
      east = -Infinity,
      south = Infinity,
      north = -Infinity;
    for (const point of target.points) {
      const [lng, lat] = toLngLat(point, project.origin);
      west = Math.min(west, lng);
      east = Math.max(east, lng);
      south = Math.min(south, lat);
      north = Math.max(north, lat);
    }
    map.fitBounds(
      [
        [west, south],
        [east, north],
      ],
      { padding: 90, maxZoom: 20, duration: 450 },
    );
  }
  function locateStructure(target: StructureTarget) {
    const ids = new Set(target.objectIds ?? []);
    const objects = project.objects.filter(object => ids.has(object.id));
    const chosenFloor =
      target.floorId !== undefined
        ? target.floorId
        : objects.some(object => object.floorId === floorId)
          ? floorId
          : (objects[0]?.floorId ?? floorId);
    const onFloor = objects.filter(
      object => object.floorId === chosenFloor || object.servedFloorIds?.includes(chosenFloor ?? ''),
    );
    const points = target.position ? [target.position] : onFloor.flatMap(object => footprint(object).flat());
    if (!points.length)
      points.push(
        ...project.objects.filter(object => object.floorId === chosenFloor).flatMap(object => footprint(object).flat()),
      );
    pendingLocate.current = { points };
    setSelected(onFloor[0]?.id ?? null);
    onSelectionChange?.(onFloor[0]?.id ?? null);
    setGraphView(false);
    chooseMode('2d');
    setFloorId(chosenFloor);
    requestAnimationFrame(frameLocated);
  }
  useEffect(() => {
    if (!graphView) requestAnimationFrame(frameLocated);
  }, [graphView, floorId, threeD]);
  function changeFloor(id: string | null) {
    setFloorId(id);
    setSelected(null);
    setDraft([]);
    setTool('select');
    setAlignment(null);
    setRouteAnchor(null);
  }
  function mapClick(raw: Point, id: string | null) {
    // Reference alignment consumes map clicks before the drawing tools.
    if (window.matchMedia('(max-width: 840px)').matches) setSidebarOpen(false);
    if (alignment) {
      if (alignment.preview || alignment.imagePoints.length < 2 || alignment.mapPoints.length >= 2) return;
      setAlignment({ ...alignment, mapPoints: [...alignment.mapPoints, raw] });
      return;
    }
    drawing.mapClick(raw, id);
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
      clone.geometry = { mode: 'independent' };
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
    const virtual = project.virtualBoundaries?.some(b => b.id === selected);
    const owners = virtual
      ? project.objects.filter(
          o => o.geometry?.mode === 'boundaries' && o.geometry.loops.some(l => l.some(u => u.edgeId === selected)),
        )
      : [];
    if (virtual && owners.length === 1) {
      notify('This boundary closes a space. Move it, or switch the space to Independent outline before removing it.');
      setDeleteOpen(false);
      return;
    }
    const rejoin =
      owners.length === 2
        ? owners
        : project.barriers.some(b => b.id === selected)
          ? spacesRejoinedBy(project, selected)
          : null;
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
      // The transaction preserves referenced walls as virtual edges and regenerates space caches.
      reshape(p => {
        p.objects = p.objects.filter(o => o.id !== selected && o.barrierId !== selected);
        p.objects.forEach(o => {
          if (o.parentId === selected) o.parentId = undefined;
        });
        p.barriers = p.barriers.filter(b => b.id !== selected);
        if (p.virtualBoundaries) p.virtualBoundaries = p.virtualBoundaries.filter(b => b.id !== selected);
        p.drawings = p.drawings.filter(d => d.id !== selected);
        p.junctions = p.junctions.filter(j => boundaryEdges(p).some(b => b.startId === j.id || b.endId === j.id));
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
    const node = route.nodes.find(n => n.id === step.nodeIds.at(-1));
    if (!moved && node && mapRef.current)
      mapRef.current.easeTo({
        // Through the map's own depth aim: in 3D the step is drawn at its storey's elevation, and a
        // node in the garage centred on its ground coordinate lands well outside the frame.
        center: floorAim(mapRef.current, project, node.position, step.floorId, { threeD, stack }),
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
  const showKeys = usePlannerKeyboard({
    graphView,
    editing,
    threeD,
    walk,
    hasDraft: !!draft.length,
    hasSelection: !!selected,
    mapRef,
    chooseTool,
    stepFloor,
    commands: {
      undo: () => {
        setHistory(undoHistory);
        setDraft([]);
        setRouteAnchor(null);
      },
      redo: () => {
        setHistory(redoHistory);
        setDraft([]);
        setRouteAnchor(null);
      },
      undoPoint: () => setDraft(draft.slice(0, -1)),
      export: doExport,
      cancel: () => {
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
      },
      finish,
      help: () => setHelpOpen(true),
      view: enterView,
      edit: enterEdit,
      walk: () => chooseMode('walk'),
      live: enterLive,
      cycleView: () => chooseMode(nextView),
      toggleStack: () => setStack(!stack),
      toggleSidebar: () => setSidebarOpen(!sidebarOpen),
      toggleInspector: () => {
        setPlanImportOpen(false);
        setStructuring(false);
        setNavigating(false);
        setInspectorOpen(!inspectorOpen);
      },
      toggleFullscreen: () => setFullscreen(!fullscreen),
      toggleNavigation: () => {
        setPlanImportOpen(false);
        if (navigating) stopPlaying();
        setNavigating(!navigating);
      },
      toggleTheme: toggleDark,
      deleteSelection: () => setDeleteOpen(true),
      duplicate: duplicateSelected,
    },
  });
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
  const selectedBarrier = project.barriers.find(b => b.id === selected);
  const deleteCount = selectedBarrier ? project.objects.filter(o => o.barrierId === selected).length : 0;
  const renderImport = (importMode: 'reference' | 'plan') => (
    <ImportDialog
      key={`${project.id}:${importMode}`}
      mode={importMode}
      project={project}
      floorId={floorId}
      assets={adapters.assets}
      importProjections={adapters.importProjections}
      aiImport={adapters.aiImport}
      pdfDrawing={adapters.pdfDrawing}
      onAiProject={applyAiProject}
      onAiRunningChange={setAiRunning}
      onClose={() => (importMode === 'plan' ? setPlanImportOpen(false) : setImportOpen(false))}
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
  );
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
          <ProjectSidebar
            state={sidebar}
            project={project}
            floorId={floorId}
            selected={selected}
            mode={mode}
            editing={editing}
            readOnly={readOnly}
            statuses={statuses}
            alarmFloors={alarmFloors}
            activeTab={activeTab}
            setActiveTab={setActiveTab}
            leave={leave}
            select={select}
            changeFloor={changeFloor}
            onAnchor={() => {
              if (!editing) enterEdit();
              select(null);
              setInspectorOpen(true);
            }}
            onAddFloor={() => {
              setNewFloorElevation(Math.max(...project.floors.map(f => f.elevation + f.height)));
              setFloorModal(true);
            }}
            onDuplicateFloor={() => {
              let id = '';
              if (
                commit(p => {
                  id = duplicateFloor(p, floorId!);
                })
              ) {
                setFloorId(id);
                notify('Floor duplicated with new IDs and cleared feed bindings.');
              }
            }}
            onImportReference={() => setImportOpen(true)}
          />
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
              <span className="mode-pill">{aiRunning ? 'AI IMPORT' : editing ? 'EDITING' : 'VIEWING'}</span>
            </div>
            <div>
              {(editing || aiRunning) && (
                <button
                  className="icon-button"
                  aria-label="Import plan"
                  title="Import plan"
                  aria-pressed={planImportOpen}
                  data-import-running={aiRunning || undefined}
                  onClick={() => {
                    setPlanImportMounted(true);
                    setPlanImportOpen(!planImportOpen);
                    if (!planImportOpen) {
                      setNavigating(false);
                      setStructuring(false);
                      setInspectorOpen(false);
                    }
                  }}
                >
                  <ArrowDownToLine size={17} />
                </button>
              )}
              <button
                className="icon-button"
                aria-label="Export project"
                title="Export portable project"
                onClick={doExport}
              >
                <ArrowUpFromLine size={17} />
              </button>
              <button
                className={`icon-button ${structuring ? 'active-nav' : ''}`}
                aria-label={structuring ? 'Hide structure panel' : 'Show structure panel'}
                title="Structure — zones and portals"
                onClick={() => {
                  setPlanImportOpen(false);
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
                  setPlanImportOpen(false);
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
                onClick={() => {
                  setPlanImportOpen(false);
                  setStructuring(false);
                  setNavigating(false);
                  setInspectorOpen(!inspectorOpen);
                }}
              >
                {inspectorOpen ? <PanelRightClose size={17} /> : <PanelRightOpen size={17} />}
                {keyHint('I')}
              </button>
            </div>
          </div>
          {graphView ? (
            <Suspense
              fallback={
                <p className="structure-empty" role="status">
                  Loading navigation graph…
                </p>
              }
            >
              <NavigationGraph
                project={project}
                initialFloor={graphFloor}
                dark={dark}
                onLocate={locateStructure}
                onClose={() => setGraphView(false)}
              />
            </Suspense>
          ) : (
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
                sun={sun}
                dark={dark}
                excavation={excavation}
                cityBuildings={cityBuildings}
                cadastre={cadastre}
                basemap={basemap}
                assets={adapters.assets}
                statuses={shownStatuses}
                elevators={elevators}
                focusId={focusId}
                alignment={alignment ? { image: alignment.imagePoints, map: alignment.mapPoints } : undefined}
                onClick={mapClick}
                onAdopt={adoptBuilding}
                onHover={onHover}
                onSelect={id => select(id)}
                onVertexMove={vertexMove}
                onVertexPreview={(kind, id, point, ring, vertex, free) =>
                  geometryPreview(kind, id, point, free, ring, vertex)
                }
                snapping={snapping}
                onError={notify}
                route={route}
                activeStep={playStep}
                playing={playing}
                onJourneyStep={index => setPlayStep(index)}
                onJourneyEnd={() => {
                  stopPlaying();
                  writeHash(true);
                }}
                walk={walk}
                onWalkExit={() => chooseMode('3d')}
                avatar={avatar}
                onAvatar={setAvatar}
                onWalkAt={a => {
                  setAvatar(a);
                  if (a.floorId !== floorId) setFloorId(a.floorId);
                  chooseMode('walk');
                }}
                onRequestFloor={id => setFloorId(id)}
                onReady={map => {
                  mapRef.current = map;
                  requestAnimationFrame(frameLocated);
                  map.on('moveend', () => writeHash());
                  writeHash(true);
                }}
                initialCamera={graphCamera.current ?? initialView?.camera}
              />
              <FloorControls
                project={project}
                floorId={floorId}
                mode={mode}
                viewMode={viewMode}
                stack={stack}
                alarmFloors={alarmFloors}
                showKeys={showKeys}
                changeFloor={changeFloor}
                chooseMode={chooseMode}
                setStack={setStack}
                stepFloor={stepFloor}
              />
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
                <MapSettings
                  display={display}
                  project={project}
                  floorId={floorId}
                  editing={editing}
                  hostBasemap={adapters.basemap}
                  commit={commit}
                  snapping={snapping}
                  setSnapping={setSnapping}
                />
              )}
              {editing && !threeD && !alignment && (
                <DrawingDock
                  drawing={drawing}
                  projectHasGraph={!!project.navNodes}
                  showKeys={showKeys}
                  palette={palette}
                  setPalette={setPalette}
                  canAdopt={canAdopt}
                  adoptDerivedGraph={adoptDerivedGraph}
                  canUndo={!!history.past.length}
                  canRedo={!!history.future.length}
                  onUndo={() => {
                    setHistory(undoHistory);
                    setDraft([]);
                    setRouteAnchor(null);
                  }}
                  onRedo={() => {
                    setHistory(redoHistory);
                    setDraft([]);
                    setRouteAnchor(null);
                  }}
                />
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
          )}
          <div className="canvas-statusbar">
            <span>
              <span className="status-dot normal" />
              {graphView
                ? 'Navigation graph'
                : editing
                  ? 'Editor ready'
                  : live
                    ? 'Live view ready'
                    : 'Plan viewer ready'}
            </span>
            <span>
              {project.barriers.length} barriers <i />
              {project.objects.length} objects <i />
              {project.floors.length} floors
            </span>
            <span>
              {graphView
                ? 'Drag to arrange · scroll to zoom'
                : snapping
                  ? 'Snapping on · 0.5 m · 15°'
                  : 'Free positioning'}
              <kbd>?</kbd>
            </span>
          </div>
        </main>
        {planImportMounted && (
          <div className="plan-import-slot" hidden={!planImportOpen}>
            {renderImport('plan')}
          </div>
        )}
        {!planImportOpen &&
          (alignment ? (
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
              onLocate={locateStructure}
              onGraphView={openGraph}
              // Same commit path as every map tool, so zones land in history and undo like anything else.
              onEdit={editing ? change => commit(change) : undefined}
            />
          ) : navigating ? (
            <NavigatePanel
              project={project}
              here={avatar ? { floorId: avatar.floorId, position: avatar.position } : null}
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
                setGraphView(false);
                playStart.current = avatar;
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
              onSpaceGeometry={
                editing
                  ? (id, source) =>
                      commit(p => (source === 'independent' ? disconnectSpace(p, id) : connectSpace(p, id, source)))
                  : undefined
              }
              onShiftOrigin={
                editing
                  ? (east, north) =>
                      commit(p => {
                        p.origin = moveOrigin(p.origin, east, north);
                      })
                  : undefined
              }
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
          ) : null)}
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
      {importOpen && renderImport('reference')}
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
          title={
            project.virtualBoundaries?.some(b => b.id === merge.wallId)
              ? 'This boundary divides two spaces'
              : 'This wall was dividing two spaces'
          }
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
      {helpOpen && <PlannerHelp onClose={() => setHelpOpen(false)} />}
    </div>
  );
}
function InfoIcon() {
  return <ShieldCheck size={18} />;
}
export function SiteViewer(props: SitePlannerProps) {
  return <SitePlanner {...props} readOnly />;
}
