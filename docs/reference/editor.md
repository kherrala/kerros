# `@kerros/editor`

The full authoring editor + adapters. Re-exports everything from [`@kerros/viewer`](./viewer) (and thus `@kerros/schema`), plus the deterministic CAD importer from [`@kerros/import`](./import). Peers: `react`, `react-dom`, `maplibre-gl`, `three`.

```ts
import '@kerros/editor/styles.css';
```

## Entry points

| Import | What it is |
| --- | --- |
| `@kerros/editor` | The whole facade, `FloorEditor` and `SiteViewer` included. |
| `@kerros/editor/host` | The same facade minus the two components that draw a plan: persistence, theming, `StructureView`, the schema. |
| `@kerros/editor/styles.css` | The stylesheet (MapLibre's, then Kerros'). |

Drawing a plan means `maplibre-gl` and `three` — about 1.7 MB that a screen listing saved projects
has no use for. The package is published one file per module, so a bundler follows only what you
actually name: importing `KerrosThemeProvider` from either entry point costs the same, and neither
pulls the renderer.

```tsx
import { KerrosThemeProvider, useDarkMode, IndexedProjectRepository } from '@kerros/editor';
const FloorEditor = lazy(() => import('@kerros/editor').then(m => ({ default: m.FloorEditor })));
```

That measures at 98 kB for the light names against 4.5 MB for `FloorEditor`, from the same barrel.
The `lazy()` is still yours to write — tree-shaking decides what is in the bundle, not when it
arrives, and mounting the editor is what makes the renderer worth fetching.

`/host` exports the same names minus the two components that draw a plan. It is now a statement
rather than a workaround: import from it and the renderer *cannot* end up in that module's graph, by
construction, whatever a future refactor does to the barrel. Reach for it when you want that
guaranteed — a shared module a hundred screens import, say — and use the main entry otherwise.

## Components

- **`FloorEditor`** — the authoring editor. See [The editor](../guide/editor). Its sidebar includes the
  structure panel (`StructureView`, re-exported from `@kerros/viewer`): zones, their spaces, and each
  zone's derived ways in — plus zone authoring and portal re-reading in edit mode.
- **`SiteViewer`** — the same component in read-only mode.

## Host integration

| Export | Description |
| --- | --- |
| `SitePlannerProps` | The editor's props: `project`, `adapters`, `initialView`, `onViewChange`, `onModeChange`, `renderStatusPanel`, `onChange`, `onSelectionChange`, `onBack`. |
| `PlannerAdapters` | `{ projects, assets, status, basemap? }`. |
| `PlannerMode` | `'view' \| 'edit' \| 'live'`. |
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
