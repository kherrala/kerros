# `@kerros/editor`

The authoring editor, host adapters and browser-safe drawing helpers. Re-exports [`@kerros/schema`](./schema) and the [CAD conversion and SVG API](./import). Peers: `react`, `react-dom`, `maplibre-gl`, `three`. The standalone read-only viewer is available in [`@kerros/viewer`](./viewer).

```ts
import '@kerros/editor/styles.css';
```

## Entry points

| Import | What it is |
| --- | --- |
| `@kerros/editor` | The whole facade, `FloorEditor` and `SiteViewer` included. |
| `@kerros/editor/host` | The same facade minus the two components that draw a plan: persistence, theming, `StructureView`, the schema and drawing-conversion helpers. |
| `@kerros/editor/styles.css` | The stylesheet (MapLibre's, then Kerros'). |

Drawing a plan means `maplibre-gl` and `three` — about 1.7 MB that a screen listing saved projects
has no use for. The package is published one file per module, so a bundler follows only what you
actually name: importing `KerrosThemeProvider` from either entry point costs the same, and neither
pulls the renderer.

```tsx
import { KerrosThemeProvider, useDarkMode, IndexedProjectRepository } from '@kerros/editor';
const FloorEditor = lazy(() => import('@kerros/editor').then(m => ({ default: m.FloorEditor })));
```

`make budget` checks the built packages as a consumer would import them. Host utilities and CAD
conversion helpers must not pull in MapLibre, Three.js or PDF.js. The map renderer loads MapLibre;
Three.js arrives only when a 3D view is opened. PDF conversion and native analysis are server-side
operations exposed through host adapters.

The `lazy()` is still yours to write — tree-shaking decides what is in the bundle, not when it
arrives, and mounting the editor is what makes the renderer worth fetching.

`/host` exports the same names minus the two components that draw a plan. It is now a statement
rather than a workaround: import from it and the renderer *cannot* end up in that module's graph, by
construction, whatever a future refactor does to the barrel. Reach for it when you want that
guaranteed — a shared module a hundred screens import, say — and use the main entry otherwise.

## Components

- **`FloorEditor`** — the authoring editor. See [The editor](../guide/editor). Its sidebar includes the
  structure panel (`StructureView`, shared with `@kerros/viewer`): zones, their spaces, and each
  zone's derived ways in — plus zone authoring and portal re-reading in edit mode.
- **`SiteViewer`** — the same component in read-only mode.

## Host integration

| Export | Description |
| --- | --- |
| `SitePlannerProps` | The editor's props: `project`, `adapters`, `initialView`, `onViewChange`, `onModeChange`, `renderStatusPanel`, `elevators`, `onChange`, `onSelectionChange`, `onBack`. |
| `PlannerAdapters` | Required `projects` and `assets`; optional `status`, `basemap`, `importProjections`, `aiImport` and `pdfDrawing`. |
| `PlannerMode` | `'view' \| 'edit' \| 'live'`. |
| `ElevatorControls` | Optional `{ statuses, call(feedId, floorId), hold(feedId, open) }` for passenger controls in Walk. The host owns arrival and door sequencing. |
| `StatusPanelContext` | `{ object, status?, editing, live }` — passed to `renderStatusPanel`. |
| `Tool` | The editor's tool union. |

## Adapters

- `LocalProjectRepository` — `ProjectRepository` over `localStorage`.
- `IndexedProjectRepository(previous?)` — `ProjectRepository` over IndexedDB for large documents;
  optionally reads existing saves from another repository. New IndexedDB saves take precedence.
- `IndexedAssetRepository` — `AssetRepository` over IndexedDB.
- `ProjectRepository`, `AssetRepository`, `StatusFeed` — the interfaces to implement for your own backend.

## Basemap & theming

`neutralBasemap`, `BasemapConfig`; `KerrosThemeProvider`, `useKerrosTheme`, `useDarkMode`, `KerrosTheme`, `MapStyleOptions`, `ConfirmOptions`.

> The editor reads no `import.meta.env` and never mutates the URL — the host supplies the basemap via `adapters.basemap` and persists the view emitted by `onViewChange`.

## Drawing conversion

`importPlanEntities`, `detectLayers`, `VERTEX_LAYERS`, `layerPattern`, `LAYER_ROLES`, `documentSvg`,
`landmarks`, `sheetOffset`, `shiftEntities` and their types are exported from both `@kerros/editor`
and `@kerros/editor/host`. See [CAD conversion and SVG](./import) for contracts and supported drawings.
The same helpers are available to Node.js consumers through `@kerros/server`.
