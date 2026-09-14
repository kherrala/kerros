// FloorViewer wraps MapCanvas directly — never SiteViewer (which is the full SitePlanner with history,
// persistence and dialogs). It reads no import.meta.env and imports no stylesheet: hosts import the
// viewer package's styles.css (which bundles maplibre-gl's own CSS); app entrypoints import both.
import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { openingFloorId } from '../model/project';
import type { AssetRepository, Point, ProjectDocument } from '../model/types';
import type { StatusReading } from '../model/live';
import type { BasemapConfig, CameraState, ElevatorControls, StatusPanelContext } from '../model/host';
import type { Route } from '../model/navigation';
import type { WalkAvatar } from '../map/walk';
import type { ReactNode } from 'react';
import { MapCanvas } from '../map/MapCanvas';
import { sunAt } from '../map/lighting';
import { useKerrosTheme } from '../theme';

const NO_ASSETS: AssetRepository = { get: async () => undefined, put: async () => {}, delete: async () => {} };
const NOOP = () => {};
const EMPTY_DRAFT: Point[] = [];
const ViewerWorkspace = lazy(() => import('./ViewerWorkspace'));

export type ViewerMode = '2d' | '3d' | 'walk';
export interface ViewerDisplayOptions {
  showLabels: boolean;
  showPlan: boolean;
  coverage: boolean;
  excavation: boolean;
  cityBuildings: boolean;
  cadastre: boolean;
}

export interface FloorViewerProps {
  project: ProjectDocument;
  /** Include floor/view controls, structure, graph, directions and read-only properties panels.
   * Omit for a map-only embed with host-owned chrome. Never enables document editing. */
  controls?: boolean;
  /** Repository for reference-drawing images. Omit → drawings are simply not rendered. */
  assets?: AssetRepository;
  /** Complete current status set (replace semantics — the viewer does NOT accumulate deltas; absent devices read as unknown). */
  statuses?: StatusReading[];
  /** Omit → neutralBasemap (offline plan background). */
  basemap?: BasemapConfig;
  /** undefined → viewer manages floors internally, opening on the document's `initialFloorId` when it
   *  sets one, else the ground floor (elevation 0, else first). null is a real value: the outdoor site. */
  floorId?: string | null;
  onFloorChange?: (floorId: string | null) => void;
  /** undefined → viewer manages selection internally. */
  selected?: string | null;
  onSelect?: (id: string | null) => void;
  /** Fires as the pointer hovers a plan object (null when leaving). */
  onHoverObject?: (id: string | null) => void;
  threeD?: boolean;
  /** Controlled view mode; takes precedence over the legacy threeD/walk flags. */
  viewMode?: ViewerMode;
  onViewModeChange?: (mode: ViewerMode) => void;
  stack?: boolean;
  onStackChange?: (stack: boolean) => void;
  /** Walk the floor at eye level with keyboard and mouse. Implies threeD; stack is ignored.
   *  This is the mode indoor navigation is meant to be read in — a visitor is standing in it. */
  walk?: boolean;
  onWalkExit?: () => void;
  avatar?: WalkAvatar | null;
  onAvatar?: (avatar: WalkAvatar) => void;
  onWalkAt?: (avatar: WalkAvatar) => void;
  /** Focus a listed object, retaining the walking camera when in POV. */
  focusId?: string | null;
  /** Host-owned lift commands and transient readings; never persisted into the plan. */
  elevators?: ElevatorControls;
  route?: Route | null;
  onRouteChange?: (route: Route | null) => void;
  playing?: boolean;
  onPlayingChange?: (playing: boolean) => void;
  activeStep?: number | null;
  onJourneyStep?: (index: number) => void;
  onJourneyEnd?: () => void;
  dark?: boolean;
  showLabels?: boolean;
  showPlan?: boolean;
  coverage?: boolean;
  excavation?: boolean;
  cityBuildings?: boolean;
  cadastre?: boolean;
  /** Updates from built-in display controls. Supplied display props remain controlled. */
  onDisplayChange?: (options: ViewerDisplayOptions) => void;
  renderStatusPanel?: (context: StatusPanelContext) => ReactNode;
  /** Exact camera to restore (deep links); suppresses the automatic fit-to-floor on load. */
  initialCamera?: CameraState;
  /** The underlying MapLibre map, for hosts that deep-link or observe the camera. */
  onReady?: (map: import('maplibre-gl').Map) => void;
  onError?: (message: string) => void;
}

export function FloorViewer(props: FloorViewerProps) {
  return props.controls ? (
    <Suspense
      fallback={
        <div className="renderer-loading" role="status">
          Loading viewer…
        </div>
      }
    >
      <ViewerWorkspace key={props.project.id} {...props} />
    </Suspense>
  ) : (
    <FloorCanvas {...props} />
  );
}

function FloorCanvas(props: FloorViewerProps) {
  const { project } = props;
  const themeNotify = useKerrosTheme().notify;
  const [internalFloor, setInternalFloor] = useState<string | null>(() => openingFloorId(project));
  const [internalSelected, setInternalSelected] = useState<string | null>(null);
  // Controlled-when-provided: `!== undefined` (never ??) — controlled null means the outdoor site / no selection.
  const floorId = props.floorId !== undefined ? props.floorId : internalFloor;
  const selected = props.selected !== undefined ? props.selected : internalSelected;
  const walk = props.viewMode ? props.viewMode === 'walk' : (props.walk ?? false);
  const threeD = props.viewMode ? props.viewMode !== '2d' : props.threeD || walk || false;
  const changeFloor = (id: string | null) => {
    if (props.floorId === undefined) setInternalFloor(id);
    props.onFloorChange?.(id);
  };
  const select = (id: string | null) => {
    const entity =
      project.objects.find(o => o.id === id) ??
      project.barriers.find(b => b.id === id) ??
      project.drawings.find(d => d.id === id);
    if (
      entity &&
      entity.floorId !== floorId &&
      !('servedFloorIds' in entity && entity.servedFloorIds?.includes(floorId ?? ''))
    )
      changeFloor(entity.floorId);
    if (props.selected === undefined) setInternalSelected(id);
    props.onSelect?.(id);
  };
  // Swapping the document (same viewer instance): clamp the internally-managed floor to the new
  // project so a stale floor id doesn't strand the viewer on an empty (invisible) floor.
  useEffect(() => {
    if (props.floorId === undefined) setInternalFloor(openingFloorId(project));
    if (props.selected === undefined) setInternalSelected(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id]);
  // Without an asset repository, drawings can't be resolved — don't hand them to the renderer (its
  // loader would surface a spurious "missing reference image" error). Documented: omit assets → no drawings.
  const displayProject = useMemo(
    () => (props.assets || !project.drawings.length ? project : { ...project, drawings: [] }),
    [project, props.assets],
  );
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick(t => t + 1), 5000);
    return () => clearInterval(timer);
  }, []);
  // tick refreshes the Map identity every 5 s so staleness tones re-evaluate without new status data.
  const statuses = useMemo(
    () => new Map([...(props.statuses ?? []), ...(props.elevators?.statuses ?? [])].map(s => [s.feedId, s])),
    [props.statuses, props.elevators?.statuses, tick],
  );
  // The viewer is what a visitor sees, and a visitor is standing in the building at the time they
  // are looking at it: its light should be that light. No switch — the clock and the site's own
  // coordinates decide, and the building's own lamps keep the interior readable after dark.
  const [minute, setMinute] = useState(() => Date.now());
  useEffect(() => {
    const tock = window.setInterval(() => setMinute(Date.now()), 600000);
    return () => window.clearInterval(tock);
  }, []);
  const sun = useMemo(() => sunAt([project.origin[0], project.origin[1]], minute), [project.origin, minute]);
  return (
    <div className={`kerros-root kerros-surface ${props.dark ? 'dark' : ''}`}>
      <MapCanvas
        project={displayProject}
        canEdit={false}
        floorId={floorId}
        selected={selected}
        tool="select"
        draft={EMPTY_DRAFT}
        hover={null}
        threeD={threeD}
        stack={walk ? false : (props.stack ?? false)}
        walk={walk}
        onWalkExit={props.onWalkExit}
        onRequestFloor={changeFloor}
        avatar={props.avatar}
        onAvatar={props.onAvatar}
        onWalkAt={props.onWalkAt}
        focusId={props.focusId}
        route={props.route}
        playing={props.playing}
        activeStep={props.activeStep}
        onJourneyStep={props.onJourneyStep}
        onJourneyEnd={props.onJourneyEnd}
        elevators={props.elevators}
        coverage={props.coverage ?? false}
        showLabels={props.showLabels ?? true}
        showPlan={props.showPlan ?? true}
        sun={sun}
        dark={props.dark ?? false}
        excavation={props.excavation}
        cityBuildings={props.cityBuildings ?? false}
        cadastre={props.cadastre ?? false}
        basemap={props.basemap}
        assets={props.assets ?? NO_ASSETS}
        statuses={statuses}
        onClick={(_, id) => select(id)}
        onHover={NOOP}
        onSelect={select}
        onHoverObject={props.onHoverObject}
        onVertexMove={NOOP}
        onError={props.onError ?? (themeNotify ? (m: string) => themeNotify(m, 'error') : NOOP)}
        initialCamera={props.initialCamera}
        onReady={props.onReady}
      />
    </div>
  );
}
