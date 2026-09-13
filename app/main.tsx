import { lazy, Suspense, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { createRoot } from 'react-dom/client';
import {
  ArrowRight,
  Building2,
  CircleAlert,
  Copy,
  Eye,
  Layers3,
  Moon,
  Plus,
  Sun,
  Trash2,
  UploadCloud,
  X,
} from 'lucide-react';
import { copyProject, type ProjectDocument, type ProjectSummary } from '@kerros/schema';
import {
  KerrosThemeProvider,
  useDarkMode,
  importProject,
  IndexedAssetRepository,
  LocalProjectRepository,
  IndexedProjectRepository,
  type PlannerAdapters,
  type SitePlannerProps,
} from '@kerros/editor/host';
import type { BackroomsOptions } from './demo/backrooms';
import { BACKROOMS_ID, currentDemoId, DEMO_IDS, SILO_ID, STOCKMANN_ID } from './demo/ids';
import { BackroomsCard } from './BackroomsCard';
import { useLiftController } from './LiftPanel';
// The generators are dynamic: between them they build several thousand objects' worth of code, and
// the page they would sit in mostly shows a picker. `newProject` is the one thing the picker itself
// needs, so it keeps its own tiny module.
import { newProject } from './demo/blank';
import { mmlBasemap } from './mmlBasemap';
import type { ImportProjection } from '@kerros/editor/host';
import { clearViewLink, parseViewLink, writeViewLink, type ViewLink } from './viewLink';
import { en } from './strings';
import 'maplibre-gl/dist/maplibre-gl.css';
import '../src/styles.css';
import './reset.css';

// Nothing on the home screen draws a plan, and the two surfaces that do drag maplibre and three in
// behind them — 1.7 MB the picker has no use for. The `/host` subpath above is the same facade minus
// the renderer, so naming these two through a dynamic import is what keeps the two halves apart: the
// renderer is fetched while the chosen project is being read out of storage.
const SitePlanner = lazy(() => import('@kerros/editor').then(m => ({ default: m.FloorEditor })));
const SiteViewer = lazy(() => import('@kerros/editor').then(m => ({ default: m.SiteViewer })));

const DEMOS = [
  {
    icon: Building2,
    title: 'Stockmann Helsinki',
    text: 'The real Stockmann department store, traced from its MML footprint: eight retail floors around a glass-roofed atrium, an escalator spine and enclosed lift and stair cores.',
  },
] as const;

/** Load only the requested sample, and only when storage did not supply it. Deep links used to
 * regenerate the department store, hundred-floor silo and Backrooms even for a saved user plan. */
async function builtIn(id: string | null) {
  if (id === STOCKMANN_ID) return (await import('./demo/demo')).createDemo();
  if (id === SILO_ID) return (await import('./demo/silo')).createSilo();
  if (id === BACKROOMS_ID) return (await import('./demo/backrooms')).createBackrooms();
  return null;
}

function PlanningSession({ readOnly, ...props }: SitePlannerProps & { readOnly: boolean }) {
  const [project, setProject] = useState(props.project);
  const activeProjectId = useRef(project.id);
  const controller = useLiftController(project);
  const elevators = useMemo(
    () => ({ statuses: controller.statuses, call: controller.call, hold: controller.hold }),
    [controller.statuses, controller.call, controller.hold],
  );
  const Surface = readOnly ? SiteViewer : SitePlanner;
  return (
    <Surface
      {...props}
      elevators={elevators}
      onViewChange={view => writeViewLink({ ...view, project: activeProjectId.current })}
      onChange={p => {
        // JSON import changes the editor's document identity within this session. Every later
        // view link and reload must follow that imported document, not the original blank site.
        if (activeProjectId.current !== p.id) {
          activeProjectId.current = p.id;
          writeViewLink({ ...parseViewLink(), project: p.id });
        }
        setProject(p);
        props.onChange?.(p);
      }}
    />
  );
}

function Home() {
  const [dark, toggleDark] = useDarkMode();
  // Start fetching the renderer while the picker is on screen. Keeping it out of the eager bundle is
  // what stopped it delaying first paint; it is also the only thing anyone does next, so waiting for
  // the click to begin a 1.7 MB download would trade a slow start for a stare. Idle-scheduled, so it
  // queues behind the picker's own work rather than competing with it.
  useEffect(() => {
    const warm = () => void import('@kerros/editor');
    const idle = (window as unknown as { requestIdleCallback?: (cb: () => void) => number }).requestIdleCallback;
    const handle = idle ? idle(warm) : window.setTimeout(warm, 400);
    return () => {
      const cancel = (window as unknown as { cancelIdleCallback?: (id: number) => void }).cancelIdleCallback;
      if (idle && cancel) cancel(handle);
      else window.clearTimeout(handle);
    };
  }, []);
  // No `status` adapter here: this reference app models premises, it does not monitor them. A host
  // with live data supplies its own StatusFeed implementation (see the viewer/editor reference docs).
  // The MML basemap (and its API key) are the host's concern: the env read lives here, not in the library editor.
  // proj4 and its projection table are 130 kB, and the only thing that asks for them is the CRS
  // picker in the footprint-import dialog — which lives inside the editor, behind opening a project.
  // Fetched when one is opened rather than before the picker has drawn, which is the same reason the
  // renderer is lazy: the home screen has no use for either.
  const [projections, setProjections] = useState<ImportProjection[]>();
  const repositories = useMemo(
    () => ({
      projects: new IndexedProjectRepository(new LocalProjectRepository()),
      assets: new IndexedAssetRepository(),
      basemap: import.meta.env.VITE_MML_API_KEY ? mmlBasemap(import.meta.env.VITE_MML_API_KEY) : undefined,
    }),
    [],
  );
  const adapters = useMemo<PlannerAdapters>(
    () => ({ ...repositories, importProjections: projections }),
    [repositories, projections],
  );
  const [open, setOpen] = useState<{
    project: ProjectDocument;
    readOnly: boolean;
    view?: ViewLink & { mode?: 'view' | 'edit' | 'live' };
  } | null>(null);
  useEffect(() => {
    if (!open || projections) return;
    void import('./importProjections').then(m => setProjections(m.importProjections));
  }, [open, projections]);
  const [saved, setSaved] = useState<ProjectSummary[]>([]);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [error, setError] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);
  const refresh = () => {
    adapters.projects
      .list()
      .then(setSaved)
      .catch(() => setSaved([]));
  };
  // Demo generators evolve (and change ids): stale saved demo copies would otherwise shadow the
  // new content via deep links and the picker forever. Purge outdated demo saves on startup.
  useEffect(() => {
    (async () => {
      const current = new Set(DEMO_IDS);
      for (const summary of await adapters.projects.list().catch(() => []))
        if (summary.id.startsWith('demo-') && !current.has(summary.id))
          await adapters.projects.delete(summary.id).catch(() => {});
      refresh();
    })();
  }, [adapters.projects]);
  // Deep links (#p=<id>&f=…&v=…&c=…) reopen a project straight into the exact linked view. Saved
  // copies win; the built-in demo generators answer for their fixed ids on a fresh browser.
  useEffect(() => {
    const link = parseViewLink();
    if (!link.project) return;
    (async () => {
      const saved = await adapters.projects.load(link.project!).catch(() => null);
      const wanted = link.project!;
      // A saved demo copy counts only when its id matches the CURRENT generation — an old id in
      // the hash must never resurrect a stale save (the startup purge may not have run yet).
      const current = currentDemoId(wanted);
      const staleDemo = current !== null && current !== wanted;
      const demo = (staleDemo ? undefined : saved) ?? (await builtIn(current));
      if (demo) setOpen({ project: demo, readOnly: false, view: link });
      else setError('The linked project is not available in this browser.');
    })();
  }, [adapters.projects]);
  // Reopening a demo resumes its saved copy so edits survive the trip back home.
  async function openDemo(readOnly = false) {
    const demo = (await import('./demo/demo')).createDemo();
    const existing = await adapters.projects.load(demo.id).catch(() => null);
    setOpen({ project: existing ?? demo, readOnly });
  }
  async function openSilo() {
    const demo = (await import('./demo/silo')).createSilo();
    const existing = await adapters.projects.load(demo.id).catch(() => null);
    setOpen({ project: existing ?? demo, readOnly: false });
  }
  async function openBackrooms(options: BackroomsOptions) {
    try {
      const demo = (await import('./demo/backrooms')).createBackrooms(options);
      const existing = await adapters.projects.load(demo.id).catch(() => null);
      setOpen({
        project: existing ?? demo,
        readOnly: false,
        // The Backrooms is the one sample whose whole point is being inside it — endless yellow rooms
        // read as a floor plan from above and as somewhere you are lost from eye level. It opens in
        // walk mode for the same reason a maze is not sold as a map of itself.
        // And on the plain ground: the rooms are nowhere, and the city they would otherwise be
        // drawn over is the most expensive thing in a frame nothing of it appears in.
        view: { floor: demo.initialFloorId, threeD: true, stack: false, walk: true, basemap: 'plan' },
      });
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function openSaved(id: string, readOnly = false) {
    try {
      const project = await adapters.projects.load(id);
      if (!project) throw new Error('This project could not be loaded.');
      setOpen({ project, readOnly });
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function openFile(file: File) {
    try {
      // Straight into the editor: you imported it to work on it, not to look at it.
      setOpen({
        project: await importProject(await file.text(), adapters.assets),
        readOnly: false,
        view: { mode: 'edit' },
      });
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function duplicate(id: string) {
    try {
      const source = await adapters.projects.load(id);
      if (!source) throw new Error('This project could not be loaded.');
      const project = copyProject(source);
      await adapters.projects.save(project);
      setOpen({ project, readOnly: false });
    } catch (e) {
      setError((e as Error).message);
    }
  }
  // Drop a project file anywhere on the home screen. Nothing here knows about CAD plans — those
  // land on a floor, so they belong to the editor's import dialog, which has its own dropzone.
  const [dragging, setDragging] = useState(false);
  const dropProps = {
    onDragOver: (e: DragEvent) => {
      if (!e.dataTransfer.types.includes('Files')) return;
      e.preventDefault();
      setDragging(true);
    },
    onDragLeave: (e: DragEvent) => {
      // Only when the pointer leaves the shell, not on every child it crosses on the way.
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
    },
    onDrop: (e: DragEvent) => {
      e.preventDefault();
      setDragging(false);
      const file = e.dataTransfer.files[0];
      if (!file) return;
      if (!file.name.toLowerCase().endsWith('.json')) return setError('Drop a Kerros project JSON.');
      void openFile(file);
    },
  };
  const back = () => {
    clearViewLink();
    setOpen(null);
    refresh();
  };
  // The host owns the URL: mirror the editor's view into a deep-link fragment as it changes.
  if (open) {
    const hostProps = {
      adapters,
      initialView: open.view,
      onBack: back,
    } as const;
    return (
      // The renderer arriving, not the map preparing a space — same spinner so the two waits read as
      // one, but its own class. `.map-loading` is MapCanvas saying it is not ready yet, and a test
      // that waits for the map has to be able to tell them apart.
      <Suspense
        fallback={
          <div className="renderer-loading">
            <span className="loading-orbit" />
          </div>
        }
      >
        <PlanningSession key={open.project.id} project={open.project} readOnly={open.readOnly} {...hostProps} />
      </Suspense>
    );
  }
  return (
    <div className={`home ${dragging ? 'dropping' : ''}`} {...dropProps}>
      <header className="home-header">
        <span className="brand">
          <span className="brand-mark">
            <Layers3 size={22} strokeWidth={2} />
          </span>
          <strong>{en.brand}</strong>
          <span className="brand-divider" />
          <span className="brand-product">{en.app}</span>
        </span>
        <span style={{ display: 'inline-flex', gap: 10, alignItems: 'center' }}>
          <button
            className="icon-button"
            aria-label={dark ? 'Switch to light mode' : 'Switch to dark mode'}
            onClick={toggleDark}
          >
            {dark ? <Sun size={18} /> : <Moon size={18} />}
          </button>
          <span className="avatar">KH</span>
        </span>
      </header>
      <main className="home-main">
        <section className="home-hero">
          <span className="eyebrow">FLOOR &amp; SITE PLANNER</span>
          <h1>
            Model your premises.
            <br />
            In 2D and 3D.
          </h1>
          <p>
            Draw multi-floor buildings over real map geometry, author their spaces, openings and routes, and read the
            result back as a portable document — what you do with it is up to you.
          </p>
        </section>
        <div className="home-grid">
          <BackroomsCard onOpen={openBackrooms} />
          <button className="home-card demo" onClick={() => void openSilo()}>
            <span className="home-card-icon">
              <Layers3 size={26} />
            </span>
            <strong>The Silo · Hakaniemi</strong>
            <p>
              A fictional hundred-level underground silo beneath Ympyrätalo — a great spiral staircase in the shaft,
              landing bridges and ring rooms all the way down.
            </p>
            <span className="home-card-footer">
              <span className="home-open">
                Open
                <ArrowRight size={15} />
              </span>
            </span>
          </button>
          {DEMOS.map(demo => (
            <button key={demo.title} className="home-card demo" onClick={() => void openDemo()}>
              <span className="home-card-icon">
                <demo.icon size={26} />
              </span>
              <strong>{demo.title}</strong>
              <p>{demo.text}</p>
              <span className="home-card-footer">
                <span className="home-open">
                  Open
                  <ArrowRight size={15} />
                </span>
              </span>
            </button>
          ))}
          <button
            className="home-card ghost"
            onClick={() => setOpen({ project: newProject(), readOnly: false, view: { mode: 'edit' } })}
          >
            <span className="home-card-icon plain">
              <Plus size={26} />
            </span>
            <strong>New blank site</strong>
            <p>Start from an empty parcel in Helsinki and import your own footprints and drawings.</p>
            <span className="home-card-footer">
              <span className="home-open">
                Create
                <ArrowRight size={15} />
              </span>
            </span>
          </button>
          <button className="home-card ghost" onClick={() => fileInput.current?.click()}>
            <span className="home-card-icon plain">
              <UploadCloud size={26} />
            </span>
            <strong>Open a project file</strong>
            <p>Import a portable Kerros JSON export, including its embedded reference drawings.</p>
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
            if (file) void openFile(file);
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
                <button
                  className="button secondary small"
                  title="Open without editing tools"
                  onClick={() => openSaved(p.id, true)}
                >
                  <Eye size={14} />
                  View
                </button>
                <button
                  className="icon-button"
                  aria-label={`Duplicate ${p.name}`}
                  title="Duplicate project with cleared feed bindings"
                  onClick={() => duplicate(p.id)}
                >
                  <Copy size={16} />
                </button>
                {confirmDelete === p.id ? (
                  <button
                    className="button danger small"
                    onClick={() => {
                      adapters.projects
                        .delete(p.id)
                        .then(refresh)
                        .catch(() => setError('Could not delete the project.'));
                      setConfirmDelete(null);
                    }}
                  >
                    Really delete?
                  </button>
                ) : (
                  <button
                    className="icon-button"
                    aria-label={`Delete ${p.name}`}
                    title="Delete project"
                    onClick={() => setConfirmDelete(p.id)}
                  >
                    <Trash2 size={16} />
                  </button>
                )}
              </div>
            ))}
          </section>
        )}
        <p className="home-footnote">
          Drop a project file anywhere on this page to open it. Projects save automatically in this browser; use Export
          inside the editor for a portable backup.
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
    <Home />
  </KerrosThemeProvider>,
);
