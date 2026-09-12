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

Drawing a plan means `maplibre-gl` and `three`, and `maplibre-gl` ships as a side-effectful bundle
that no tree-shake will take back out once it is in the module graph — so a screen that only lists
saved projects pays about 1.7 MB for a renderer it never mounts. Take what that screen needs from
`/host` and name the editor itself through a dynamic import, and the renderer is fetched when a
project is actually opened:

```tsx
import { KerrosThemeProvider, useDarkMode, IndexedProjectRepository } from '@kerros/editor/host';
const FloorEditor = lazy(() => import('@kerros/editor').then(m => ({ default: m.FloorEditor })));
```

Both entry points export the same names where they overlap, so nothing breaks by importing from
either one; the split exists only so that a host can choose when the renderer arrives.

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
