# The viewer

`FloorViewer` (from `@kerros/viewer`) is a read-only, embeddable floor plan. It shares the editor's renderer, structure browser, directions, passenger lifts and property views. It never edits or saves the `ProjectDocument`. `app/viewer.tsx` is a sample host that supplies persistence, a basemap and simulated lift commands.

## Basic usage

W/A/S/D pans the map in 2D. Text fields and dialogs retain their normal keyboard behavior.
In the 3D overview, pools use static translucent surfaces with inspection lighting. Walking mode
enables animated waves, refraction, caustics and the authored underwater light sources.

```tsx
import { FloorViewer } from '@kerros/viewer';
import '@kerros/viewer/styles.css';

<FloorViewer project={project} assets={assets} statuses={statuses} threeD showLabels />;
```

For the complete read-only interface, enable `controls`:

```tsx
<FloorViewer
  project={project}
  assets={assets}
  basemap={basemap}
  statuses={statuses}
  elevators={liftController}
  controls
/>
```

The optional controls include:

| Feature | Behavior |
| --- | --- |
| Floor and view controls | Floor selection, 2D, 3D, stacked floors and walking. The document's `initialFloorId` is respected. |
| Structure | Spaces, nested zones, portals and topology; search, floor filters, optional portal-group filters, infinite scrolling and map-location icons. Available even without authored zones. |
| Graph view | Replaces the map with a force layout of the actual routing graph. Filter floors, pause/rebalance, pan/zoom, select nodes and return to their map location. Layout never changes stored coordinates. |
| Directions | Select endpoints or start where the avatar stands; display, play, pause and inspect route steps across floors. Authored and derived graphs both work. |
| Walking | Keyboard movement and drag-to-look with a free cursor, draggable avatar start marker, 100° default FOV with an adjustable slider, ambience, stairs, escalators and passenger lifts. |
| Display options | Plan and label visibility, device coverage, underground context, city buildings and cadastral parcels. The last two require the corresponding host basemap schema. |
| Properties | The editor's read-only geometry, relationships, status readings and floor summaries. No authoring buttons or mutation callbacks. |

Omit `controls` to keep a map-only embed. Rendering capabilities remain available through props;
hosts can also compose the exported `StructureView`, `NavigationPanel`, `NavigationGraph` and
`ReadOnlyInspector` independently. Optional panels load on demand. The viewer does not import the
editor's planner, undo history or import dialogs.

Within the built-in viewer, `T` cycles view modes, `G` opens directions, `I` opens properties, and
Shift+Up/Down changes floors. These shortcuts leave text fields alone. Map rotation/zoom and 2D
W/A/S/D navigation use the same controls as the editor.

In Walk, hold the left mouse button and drag to look around. Release it to use the panels;
the cursor stays visible and is never locked. Press Escape once to return to 3D.

## Key props

| Prop | Type | Notes |
| --- | --- | --- |
| `project` | `ProjectDocument` | required. |
| `controls` | `boolean` | optional complete read-only UI; default `false`. |
| `assets` | `AssetRepository` | reference-drawing images; omit → drawings not rendered. |
| `statuses` | `StatusReading[]` | full current status set (replace semantics — absent bindings read as unknown). |
| `basemap` | `BasemapConfig` | omit → `neutralBasemap` (offline plan background). |
| `floorId` | `string \| null` | controlled floor; `null` is the outdoor site. Omit to let the viewer manage it. |
| `selected` / `onSelect` | `string \| null` | controlled selection + callback. |
| `onHoverObject` | `(id \| null) => void` | fires as the pointer moves over plan objects. |
| `viewMode` / `onViewModeChange` | `'2d' \| '3d' \| 'walk'` + callback | controlled mode; takes precedence over legacy `threeD`/`walk`. With controls, omit to manage it internally. |
| `threeD` / `walk` | `boolean` | legacy view flags; walking implies 3D. |
| `stack` / `onStackChange` | `boolean` + callback | stacked-floor overview; ignored in walking mode. |
| `dark` | `boolean` | dark appearance. |
| `showLabels` / `showPlan` / `coverage` / `excavation` / `cityBuildings` / `cadastre` | `boolean` | display flags. With controls, omitted flags are managed internally. |
| `onDisplayChange` | `(options: ViewerDisplayOptions) => void` | all display flags after a built-in toggle; use to update controlled flags. |
| `avatar` / `onAvatar` / `onWalkAt` | `WalkAvatar` + callbacks | retain the person's position, receive movement and handle avatar placement. |
| `focusId` | `string \| null` | focus an object using the current view mode; POV retains its walking camera. |
| `elevators` | `ElevatorControls` | host lift commands and transient readings; enables the passenger panel and lift route playback. |
| `route` / `onRouteChange` | `Route \| null` + callback | a host-provided route, or observe routes chosen with built-in controls. |
| `playing` / `onPlayingChange` | `boolean` + callback | externally controlled playback; otherwise managed by built-in controls. |
| `activeStep` / `onJourneyStep` | `number \| null` + callback | highlighted route step and playback progress. |
| `onJourneyEnd` / `onWalkExit` | `() => void` | journey completion/cancellation or leaving POV. |
| `renderStatusPanel` | `(context: StatusPanelContext) => ReactNode` | host-specific information in the built-in properties panel; context always has `editing: false`. |
| `initialCamera` | `{ center, zoom, bearing, pitch }` | restore an exact camera (deep links). |
| `onReady` | `(map) => void` | the underlying MapLibre map, for hosts that observe the camera. |

`floorId` and `selected` are *controlled when provided* — pass them with a handler to drive the view from your own state, or omit them and the viewer manages its own.

The same rule applies to the built-in mode, stack, display and playback controls. A supplied mode,
stack or display flag without its change callback is fixed and its toggle is disabled. Controlled
`null` is meaningful: `floorId={null}` selects outdoors, `selected={null}` clears selection and
`route={null}` suppresses the automatic route. Changing the project ID resets the built-in session.

## Routes and passenger lifts

With `controls`, the viewer computes routes with the core `findRoute` function. It follows authored
navigation when present and derived space/portal connections otherwise, including shared virtual
boundaries. The selected path stays fixed during playback while lift status continues updating.

A custom host can supply a route and observe its progress directly:

```tsx
const route = findRoute(project, startId, destinationId);

<FloorViewer
  project={project}
  route={route}
  playing={playing}
  activeStep={step}
  onJourneyStep={setStep}
  onJourneyEnd={() => setPlaying(false)}
  floorId={floorId}
  onFloorChange={setFloorId}
  viewMode="walk"
  avatar={avatar}
  onAvatar={setAvatar}
  elevators={liftController}
/>
```

`ElevatorControls` contains `statuses`, `call(feedId, floorId)` and `hold(feedId, open)`. The host owns
the controller and reports car location, movement and doors; the viewer uses the same passenger
panel and journey sequencing as the editor. Readings supplied through `elevators.statuses` take
precedence over ordinary status readings for the same feed. Commands and avatar movement are
transient interaction state, not document mutations. The sample controller lives in `app/LiftPanel.tsx`.

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
