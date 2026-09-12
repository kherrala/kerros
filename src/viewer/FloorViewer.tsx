// FloorViewer wraps MapCanvas directly — never SiteViewer (which is the full SitePlanner with history,
// persistence and dialogs). It reads no import.meta.env and imports no stylesheet: hosts import the
// viewer package's styles.css (which bundles maplibre-gl's own CSS); app entrypoints import both.
import { useEffect, useMemo, useState } from 'react';
import { openingFloorId } from '../model/project';
import type { AssetRepository, Point, ProjectDocument } from '../model/types';
import type { StatusReading } from '../model/live';
import type { BasemapConfig } from '../model/host';
import { MapCanvas } from '../map/MapCanvas';
import { sunAt } from '../map/lighting';
import { useKerrosTheme } from '../theme';

const NO_ASSETS: AssetRepository = { get: async () => undefined, put: async () => {}, delete: async () => {} };
const NOOP = () => {};
const EMPTY_DRAFT: Point[] = [];

export interface FloorViewerProps {
  project: ProjectDocument;
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
  stack?: boolean;
  /** Walk the floor at eye level with keyboard and mouse. Implies threeD; stack is ignored.
   *  This is the mode indoor navigation is meant to be read in — a visitor is standing in it. */
  walk?: boolean;
  onWalkExit?: () => void;
  dark?: boolean;
  showLabels?: boolean;
  showPlan?: boolean;
  /** Exact camera to restore (deep links); suppresses the automatic fit-to-floor on load. */
  initialCamera?: { center: [number, number]; zoom: number; bearing: number; pitch: number };
  /** The underlying MapLibre map, for hosts that deep-link or observe the camera. */
  onReady?: (map: import('maplibre-gl').Map) => void;
  onError?: (message: string) => void;
}

export function FloorViewer(props: FloorViewerProps) {
  const { project } = props;
  const themeNotify = useKerrosTheme().notify;
  const [internalFloor, setInternalFloor] = useState<string | null>(() => openingFloorId(project));
  const [internalSelected, setInternalSelected] = useState<string | null>(null);
  // Controlled-when-provided: `!== undefined` (never ??) — controlled null means the outdoor site / no selection.
  const floorId = props.floorId !== undefined ? props.floorId : internalFloor;
  const selected = props.selected !== undefined ? props.selected : internalSelected;
  const changeFloor = (id: string | null) => {
    if (props.floorId === undefined) setInternalFloor(id);
    props.onFloorChange?.(id);
  };
  const select = (id: string | null) => {
    const entity =
      project.objects.find(o => o.id === id) ??
      project.barriers.find(b => b.id === id) ??
      project.drawings.find(d => d.id === id);
    if (entity && entity.floorId !== null && entity.floorId !== floorId) changeFloor(entity.floorId);
    if (props.selected === undefined) setInternalSelected(id);
    props.onSelect?.(id);
  };
  // Swapping the document (same viewer instance): clamp the internally-managed floor to the new
  // project so a stale floor id doesn't strand the viewer on an empty (invisible) floor.
  useEffect(() => {
    if (props.floorId !== undefined) return;
    setInternalFloor(cur => (cur === null || project.floors.some(f => f.id === cur) ? cur : openingFloorId(project)));
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
  const statuses = useMemo(() => new Map((props.statuses ?? []).map(s => [s.feedId, s])), [props.statuses, tick]);
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
        threeD={props.threeD || props.walk || false}
        stack={props.walk ? false : (props.stack ?? false)}
        walk={props.walk ?? false}
        onWalkExit={props.onWalkExit}
        onRequestFloor={changeFloor}
        coverage={false}
        showLabels={props.showLabels ?? true}
        showPlan={props.showPlan ?? true}
        sun={sun}
        dark={props.dark ?? false}
        cityBuildings={false}
        cadastre={false}
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
