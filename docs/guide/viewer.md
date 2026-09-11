# The viewer

`FloorViewer` (from `@kerros/viewer`) is a read-only, embeddable 2D/3D floor plan. It renders a `ProjectDocument`, an optional live-status overlay, and nothing else — no editing chrome, no persistence. `app/viewer.tsx` in the repository is a `FloorViewer` embedded in a custom host.

## Basic usage

```tsx
import { FloorViewer } from '@kerros/viewer';
import '@kerros/viewer/styles.css';

<FloorViewer project={project} assets={assets} statuses={statuses} threeD showLabels />;
```

## Key props

| Prop | Type | Notes |
| --- | --- | --- |
| `project` | `ProjectDocument` | required. |
| `assets` | `AssetRepository` | reference-drawing images; omit → drawings not rendered. |
| `statuses` | `StatusReading[]` | full current status set (replace semantics — absent bindings read as unknown). |
| `basemap` | `BasemapConfig` | omit → `neutralBasemap` (offline plan background). |
| `floorId` | `string \| null` | controlled floor; `null` is the outdoor site. Omit to let the viewer manage it. |
| `selected` / `onSelect` | `string \| null` | controlled selection + callback. |
| `onHoverObject` | `(id \| null) => void` | fires as the pointer moves over plan objects. |
| `threeD` / `stack` / `dark` / `showLabels` / `showPlan` | `boolean` | view toggles. |
| `initialCamera` | `{ center, zoom, bearing, pitch }` | restore an exact camera (deep links). |
| `onReady` | `(map) => void` | the underlying MapLibre map, for hosts that observe the camera. |

`floorId` and `selected` are *controlled when provided* — pass them with a handler to drive the view from your own state, or omit them and the viewer manages its own.

## Live status

Bind objects to a feed by setting `feedId`, then pass the current `statuses` array. A `StatusReading` is domain-neutral:

```ts
interface StatusReading {
  feedId: string;
  tone: 'critical' | 'warning' | 'normal' | 'unknown';  // how the viewer colours it
  label: string;                                       // shown in the inspector
  timestamp?: number;                                  // enables staleness warnings
  metrics?: { occupancy?; capacity?; co2?; /* … */ };  // rolled up per floor/building
  details?: Record<string, unknown>;                   // opaque host state, passed through
}
```

The viewer colours bound objects by `tone`, shows `label`, rolls up `metrics`, and marks a reading stale if its `timestamp` is older than 30 s. Anything domain-specific (a lock state, a booking) travels in `details`, which the library carries but never reads — see [Extending](./extending).

`statusTone(status)` and `statusLabel(status)` are exported so your own chrome can render the same tones/labels the viewer does.
