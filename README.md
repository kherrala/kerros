# Kerros

Kerros is a TypeScript toolkit for indoor mapping applications. It provides a building and floor-plan
model, transactional geometry editing, React editor and viewer components, cross-floor routing, and a
Node.js engine for importing architectural drawings.

The repository includes reference applications with browser persistence and sample buildings. Hosts can
replace storage, basemaps, live-status feeds and import services through typed adapters.

[User guide](docs/guide/getting-started.md) · [API reference](docs/reference/schema.md) ·
[Portable format](docs/reference/portable-format.md) · [Development guide](docs/guide/development.md)

## Modules

| Package | Purpose | Runtime |
| --- | --- | --- |
| [`@kerros/schema`](docs/reference/schema.md) | Document types, geometry, validation, mutations, topology, routing and portable JSON | Browser / Node.js |
| [`@kerros/viewer`](docs/reference/viewer.md) | Read-only React viewer: 2D, 3D, first-person movement, structure, graph view and route playback | Browser |
| [`@kerros/editor`](docs/reference/editor.md) | React authoring interface, CAD entity conversion, SVG output and host adapters | Browser |
| [`@kerros/server`](docs/reference/server.md) | PDF/DWG extraction, OpenCV/OCR, CAD conversion, SVG output and AI import execution | Node.js 22+ |

The React components use MapLibre GL for the map and Three.js for 3D rendering. Their peer dependencies
are `react`, `react-dom`, `maplibre-gl` and `three`; supported versions are declared in the
[viewer](packages/viewer/package.json) and [editor](packages/editor/package.json) manifests.
PDF parsing, native image analysis and the LLM SDK stay in the server module.

## Run the reference applications

With Docker and Docker Compose Watch available, run from the repository root:

```sh
make up
```

This starts the applications, documentation and import backend with source watching. It creates
`.env.local` from `.env.example` if needed. The first build installs the native drawing-analysis tools.

| Application | Local address |
| --- | --- |
| Editor | <http://127.0.0.1:5173/app.html> |
| Viewer | <http://127.0.0.1:5173/viewer.html> |
| Documentation | <http://127.0.0.1:5173/guide/> |

Editing and the bundled Stockmann, Silo and Backrooms examples work without API keys. The reference
applications save projects and drawing assets in IndexedDB. Optional services are configured separately:

| Setting in `.env.local` | Enables |
| --- | --- |
| `VITE_MML_API_KEY` | MML vector maps and cadastral boundaries; this is a public browser credential |
| `ANTHROPIC_API_KEY` | Claude import on the backend; keep this secret and never use a `VITE_` prefix |

See [development setup](docs/guide/development.md) for native Node.js development and container controls,
and [MML maps](docs/guide/mml-maps.md) for map configuration.

## Embed a viewer

The packages are npm workspaces built from this checkout. To build their ESM output and TypeScript
declarations, use Node.js 22+:

```sh
npm ci
npm run build:lib
```

In a React host, serve a portable project as `building.json` and provide a `<div id="root"></div>`.
Import the package stylesheet at the application entry point; it includes MapLibre's styles.

```tsx
import { createRoot } from 'react-dom/client';
import { FloorViewer } from '@kerros/viewer';
import { parseExport } from '@kerros/schema';
import '@kerros/viewer/styles.css';

const response = await fetch('./building.json');
if (!response.ok) throw new Error(`Could not load the project: ${response.status}`);
const { project, assets } = parseExport(await response.text());

createRoot(document.getElementById('root')!).render(
  <div style={{ height: '100dvh' }}>
    <FloorViewer project={project} assets={assets} controls />
  </div>,
);
```

`parseExport` validates the document and supplies an asset repository for embedded reference images.
`controls` enables floor and view selection, structure inspection and navigation. Omit it for a
map-only embed with host-owned controls. Selection, view mode and routes can also be controlled through
props; see the [viewer API](docs/reference/viewer.md) and [reference host](app/viewer.tsx).

For authoring, use `FloorEditor` from `@kerros/editor` and import `@kerros/editor/styles.css`. It takes a
`project` and `PlannerAdapters`, including project and asset repositories. The editor owns its edit
history; observe accepted edits with `onChange`. See the [editor API](docs/reference/editor.md) and
[reference application](app/main.tsx) for persistence, basemap, status and import adapters.
The `/host` entry points expose host utilities without importing the map renderer. Drawing-conversion
and SVG helpers are available through `@kerros/editor/host` as well as the main editor entry point.

## Work with the model

`ProjectDocument` stores local metric geometry relative to a WGS84 origin. Floors share the horizontal
coordinate frame and define their own elevations and heights. The model is a planar subdivision with
vertical dimensions; the viewer generates rendering meshes from it.

Walls and virtual boundaries reference shared junctions. Connected spaces reference ordered boundary
loops, and their usable polygons are derived after accounting for wall thickness. Doors and windows
attach to a barrier by offset and width. Independent space outlines are also supported. Zones group
spaces; portals connect them, and routing uses that connectivity together with vertical transport.

Apply edits through `applyMutation`, `applyMutations` or `transact`. They update a draft, synchronize
connected geometry and validate before returning a replacement document. A refused edit leaves the
input unchanged. For example, this batch creates four walls and their enclosed room atomically:

```ts
import { emptyProject, applyMutations } from '@kerros/schema';

const project = emptyProject([24.938, 60.169], 'Example building');
const floorId = project.floors[0].id;
const result = applyMutations(project, [
  { kind: 'addBarrier', floorId, barrierKind: 'wall', a: [0, 0], b: [8, 0] },
  { kind: 'addBarrier', floorId, barrierKind: 'wall', a: [8, 0], b: [8, 6] },
  { kind: 'addBarrier', floorId, barrierKind: 'wall', a: [8, 6], b: [0, 6] },
  { kind: 'addBarrier', floorId, barrierKind: 'wall', a: [0, 6], b: [0, 0] },
  { kind: 'encloseRoom', floorId, point: [4, 3], name: 'Office' },
]);

if (!result.ok) throw new Error(result.error);
const updatedProject = result.project;
```

`validateProject` checks incoming documents without repairing them. Portal inference is separate from
geometry synchronization; use `refreshPortals` when an integration needs to regenerate inferred
connections. Validation permits incomplete floor plans and independent overlapping areas, so it does
not certify complete room coverage or drawing accuracy.

The [geometry guide](docs/guide/geometry.md) explains boundary ownership and editing constraints.
The [portable format reference](docs/reference/portable-format.md) documents `schemaVersion: 1`,
coordinate conventions, relationships and embedded assets for third-party readers and generators.
[Mathematical foundations](docs/guide/geometry-mathematics.md) links to the academic background.

## Import drawings

Reference images, deterministic CAD conversion and AI-assisted modelling are distinct workflows:

- A reference image is aligned beneath a floor plan for manual tracing. PDF pages are converted on the backend.
- `importPlanEntities` converts extracted CAD entity JSON into walls, spaces and openings. Import it
  from `@kerros/editor` in the browser or `@kerros/server` in Node.js; both use the same implementation.
- `@kerros/server` extracts PDF/DWG geometry and text, or analyses raster drawings with OpenCV, OCR and
  symbol matching. It exposes calibrated JSON/SVG evidence to the AI tool loop.

AI imports apply proposed edits through the same model transactions. The reference backend streams
accepted documents, activity, token usage and continuation checkpoints to the editor; accepted changes
are saved to the live project. Source analysis can run without an LLM. Drawing evidence still needs scale
calibration and review; detection candidates are not automatically valid building geometry.

Use the [import guide](docs/guide/ai-import.md) for the editor workflow and the
[AI engine reference](docs/reference/ai-import.md) for adapters, tools, streaming and CLI integration.
The reference HTTP backend is for local development; a hosted service must provide authentication,
per-user job isolation and usage controls.

## Develop and verify

Run these commands from the repository root after `npm ci`:

| Command | Purpose |
| --- | --- |
| `make dev` | Run the reference applications with Vite |
| `make docs` | Run the documentation server |
| `make check` | Check formatting, types, unit tests and generated AI tool schemas |
| `npm run test:geometry` | Run deterministic geometry regressions and randomized authoring sequences |
| `make e2e` | Run browser tests; install Chromium with `npx playwright install chromium` first |
| `make test-raster` | Run native OpenCV/OCR fixtures in an isolated Docker container |
| `make budget` | Measure package import sizes and check bundle boundaries |
| `make lib` | Build all workspace packages and declarations |
| `make site` | Build the applications and documentation |

Ordinary tests use mocked AI providers and do not spend LLM tokens. Native analysis tests are opt-in.
For model or mutation changes, regenerate the tool definitions with `npm run generate:ai-tools`.
The geometry suite reports failing seeds; use `GEOMETRY_FUZZ_SEED=12 npm run test:geometry` to replay one,
or `GEOMETRY_FUZZ_CASES=1000 npm run test:geometry` for a longer run.

| Source | Responsibility |
| --- | --- |
| `src/model/` | Geometry, validation, transactions, ontology and navigation |
| `src/schema/`, `src/viewer/`, `src/editor/`, `src/server/` | Public package entry points |
| `src/import/` | Internal drawing-conversion helpers and contracts shared by editor and server |
| `src/map/`, `src/components/`, `src/adapters/` | Rendering, shared UI and host integrations |
| `app/` | Reference hosts, sample data and HTTP adapters |
| `server/` | Reference HTTP backend and isolated import worker |
| `packages/` | Package manifests and build configurations |
| `tests/` | Browser integration tests |
| `docs/` | User guides, API references and academic articles |

## License

[MIT](LICENSE).
