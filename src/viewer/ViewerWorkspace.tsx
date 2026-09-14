// Optional read-only chrome. Loaded only when requested; shares the editor's panels and renderer,
// without importing SitePlanner, history, persistence or import dialogs.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Footprints, Layers3, PanelRightOpen, Shapes, SlidersHorizontal, Waypoints, X } from 'lucide-react';
import type { Map as GLMap } from 'maplibre-gl';
import { FloorViewer, type FloorViewerProps, type ViewerDisplayOptions, type ViewerMode } from './FloorViewer';
import { openingFloorId } from '../model/project';
import { findRoute, HERE, type Route, type RouteEnd } from '../model/navigation';
import { footprint, toLngLat } from '../model/geometry';
import type { CameraState } from '../model/host';
import type { Point } from '../model/types';
import type { WalkAvatar } from '../map/walk';
import { StructureView, type StructureTarget } from '../components/StructureView';
import { NavigationPanel, NavigationGraph, ReadOnlyInspector } from './panels';
import { FloorSelect } from '../components/controls';

const DISPLAY: ViewerDisplayOptions = {
  showLabels: true,
  showPlan: true,
  coverage: false,
  excavation: true,
  cityBuildings: false,
  cadastre: false,
};
const DISPLAY_LABELS: Record<keyof ViewerDisplayOptions, string> = {
  showLabels: 'Object labels',
  showPlan: 'Floor plan',
  coverage: 'Device coverage',
  excavation: 'Underground context',
  cityBuildings: 'Surrounding buildings',
  cadastre: 'Cadastral parcels',
};
type Panel = 'structure' | 'navigate' | 'properties' | null;

export default function ViewerWorkspace(props: FloorViewerProps) {
  const { project } = props;
  const [ownFloor, setOwnFloor] = useState(() => openingFloorId(project));
  const [ownSelected, setOwnSelected] = useState<string | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [ownMode, setOwnMode] = useState<ViewerMode>('2d');
  const [ownStack, setOwnStack] = useState(false);
  const [ownDisplay, setOwnDisplay] = useState(DISPLAY);
  const [ownAvatar, setOwnAvatar] = useState<WalkAvatar | null>(null);
  const [panel, setPanel] = useState<Panel>(null);
  const [graph, setGraph] = useState(false);
  const [graphFloor, setGraphFloor] = useState<string | null | undefined>();
  const [from, setFrom] = useState<string | null>(null);
  const [to, setTo] = useState<string | null>(null);
  const [ownPlaying, setOwnPlaying] = useState(false);
  const [ownStep, setOwnStep] = useState<number | null>(null);
  const floorId = props.floorId !== undefined ? props.floorId : ownFloor;
  const selected = props.selected !== undefined ? props.selected : ownSelected;
  const mode =
    props.viewMode ??
    (props.walk !== undefined || props.threeD !== undefined
      ? props.walk
        ? 'walk'
        : props.threeD
          ? '3d'
          : '2d'
      : ownMode);
  const stack = props.stack ?? ownStack;
  const avatar = props.avatar !== undefined ? props.avatar : ownAvatar;
  const playing = props.playing ?? ownPlaying;
  const activeStep = props.activeStep !== undefined ? props.activeStep : ownStep;
  const display = Object.fromEntries(
    Object.keys(DISPLAY).map(key => {
      const name = key as keyof ViewerDisplayOptions;
      return [name, props[name] ?? ownDisplay[name]];
    }),
  ) as unknown as ViewerDisplayOptions;
  const map = useRef<GLMap | null>(null);
  const camera = useRef<CameraState | undefined>(props.initialCamera);
  const pending = useRef<Point[] | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const heldRoute = useRef<Route | null>(null);
  const [statusTick, setStatusTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setStatusTick(tick => tick + 1), 5000);
    return () => clearInterval(timer);
  }, []);
  const lastProject = useRef(project);
  useEffect(() => {
    if (props.floorId === undefined)
      setOwnFloor(current =>
        current === null || project.floors.some(f => f.id === current) ? current : openingFloorId(project),
      );
    if (props.selected === undefined)
      setOwnSelected(current =>
        [...project.objects, ...project.barriers, ...project.drawings, ...(project.virtualBoundaries ?? [])].some(
          o => o.id === current,
        )
          ? current
          : null,
      );
    if (lastProject.current !== project) {
      lastProject.current = project;
      setOwnPlaying(false);
      heldRoute.current = null;
      props.onPlayingChange?.(false);
    }
  }, [project]);
  const statuses = useMemo(
    () => new Map([...(props.statuses ?? []), ...(props.elevators?.statuses ?? [])].map(s => [s.feedId, s])),
    [props.statuses, props.elevators?.statuses, statusTick],
  );
  const proposedRoute = useMemo(() => {
    const end = (id: string | null): RouteEnd | null =>
      id === HERE ? (avatar ? { floorId: avatar.floorId, position: avatar.position } : null) : id;
    const a = end(from),
      b = end(to);
    return a && b ? findRoute(project, a, b, { statuses }) : null;
  }, [project, from, to, avatar, statuses]);
  // Keep the chosen path while the avatar and lift readings move. Rebuilding it every status tick
  // restarts the journey just as the lift is arriving. Runtime transport checks still read live status.
  const route = props.route !== undefined ? props.route : playing ? heldRoute.current : proposedRoute;
  const latestRouteChange = useRef(props.onRouteChange);
  latestRouteChange.current = props.onRouteChange;
  useEffect(() => latestRouteChange.current?.(route), [route]);
  const changeFloor = (id: string | null) => {
    setOwnFloor(id);
    props.onFloorChange?.(id);
  };
  const select = (id: string | null) => {
    setOwnSelected(id);
    props.onSelect?.(id);
  };
  const focusSelection = (id: string) => {
    const object = project.objects.find(o => o.id === id);
    if (object && object.floorId !== floorId && !object.servedFloorIds?.includes(floorId ?? ''))
      changeFloor(object.floorId);
    select(id);
    setFocusId(id);
  };
  const changeMode = (next: ViewerMode) => {
    setOwnMode(next);
    props.onViewModeChange?.(next);
  };
  const changeStack = (next: boolean) => {
    setOwnStack(next);
    props.onStackChange?.(next);
  };
  const changeAvatar = (next: WalkAvatar) => {
    setOwnAvatar(next);
    props.onAvatar?.(next);
  };
  const changePlaying = (next: boolean) => {
    setOwnPlaying(next);
    props.onPlayingChange?.(next);
  };
  const changeStep = (index: number) => {
    setOwnStep(index);
    props.onJourneyStep?.(index);
  };
  const endpoints = (a: string | null, b: string | null) => {
    changePlaying(false);
    setOwnStep(null);
    setFrom(a);
    setTo(b);
  };
  const frameLocated = () => {
    const points = pending.current,
      m = map.current;
    if (!points?.length || !m) return;
    pending.current = null;
    const ll = points.map(point => toLngLat(point, project.origin));
    m.fitBounds(
      [
        [Math.min(...ll.map(p => p[0])), Math.min(...ll.map(p => p[1]))],
        [Math.max(...ll.map(p => p[0])), Math.max(...ll.map(p => p[1]))],
      ],
      { padding: 80, maxZoom: 20, duration: 450 },
    );
  };
  const locate = (target: StructureTarget) => {
    const ids = new Set(target.objectIds ?? []);
    const objects = project.objects.filter(o => ids.has(o.id));
    const nextFloor =
      target.floorId !== undefined
        ? target.floorId
        : objects.some(o => o.floorId === floorId)
          ? floorId
          : objects.length
            ? objects[0].floorId
            : floorId;
    const onFloor = objects.filter(o => o.floorId === nextFloor || o.servedFloorIds?.includes(nextFloor ?? ''));
    pending.current = target.position ? [target.position] : onFloor.flatMap(o => footprint(o).flat());
    if (!pending.current.length)
      pending.current = project.objects.filter(o => o.floorId === nextFloor).flatMap(o => footprint(o).flat());
    changePlaying(false);
    setFocusId(null);
    select(onFloor[0]?.id ?? null);
    changeMode('2d');
    changeFloor(nextFloor);
    setGraph(false);
    requestAnimationFrame(frameLocated);
  };
  useEffect(() => {
    if (!graph) {
      const frame = requestAnimationFrame(frameLocated);
      return () => cancelAnimationFrame(frame);
    }
  }, [graph, floorId, mode]);
  const openGraph = (floor?: string | null) => {
    const m = map.current;
    if (m)
      camera.current = {
        center: [m.getCenter().lng, m.getCenter().lat],
        zoom: m.getZoom(),
        bearing: m.getBearing(),
        pitch: m.getPitch(),
      };
    changePlaying(false);
    setGraphFloor(floor);
    setGraph(true);
    map.current = null;
  };
  const seek = (index: number) => {
    if (!route) return;
    const i = Math.max(0, Math.min(route.steps.length - 1, index));
    const step = route.steps[i],
      node = route.nodes.find(n => n.id === step.nodeIds.at(-1));
    changePlaying(false);
    changeStep(i);
    if (node) locate({ floorId: node.floorId, position: node.position });
    else changeFloor(step.floorId);
  };
  const togglePanel = (next: Exclude<Panel, null>) => setPanel(current => (current === next ? null : next));
  const floorEntries = [
    { id: 'outdoors', code: 'OUT', name: 'Outdoor site' },
    ...[...project.floors]
      .sort((a, b) => b.elevation - a.elevation)
      .map(f => ({
        id: f.id,
        code: f.code ?? `${f.elevation} m`,
        name: f.name,
        hint: project.buildings.length > 1 ? project.buildings.find(b => b.id === f.buildingId)?.name : undefined,
      })),
  ];
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (
        graph ||
        event.defaultPrevented ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        !root.current?.contains(document.activeElement) ||
        (event.target as HTMLElement).closest('input,textarea,select,[contenteditable=true],[role=dialog]')
      )
        return;
      if (event.key.toLowerCase() === 't') changeMode(mode === '2d' ? '3d' : mode === '3d' ? 'walk' : '2d');
      else if (event.key.toLowerCase() === 'g') togglePanel('navigate');
      else if (event.key.toLowerCase() === 'i') togglePanel('properties');
      else if (event.shiftKey && ['ArrowUp', 'ArrowDown'].includes(event.key)) {
        const floors = [...project.floors].sort((a, b) => a.elevation - b.elevation);
        const i = floors.findIndex(f => f.id === floorId),
          next = floors[i + (event.key === 'ArrowUp' ? 1 : -1)];
        if (next) changeFloor(next.id);
      } else return;
      event.preventDefault();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  });
  const modeLocked =
    (props.viewMode !== undefined || props.threeD !== undefined || props.walk !== undefined) && !props.onViewModeChange;
  return (
    <div
      ref={root}
      className={`kerros-root kerros-surface viewer-workspace ${props.dark ? 'dark' : ''}`}
      tabIndex={-1}
      onPointerDownCapture={event => {
        if (!(event.target as HTMLElement).closest('input,button,select,textarea,canvas')) root.current?.focus();
      }}
    >
      <div className="viewer-toolbar" aria-label="Viewer controls">
        <div className="floor-chip">
          <Layers3 size={16} />
          <FloorSelect
            ariaLabel="Active floor"
            value={floorId ?? 'outdoors'}
            entries={floorEntries}
            onPick={id => {
              changeFloor(id === 'outdoors' ? null : id);
              select(null);
            }}
          />
        </div>
        {!graph && (
          <>
            <div className="view-switch">
              {(['2d', '3d', 'walk'] as const).map(next => (
                <button
                  key={next}
                  disabled={modeLocked}
                  className={mode === next ? 'active' : ''}
                  aria-pressed={mode === next}
                  onClick={() => changeMode(next)}
                >
                  {next === 'walk' ? <Footprints size={14} /> : next === '3d' ? <Box size={14} /> : null}
                  {next === 'walk' ? 'Walk' : next.toUpperCase()}
                </button>
              ))}
            </div>
            {mode === '3d' && (
              <button
                className={`stack-button ${stack ? 'active' : ''}`}
                disabled={props.stack !== undefined && !props.onStackChange}
                aria-pressed={stack}
                onClick={() => changeStack(!stack)}
              >
                <Layers3 size={14} />
                {stack ? 'All floors' : 'Cutaway'}
              </button>
            )}
          </>
        )}
        <div className="viewer-toolbar-actions">
          <details className="viewer-display-options">
            <summary aria-label="View options" title="View options">
              <SlidersHorizontal size={17} />
            </summary>
            <div>
              {(Object.keys(DISPLAY) as (keyof ViewerDisplayOptions)[]).map(name => (
                <label key={name}>
                  <input
                    type="checkbox"
                    checked={display[name]}
                    disabled={
                      (props[name] !== undefined && !props.onDisplayChange) ||
                      (name === 'cityBuildings' && !props.basemap?.vectorSchema?.footprints) ||
                      (name === 'cadastre' && !props.basemap?.vectorSchema?.cadastre)
                    }
                    onChange={event => {
                      const next = { ...display, [name]: event.target.checked };
                      setOwnDisplay(next);
                      props.onDisplayChange?.(next);
                    }}
                  />
                  {DISPLAY_LABELS[name]}
                </label>
              ))}
            </div>
          </details>
          {(
            [
              ['structure', Shapes, 'structure'],
              ['navigate', Waypoints, 'navigation'],
              ['properties', PanelRightOpen, 'properties'],
            ] as const
          ).map(([name, Icon, label]) => (
            <button
              key={name}
              className={`icon-button ${panel === name ? 'active' : ''}`}
              aria-pressed={panel === name}
              aria-label={`${panel === name ? 'Hide' : 'Show'} ${label} panel`}
              title={`${label} panel`}
              onClick={() => togglePanel(name)}
            >
              <Icon size={17} />
            </button>
          ))}
        </div>
      </div>
      <div className="viewer-content">
        <div className="viewer-map">
          {graph ? (
            <>
              <NavigationGraph
                project={project}
                initialFloor={graphFloor}
                dark={props.dark ?? false}
                onLocate={locate}
                onClose={() => setGraph(false)}
              />
            </>
          ) : (
            <FloorViewer
              {...props}
              {...display}
              controls={false}
              floorId={floorId}
              selected={selected}
              focusId={props.focusId !== undefined ? props.focusId : focusId}
              viewMode={mode}
              stack={stack}
              avatar={avatar}
              route={route}
              playing={playing}
              activeStep={activeStep}
              onFloorChange={changeFloor}
              onSelect={id => {
                select(id);
                if (id && !panel) setPanel('properties');
              }}
              onAvatar={changeAvatar}
              onWalkAt={at => {
                changeAvatar(at);
                changeFloor(at.floorId);
                changeMode('walk');
                props.onWalkAt?.(at);
              }}
              onWalkExit={() => {
                changeMode('3d');
                props.onWalkExit?.();
              }}
              onJourneyStep={changeStep}
              onJourneyEnd={() => {
                changePlaying(false);
                props.onJourneyEnd?.();
              }}
              initialCamera={camera.current}
              onReady={m => {
                map.current = m;
                requestAnimationFrame(frameLocated);
                props.onReady?.(m);
              }}
            />
          )}
        </div>
        {panel && (
          <div className="viewer-panel">
            {panel === 'structure' ? (
              <>
                <button
                  className="icon-button viewer-close-panel"
                  aria-label="Close structure panel"
                  onClick={() => setPanel(null)}
                >
                  <X size={16} />
                </button>
                <StructureView
                  project={project}
                  selected={selected}
                  onSelect={select}
                  onFloorChange={changeFloor}
                  onLocate={locate}
                  onGraphView={openGraph}
                />
              </>
            ) : panel === 'navigate' ? (
              <NavigationPanel
                project={project}
                here={avatar}
                from={from}
                to={to}
                route={route}
                playing={playing}
                activeStep={activeStep}
                onFrom={id => endpoints(id, to)}
                onTo={id => endpoints(from, id)}
                onSwap={() => endpoints(to, from)}
                onClear={() => endpoints(null, null)}
                onPlay={() => {
                  setGraph(false);
                  setFocusId(null);
                  heldRoute.current = route;
                  changeStep(0);
                  changePlaying(true);
                }}
                onPause={() => changePlaying(false)}
                onStep={delta => seek((activeStep ?? (delta === 1 ? -1 : 1)) + delta)}
                onSeek={seek}
                onClose={() => {
                  changePlaying(false);
                  setPanel(null);
                }}
              />
            ) : (
              <ReadOnlyInspector
                project={project}
                floorId={floorId}
                selected={selected}
                statuses={statuses}
                monitoring={!!(props.statuses || props.elevators)}
                renderStatusPanel={props.renderStatusPanel}
                onClose={() => setPanel(null)}
                onSelect={focusSelection}
                onFloor={changeFloor}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}
