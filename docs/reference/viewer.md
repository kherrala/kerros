# `@kerros/viewer`

Read-only floor viewer + the live-status contract. Re-exports everything from [`@kerros/schema`](./schema). Peers: `react`, `react-dom`, `maplibre-gl`, `three`.

```ts
import '@kerros/viewer/styles.css';
```

## Entry points

| Import | What it is |
| --- | --- |
| `@kerros/viewer` | The whole facade, `FloorViewer` included. |
| `@kerros/viewer/host` | The same facade minus the map renderer: persistence, theming, status helpers, read-only panels, the schema and viewer prop types. |
| `@kerros/viewer/styles.css` | The stylesheet (MapLibre's, then Kerros'). |

`FloorViewer` reaches `maplibre-gl` and `three` — about 1.7 MB that a picker screen has no use for.
The package is published one file per module, so a bundler follows only what you actually name:
importing `KerrosThemeProvider` from either entry point costs the same, and neither pulls the
renderer.

`make budget` measures the current payload of each import. Light host imports do not fetch a map;
`FloorViewer` loads MapLibre, with the 3D scene and optional panels deferred until needed.

`three` is not in that first load. The 3D scene is named with a dynamic import, so a viewer left in
2D never fetches it — which is what a host embedding a flat floor plan wants, and it needs no
separate entry point to get it.

```tsx
import { KerrosThemeProvider, useDarkMode, parseExport } from '@kerros/viewer';
const FloorViewer = lazy(() => import('@kerros/viewer').then(m => ({ default: m.FloorViewer })));
```

The `lazy()` is still yours to write — tree-shaking decides what is in the bundle, not when it
arrives, and mounting the viewer is what makes the renderer worth fetching.

`/host` exports the same names minus `FloorViewer`. It is now a statement rather than a workaround:
import from it and the renderer *cannot* end up in that module's graph, by construction, whatever a
future refactor does to the barrel. Reach for it when you want that guaranteed, and use the main
entry otherwise.

## Components

- **`FloorViewer`** — map-only by default; `controls` adds floor/view options, structure, graph view, directions/playback and read-only properties. See [The viewer](../guide/viewer) for the full prop list and elevator integration.
- **`FloorViewerProps`**, **`ViewerMode`**, **`ViewerDisplayOptions`**, **`WalkAvatar`** — view and interaction contracts. Props and types are also available from `/host`.
- **`StructureView`** / **`StructureViewProps`** — the building as a browsable structure rather than a
  picture: zones, their member spaces, and the portals bounding each (derived with `perimeter`/`captive`).
  Read-only by default; pass `onEdit` to let it author zones and re-read portals. The parts of the
  ontology with no shape — a zone spanning floors, a lift core — have no honest home on a map, which
  is why this is a list.
- **`StructureTarget`** — object IDs, floor and/or position supplied by map-location buttons.
- **`NavigationPanel`** / **`NavigationPanelProps`** — the shared directions and playback panel with authoring disabled; the host supplies endpoints, route and callbacks.
- **`NavigationGraph`** / **`NavigationGraphProps`** — force-directed graph visualization with floor filtering, layout controls and `onLocate`/`onClose` callbacks. Graph positions are presentation state only.
- **`ReadOnlyInspector`** / **`ReadOnlyInspectorProps`** — geometry, relationships and live status with selection/floor callbacks and no document mutation API.

These panels are also exported from `/host`, load their UI on demand, and can be composed around
a map-only `FloorViewer`. No panel loads the editor's planner or import workflow.

## Live status

| Export | Description |
| --- | --- |
| `StatusReading` | `{ feedId, tone, label, timestamp?, metrics?, open?, carFloorId?, targetFloorId?, carTravelSeconds?, moving?, running?, travel?, details? }` — domain-neutral status. |
| `StatusMetrics` | `{ occupancy?, capacity?, presence?, co2?, lux?, temperature? }`. |
| `StatusTone` | `'critical' \| 'warning' \| 'normal' \| 'unknown'`. |
| `StatusFeed` | `{ subscribe(project, listener): () => void }` — implement against your telemetry. |
| `statusTone(status, now?)` | The tone the viewer renders (applies staleness). |
| `statusLabel(status, now?)` | The label the viewer renders (applies staleness). |
| `unknownStatus(feedId)` | A blank unknown status. |
| `ElevatorControls` | `{ statuses, call(feedId, floorId), hold(feedId, open) }` — optional host commands used by passenger controls and route playback. |
| `StatusPanelContext` | Context passed to `renderStatusPanel`; the viewer supplies `editing: false`. |

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
