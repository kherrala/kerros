# `@kerros/viewer`

Read-only floor viewer + the live-status contract. Re-exports everything from [`@kerros/schema`](./schema). Peers: `react`, `react-dom`, `maplibre-gl`, `three`.

```ts
import '@kerros/viewer/styles.css';
```

## Entry points

| Import | What it is |
| --- | --- |
| `@kerros/viewer` | The whole facade, `FloorViewer` included. |
| `@kerros/viewer/host` | The same facade minus `FloorViewer`: persistence, theming, status helpers, `StructureView`, the schema. |
| `@kerros/viewer/styles.css` | The stylesheet (MapLibre's, then Kerros'). |

`FloorViewer` reaches `maplibre-gl` and `three`, and `maplibre-gl` ships as a side-effectful bundle
that no tree-shake will take back out once it is in the module graph — so a picker screen pays about
1.7 MB for a renderer it never mounts. Take what that screen needs from `/host` and name the viewer
itself through a dynamic import:

```tsx
import { KerrosThemeProvider, useDarkMode, parseExport } from '@kerros/viewer/host';
const FloorViewer = lazy(() => import('@kerros/viewer').then(m => ({ default: m.FloorViewer })));
```

Both entry points export the same names where they overlap, so nothing breaks by importing from
either one; the split exists only so that a host can choose when the renderer arrives.

## Components

- **`FloorViewer`** — the 2D/3D read-only viewer. See [The viewer](../guide/viewer) for the full prop list.
- **`FloorViewerProps`** — its props type.
- **`StructureView`** / **`StructureViewProps`** — the building as a browsable structure rather than a
  picture: zones, their member spaces, and the portals bounding each (derived with `perimeter`/`captive`).
  Read-only by default; pass `onEdit` to let it author zones and re-read portals. The parts of the
  ontology with no shape — a zone spanning floors, a lift core — have no honest home on a map, which
  is why this is a list.

## Live status

| Export | Description |
| --- | --- |
| `StatusReading` | `{ feedId, tone, label, timestamp?, metrics?, details? }` — domain-neutral status. |
| `StatusMetrics` | `{ occupancy?, capacity?, presence?, co2?, lux?, temperature? }`. |
| `StatusTone` | `'critical' \| 'warning' \| 'normal' \| 'unknown'`. |
| `StatusFeed` | `{ subscribe(project, listener): () => void }` — implement against your telemetry. |
| `statusTone(status, now?)` | The tone the viewer renders (applies staleness). |
| `statusLabel(status, now?)` | The label the viewer renders (applies staleness). |
| `unknownStatus(feedId)` | A blank unknown status. |

## Basemap

- `BasemapConfig` — `{ style, styleTransform?, transformRequest?, label?, vectorSchema? }`.
  - `style` — a style URL or a full `StyleSpecification`.
  - `styleTransform(style)` — last chance to adjust the loaded style: recolour layers, drop clutter,
    swap in a dusk palette. Runs for a fetched style and an inline one alike, after relative URLs are
    resolved, so you can tune a published basemap without forking and maintaining it.
  - `vectorSchema` — names your tiles' layers/fields to unlock footprint adoption, the cadastre
    overlay and 3D-city massing. Omit it and those features stay off; the library ships no schema.
- `neutralBasemap` — the offline plan background (default).

## Theming

`KerrosThemeProvider`, `useKerrosTheme`, `useDarkMode`, and the types `KerrosTheme`, `MapStyleOptions`, `ConfirmOptions`. See [Theming](../guide/theming).

## Persistence

`LocalProjectRepository`, `IndexedProjectRepository`, `IndexedAssetRepository` — browser-generic adapters (a read-only viewer host still needs to load saved projects).
