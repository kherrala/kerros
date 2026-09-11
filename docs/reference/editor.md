# `@kerros/editor`

The full authoring editor + adapters. Re-exports everything from [`@kerros/viewer`](./viewer) (and thus `@kerros/schema`), plus the deterministic CAD importer from [`@kerros/import`](./import). Peers: `react`, `react-dom`, `maplibre-gl`, `three`.

```ts
import '@kerros/editor/styles.css';
```

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
- `IndexedAssetRepository` — `AssetRepository` over IndexedDB.
- `ProjectRepository`, `AssetRepository`, `StatusFeed` — the interfaces to implement for your own backend.

## Basemap & theming

`neutralBasemap`, `BasemapConfig`; `KerrosThemeProvider`, `useKerrosTheme`, `useDarkMode`, `KerrosTheme`, `MapStyleOptions`, `ConfirmOptions`.

> The editor reads no `import.meta.env` and never mutates the URL — the host supplies the basemap via `adapters.basemap` and persists the view emitted by `onViewChange`.
