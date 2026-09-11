# Kerros

A React + Vite + MapLibre toolkit for modelling and visualizing premises of any kind: draw walls,
rooms, zones, doors, openings and POIs over real map geometry, stack them into floors and buildings,
route between them, and read the whole thing back as a portable, validated document. What you build
on that model is up to you — the library ships no application of its own.

## Getting started

```sh
npm install
npm run dev        # http://127.0.0.1:5173
npm test           # Vitest unit tests (model layer)
npm run build      # type-check + production bundle
```

Open one of the demo workspaces (Stockmann Helsinki — a real eight-floor department store, or
The Silo — a fictional hundred-level shaft), create a blank site, or import a portable project
JSON. Projects autosave to `localStorage`; reference drawings live in IndexedDB.

### MML basemap

Copy `.env.example` to `.env.local` and set `VITE_MML_API_KEY` to a Maanmittauslaitos API key
to enable the *MML · Finnish land survey* vector basemap in map settings. Without a key the app
uses a self-contained offline plan background. The key ships in the client bundle, so use a
browser-restricted public key.

## Feature overview

- **Editor** — connected walls and fences (shared junctions; new segments split existing ones),
  rooms/zones with polygon holes and parent/child nesting, rectangle tool, measuring, metric
  0.5 m grid + endpoint/segment/orthogonal snapping, undo/redo, keyboard shortcuts (see the
  in-app help), vertex/endpoint drag editing.
- **Attached openings** — doors and windows attach to walls, gates to fences, positioned by
  offset along the segment; they follow barrier edits and reject invalid placements.
- **Imports** — GeoJSON building/parcel footprints (lng/lat, or any CRS via a host-supplied
  converter), PNG/JPEG/WebP/PDF reference drawings aligned by two point pairs or a known distance,
  and portable project JSON.
  A building footprint can generate floor walls via *Create floor walls*.
- **Floors** — elevations and heights per floor (basements, roof terraces), floor duplication
  with fresh IDs and cleared feed bindings, multiple buildings plus an outdoor site level.
- **3D viewer** — Three.js custom layer sharing the MapLibre camera; single-floor cutaway or a
  full building stack with real elevations, wall openings, and elevated markers.
- **Live status (bring your own)** — objects carry a host-owned `feedId`; a host that supplies a
  `StatusFeed` gets a monitoring surface that overlays whatever state it publishes, with staleness
  handling and per-floor rollups. Transient status never enters undo history or saves, and a host
  that supplies no feed gets no monitoring chrome at all. The reference app supplies none: what a
  a reading *means* is an application's business, not the toolkit's.

## Architecture

The **library** lives in `src/` and the **reference application** in `app/` — separate source
roots. `app/` consumes the library only by `@kerros/*` package name (dev/build alias → the `src/`
facades; the published packages resolve to npm), so it exercises the same contract a third-party host
would.

```
src/model/       Pure domain: types, metric geometry, validation, history, factories, imports
src/adapters/    Integration seams: persistence, status interpretation, neutral basemap
src/map/         MapLibre rendering: 2D features, Three.js 3D SceneLayer, MapCanvas
src/components/  Inspector, import/alignment dialogs, shared controls
src/schema/      Public facade: data schema types + pure document functions
src/viewer/      Public facade: FloorViewer (minimal read-only embed) + browser persistence
src/editor/      Public facade: FloorEditor (= SitePlanner) + bundled adapters
src/SitePlanner.tsx  The embeddable editor (SiteViewer = read-only wrapper)

app/main.tsx     Reference editor app — home shell wiring local adapters to the planner
app/viewer.tsx   Reference viewer app — a read-only host around FloorViewer (@kerros/viewer only)
app/demo/        Built-in sample data (Stockmann, the Silo) and its derived ontology
app/mmlBasemap.ts  Reference MML (Finnish land survey) BasemapConfig — region-specific, not shipped
```

Geometry is stored in **local metric coordinates** (metres) relative to a WGS84 lng/lat project
origin, via an ellipsoidal local-tangent-plane — no projection library, works anywhere — and
converted to lng/lat only at the map boundary. Wall junctions and segments are the authoritative
geometry; wall surfaces and openings are derived at render time.

### Facades & layering

```
schema  ←  viewer  ←  reference viewer app (app/viewer.tsx)
schema  ←  editor  ←  reference editor app (app/main.tsx)
```

| Facade | Exports | Becomes (after npm extraction) |
|---|---|---|
| `src/schema` | `ProjectDocument` + entity types, `validateProject`, `exportProject`, `importProject`, `parseExport`, `blobDataUrl` — no React, no MapLibre, no browser storage | `kerros/schema` |
| `src/viewer` | `FloorViewer` + `FloorViewerProps`, `neutralBasemap`, `StatusFeed`, `statusTone` / `statusLabel` / `unknownStatus`, browser persistence, theme provider, plus everything from `schema` | `kerros/viewer` |
| `src/editor` | `FloorEditor` (= `SitePlanner`), `SiteViewer`, the adapter contracts and bundled implementations, plus everything from `schema` | `kerros/editor` |

The deployed site serves the documentation at `/`, the full reference editor at `/app.html`, and a
sample viewer host at `/viewer.html`. The editor and viewer share the browser-persisted data —
projects saved in the editor appear in the viewer's picker.

A host embeds the viewer like this (shown with post-extraction package paths; the working
in-repo equivalent is `app/viewer.tsx`):

```tsx
import { createRoot } from 'react-dom/client';
import { FloorViewer } from 'kerros/viewer';
import { parseExport } from 'kerros/schema';
import 'kerros/styles.css';

const { project, assets } = parseExport(await (await fetch('/site.json')).text());
createRoot(document.getElementById('plan')!).render(
  <FloorViewer project={project} assets={assets} statuses={liveStatuses}
    threeD dark={prefersDark} onSelect={id => showDetails(id)} />
);
```

**Styling contract:** components never import stylesheets; hosts import `src/styles.css`
(future `kerros/styles.css`) at their entrypoint. The one exception is MapLibre's own CSS,
which arrives via `MapCanvas`'s `maplibre-gl/dist/maplibre-gl.css` import — a documented
bundler assumption. Env reads (`VITE_MML_API_KEY`) belong in entrypoints, never in library
code. See [docs/reference/schema.md](docs/reference/schema.md) for the schema reference.

### Embedding & adapter contracts

`SitePlanner` / `SiteViewer` are host-agnostic components (`src/model/types.ts`):

```ts
interface PlannerAdapters {
  projects: ProjectRepository;  // list / load / save / delete ProjectDocuments
  assets: AssetRepository;      // get / put / delete drawing Blobs by id
  status?: StatusFeed;          // subscribe(project, listener) => unsubscribe; omit → no live view
  basemap?: BasemapConfig;      // MapLibre style + optional transformRequest
}
```

The bundled implementations are `LocalProjectRepository` (localStorage) and
`IndexedAssetRepository` (IndexedDB); a host application replaces them with server-backed ones,
supplies its own `StatusFeed` if it has live data to show, and passes its own MapLibre style
(e.g. an MML vector style with custom themes) via `basemap`.

### Portable project format

`Export project` produces a versioned `ProjectDocument` JSON (schemaVersion 1) with all
geometry plus `embeddedAssets`, a map of asset id → data-URL for reference drawings. Imports
are fully validated (schema, geometry, cross-references, relationship rules) before they
replace anything; a failed import never touches the open project.
