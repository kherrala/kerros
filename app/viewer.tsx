// SAMPLE INTEGRATION CODE — a reference viewer host wiring persistence, an env-provided basemap and
// its own chrome (picker, floor sidebar, view switches, selected-object panel) around the FloorViewer
// core. It consumes only @kerros/viewer — no editor dependency; the VITE_MML_API_KEY read belongs here
// in the host, never in library code. A host with live data also passes FloorViewer a `statuses`
// array from its own StatusFeed — deliberately not modelled here, because what a reading
// means is the host's business, not the toolkit's.
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { LiftPanel, useLiftController } from './LiftPanel';
import {
  ArrowLeft,
  ArrowRight,
  Box,
  Building2,
  CircleAlert,
  Footprints,
  Layers3,
  Leaf,
  Moon,
  Sun,
  UploadCloud,
  X,
} from 'lucide-react';
import {
  parseExport,
  KerrosThemeProvider,
  useDarkMode,
  IndexedAssetRepository,
  LocalProjectRepository,
  IndexedProjectRepository,
  type AssetRepository,
  type Barrier,
  type ProjectDocument,
  type ProjectSummary,
  type SiteObject,
  StructureView,
} from '@kerros/viewer/host';
// FloorViewer is the only thing here that draws a plan, and drawing a plan means maplibre and three
// — 1.7 MB that the picker screen has no use for. The `/host` subpath above is the same facade
// minus the renderer, so naming FloorViewer through a dynamic import is what keeps the two apart.
const FloorViewer = lazy(() => import('@kerros/viewer').then(m => ({ default: m.FloorViewer })));
import { mmlBasemap } from './mmlBasemap';
import { cameraPose, parseViewLink, writeViewLink, type ViewLink } from './viewLink';
import 'maplibre-gl/dist/maplibre-gl.css';
import '../src/styles.css';
import './reset.css';

function ViewerShell({
  project,
  assets,
  dark,
  toggleDark,
  onBack,
  view,
}: {
  project: ProjectDocument;
  assets: AssetRepository;
  dark: boolean;
  toggleDark: () => void;
  onBack: () => void;
  view?: ViewLink;
}) {
  const [floorId, setFloorId] = useState<string | null>(
      view?.floor !== undefined && (view.floor === null || project.floors.some(f => f.id === view.floor))
        ? view.floor
        : (project.floors.find(f => f.elevation === 0)?.id ?? project.floors[0]?.id ?? null),
    ),
    [selected, setSelected] = useState<string | null>(null),
    [tab, setTab] = useState<'floors' | 'structure'>('floors');
  // A host's own simulated feed. Real hosts subscribe to a StatusFeed; this one lets you drive the
  // lifts by hand, which is the same data arriving by a different road.
  const liftController = useLiftController(project);
  const [threeD, setThreeD] = useState(view?.threeD ?? true),
    [stack, setStack] = useState(view?.stack ?? false),
    [walk, setWalk] = useState(view?.walk ?? false),
    [error, setError] = useState('');
  const viewMode: 'walk' | '3d' | '2d' = walk ? 'walk' : threeD ? '3d' : '2d';
  const chooseMode = (next: 'walk' | '3d' | '2d') => {
    setWalk(next === 'walk');
    setThreeD(next !== '2d');
    if (next === 'walk') setStack(false);
  };
  // The host keeps the URL fragment in sync with the view (project, floor, mode, camera) so a
  // refresh or a shared link restores exactly what is on screen — a sample deep-link integration.
  const mapRef = useRef<import('maplibre-gl').Map | null>(null);
  const viewRef = useRef({ floorId, threeD, stack, walk });
  viewRef.current = { floorId, threeD, stack, walk };
  // Walking writes a camera every animation frame and each write is a history.replaceState, so while
  // it is on only the mode change itself is published — with the pose you set off from.
  const writeHash = (force = false) => {
    const m = mapRef.current;
    if (!m) return;
    const v = viewRef.current;
    if (v.walk && !force) return;
    writeViewLink({
      project: project.id,
      floor: v.floorId,
      threeD: v.threeD,
      stack: v.stack,
      walk: v.walk,
      camera: cameraPose(m),
    });
  };
  useEffect(() => writeHash(true), [floorId, threeD, stack, walk]); // eslint-disable-line react-hooks/exhaustive-deps
  // Env reads live in the host entrypoint, not in the FloorViewer library.
  const basemap = useMemo(
    () => (import.meta.env.VITE_MML_API_KEY ? mmlBasemap(import.meta.env.VITE_MML_API_KEY) : undefined),
    [],
  );
  const changeFloor = (id: string | null) => {
    setFloorId(id);
    setSelected(null);
  };
  const entity: SiteObject | Barrier | undefined =
    project.objects.find(o => o.id === selected) ?? project.barriers.find(b => b.id === selected);
  return (
    <div className="app-shell">
      <header className="app-header">
        <a
          className="brand"
          href="#"
          onClick={e => {
            e.preventDefault();
            onBack();
          }}
        >
          <span className="brand-mark">
            <Layers3 size={22} strokeWidth={2} />
          </span>
          <strong>kerros</strong>
          <span className="brand-divider" />
          <span className="brand-product">Viewer</span>
        </a>
        <div className="header-right" style={{ marginLeft: 'auto' }}>
          <span className="save-status">
            <span />
            Read-only viewer
          </span>
          <button
            className="icon-button"
            aria-label={dark ? 'Switch to light mode' : 'Switch to dark mode'}
            onClick={toggleDark}
          >
            {dark ? <Sun size={18} /> : <Moon size={18} />}
          </button>
        </div>
      </header>
      <div className="workspace">
        <aside className="sidebar">
          <button className="back-link" onClick={onBack}>
            <ArrowLeft size={14} />
            All projects
          </button>
          <div className="site-card">
            <div className="site-icon">
              <Building2 size={24} />
            </div>
            <div>
              <h1>{project.name}</h1>
              <span>Read-only</span>
            </div>
          </div>
          {(project.zones?.length || project.portals?.length) && (
            <div className="viewer-tabs">
              <button className={tab === 'floors' ? 'active' : ''} onClick={() => setTab('floors')}>
                Levels
              </button>
              <button className={tab === 'structure' ? 'active' : ''} onClick={() => setTab('structure')}>
                Structure
              </button>
            </div>
          )}
          {tab === 'structure' ? (
            <StructureView project={project} selected={selected} onSelect={setSelected} onFloorChange={changeFloor} />
          ) : (
            <div className="sidebar-scroll">
              <div className="section-label">Floors &amp; levels</div>
              <button
                className={`floor-item outdoor ${floorId === null ? 'active' : ''}`}
                onClick={() => changeFloor(null)}
              >
                <Leaf size={17} />
                <span>
                  Outdoor site<small>Perimeters &amp; surroundings</small>
                </span>
              </button>
              {project.buildings.map(building => (
                <div className="building-group" key={building.id}>
                  <div className="building-label">
                    <Building2 size={13} />
                    {building.name}
                    <span className="building-count">
                      {project.floors.filter(f => f.buildingId === building.id).length}
                    </span>
                  </div>
                  {project.floors
                    .filter(f => f.buildingId === building.id)
                    .sort((a, b) => b.elevation - a.elevation)
                    .map(f => (
                      <button
                        key={f.id}
                        className={`floor-item ${floorId === f.id ? 'active' : ''}`}
                        onClick={() => changeFloor(f.id)}
                      >
                        <span className="floor-number">
                          {f.code ??
                            (f.mezzanine
                              ? 'M'
                              : f.elevation < 0
                                ? 'B' +
                                  project.floors.filter(
                                    x =>
                                      x.buildingId === f.buildingId &&
                                      !x.mezzanine &&
                                      x.elevation < 0 &&
                                      x.elevation >= f.elevation,
                                  ).length
                                : String(
                                    project.floors.filter(
                                      x =>
                                        x.buildingId === f.buildingId &&
                                        !x.mezzanine &&
                                        x.elevation >= 0 &&
                                        x.elevation < f.elevation,
                                    ).length,
                                  ).padStart(2, '0'))}
                        </span>
                        <span>
                          {f.name}
                          <small>{f.elevation.toFixed(1)} m elevation</small>
                        </span>
                        {floorId === f.id && <span className="active-floor-dot" />}
                      </button>
                    ))}
                </div>
              ))}
            </div>
          )}
          <div className="sidebar-footer">
            <span className="workspace-avatar">K</span>
            <div>
              <strong>Kerros viewer</strong>
              <small>Sample host app</small>
            </div>
          </div>
        </aside>
        <main className="canvas-column">
          <div className="canvas-body">
            {/* The renderer arriving, not the map preparing a space — same spinner so the two waits
                read as one, but its own class. `.map-loading` is MapCanvas saying it is not ready
                yet, and a test that waits for the map has to be able to tell them apart. */}
            <Suspense
              fallback={
                <div className="renderer-loading">
                  <span className="loading-orbit" />
                </div>
              }
            >
              <FloorViewer
                project={project}
                assets={assets}
                statuses={liftController.statuses}
                basemap={basemap}
                floorId={floorId}
                onFloorChange={setFloorId}
                selected={selected}
                onSelect={setSelected}
                threeD={threeD}
                stack={stack}
                walk={walk}
                onWalkExit={() => chooseMode('3d')}
                dark={dark}
                onError={setError}
                initialCamera={view?.camera}
                onReady={map => {
                  mapRef.current = map;
                  map.on('moveend', () => writeHash());
                  writeHash(true);
                }}
              />
            </Suspense>
            <LiftPanel project={project} controller={liftController} onFloor={setFloorId} />
            <div className="canvas-top-left">
              <div className="view-switch">
                <button className={viewMode === '2d' ? 'active' : ''} onClick={() => chooseMode('2d')}>
                  2D
                </button>
                <button className={viewMode === '3d' ? 'active' : ''} onClick={() => chooseMode('3d')}>
                  <Box size={14} />
                  3D
                </button>
                <button
                  className={viewMode === 'walk' ? 'active' : ''}
                  title="Walk through the building at eye level"
                  onClick={() => chooseMode('walk')}
                >
                  <Footprints size={14} />
                  Walk
                </button>
              </div>
              {threeD && !walk && (
                <button className={`stack-button ${stack ? 'active' : ''}`} onClick={() => setStack(!stack)}>
                  <Layers3 size={15} />
                  {stack ? 'All floors' : 'Cutaway'}
                </button>
              )}
            </div>
          </div>
        </main>
        {entity && (
          <aside className="inspector viewer-object">
            <div className="inspector-top">
              Selected object
              <button className="icon-button" aria-label="Close panel" onClick={() => setSelected(null)}>
                <X size={15} />
              </button>
            </div>
            <div className="inspector-scroll">
              <h2>{entity.name}</h2>
              <p className="object-kind">{entity.kind}</p>
            </div>
          </aside>
        )}
      </div>
      {error && (
        <div className="toast" role="alert">
          <CircleAlert size={18} />
          <span>{error}</span>
          <button aria-label="Dismiss" onClick={() => setError('')}>
            <X size={16} />
          </button>
        </div>
      )}
    </div>
  );
}

function ViewerHome() {
  const [dark, toggleDark] = useDarkMode();
  // Start fetching the renderer while the picker is on screen. Keeping it out of the eager bundle is
  // what stopped it delaying first paint; it is also the only thing anyone does next, so waiting for
  // the click to begin a 1.7 MB download would trade a slow start for a stare. Idle-scheduled, so it
  // queues behind the picker's own work rather than competing with it.
  useEffect(() => {
    const warm = () => void import('@kerros/viewer');
    const idle = (window as unknown as { requestIdleCallback?: (cb: () => void) => number }).requestIdleCallback;
    const handle = idle ? idle(warm) : window.setTimeout(warm, 400);
    return () => {
      const cancel = (window as unknown as { cancelIdleCallback?: (id: number) => void }).cancelIdleCallback;
      if (idle && cancel) cancel(handle);
      else window.clearTimeout(handle);
    };
  }, []);
  const projects = useMemo(() => new IndexedProjectRepository(new LocalProjectRepository()), []),
    storedAssets = useMemo(() => new IndexedAssetRepository(), []);
  const [open, setOpen] = useState<{ project: ProjectDocument; assets: AssetRepository; view?: ViewLink } | null>(null);
  const [saved, setSaved] = useState<ProjectSummary[]>([]),
    [error, setError] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);
  const refresh = () => {
    projects
      .list()
      .then(setSaved)
      .catch(() => setSaved([]));
  };
  useEffect(refresh, [projects]);
  // Deep links use the same #p=…&f=…&v=…&c=… fragment as the editor; the older ?project= query
  // remains accepted for existing bookmarks.
  useEffect(() => {
    const link = parseViewLink();
    const id = link.project ?? new URLSearchParams(location.search).get('project');
    if (id)
      projects
        .load(id)
        .then(p => {
          if (p) setOpen({ project: p, assets: storedAssets, view: link });
        })
        .catch(() => setError('The linked project could not be loaded.'));
  }, [projects, storedAssets]);
  function openSaved(id: string) {
    projects
      .load(id)
      .then(p => {
        if (!p) throw new Error('This project could not be loaded.');
        setOpen({ project: p, assets: storedAssets });
      })
      .catch(e => setError((e as Error).message));
  }
  // parseExport keeps ids and updatedAt intact (display semantics): nothing is written to storage,
  // and no deep link is pushed because a file-opened id would not resolve from this browser on reload.
  function openFile(file: File) {
    file
      .text()
      .then(json => setOpen(parseExport(json)))
      .catch(e => setError((e as Error).message));
  }
  function close() {
    setOpen(null);
    history.replaceState(null, '', location.pathname);
    refresh();
  }
  if (open)
    return (
      <ViewerShell
        project={open.project}
        assets={open.assets}
        dark={dark}
        toggleDark={toggleDark}
        onBack={close}
        view={open.view}
      />
    );
  return (
    <div className="home">
      <header className="home-header">
        <span className="brand">
          <span className="brand-mark">
            <Layers3 size={22} strokeWidth={2} />
          </span>
          <strong>kerros</strong>
          <span className="brand-divider" />
          <span className="brand-product">Viewer</span>
        </span>
        <button
          className="icon-button"
          aria-label={dark ? 'Switch to light mode' : 'Switch to dark mode'}
          onClick={toggleDark}
        >
          {dark ? <Sun size={18} /> : <Moon size={18} />}
        </button>
      </header>
      <main className="home-main">
        <section className="home-hero">
          <span className="eyebrow">FLOOR PLAN VIEWER</span>
          <h1>Read your model.</h1>
          <p>
            Open a project saved by the Kerros editor in this browser, or a portable Kerros export, and browse its
            floors in 2D and 3D — no editing tools attached.
          </p>
        </section>
        <div className="home-grid">
          <button className="home-card ghost" onClick={() => fileInput.current?.click()}>
            <span className="home-card-icon plain">
              <UploadCloud size={26} />
            </span>
            <strong>Open a project file</strong>
            <p>
              View a portable Kerros JSON export, including its embedded reference drawings. Nothing is saved to this
              browser.
            </p>
            <span className="home-card-footer">
              <span className="home-open">
                Browse
                <ArrowRight size={15} />
              </span>
            </span>
          </button>
        </div>
        <input
          ref={fileInput}
          type="file"
          hidden
          accept=".json"
          onChange={e => {
            const file = e.target.files?.[0];
            if (file) openFile(file);
            e.target.value = '';
          }}
        />
        {saved.length > 0 && (
          <section className="home-saved">
            <h2>Saved in this browser</h2>
            {saved.map(p => (
              <div className="home-row" key={p.id}>
                <button className="home-row-main" onClick={() => openSaved(p.id)}>
                  <span className="home-row-icon">
                    <Building2 size={18} />
                  </span>
                  <span>
                    {p.name}
                    <small>
                      Edited {new Date(p.updatedAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}
                    </small>
                  </span>
                </button>
                <span className="home-tag">Read-only</span>
              </div>
            ))}
          </section>
        )}
        <p className="home-footnote">
          This viewer shares the editor&apos;s browser-persisted projects. Use the Kerros editor to create or change
          them.
        </p>
      </main>
      {error && (
        <div className="toast" role="alert">
          <CircleAlert size={18} />
          <span>{error}</span>
          <button aria-label="Dismiss" onClick={() => setError('')}>
            <X size={16} />
          </button>
        </div>
      )}
    </div>
  );
}

// Trackpad pinches arrive as ctrl+wheel (and Safari gesture events); stop them from zooming the
// whole page when they land on panels or overlay symbols instead of the map canvas.
document.addEventListener(
  'wheel',
  e => {
    if (e.ctrlKey) e.preventDefault();
  },
  { passive: false },
);
for (const type of ['gesturestart', 'gesturechange', 'gestureend'])
  document.addEventListener(type, e => e.preventDefault());

createRoot(document.getElementById('root')!).render(
  <KerrosThemeProvider>
    <ViewerHome />
  </KerrosThemeProvider>,
);
