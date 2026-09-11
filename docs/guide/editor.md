# The editor

`FloorEditor` (from `@kerros/editor`) is the full authoring product: draw walls and zones, place doors/cameras/devices, import footprints and reference drawings, trace buildings, author routes, switch to 3D, and monitor live status. The sidebar's **structure panel** browses the [ontology](/guide/ontology) — zones, their spaces, and each zone's derived ways in — and authors zones in edit mode. `SiteViewer` is the same component in read-only mode.

![Reference editor in 3D](/media/editor-3d.png)

## Adapters

The editor is storage- and integration-agnostic. You pass a `PlannerAdapters` object:

```ts
interface PlannerAdapters {
  projects: ProjectRepository;   // list / load / save / delete
  assets: AssetRepository;       // reference-image blobs
  status?: StatusFeed;           // live status readings (subscribe); omit → no monitoring surface
  basemap?: BasemapConfig;       // optional map background
}
```

`@kerros/editor` ships browser-generic implementations — `LocalProjectRepository` (localStorage) and `IndexedAssetRepository` (IndexedDB). Bring your own for a server backend.

```tsx
import { FloorEditor, LocalProjectRepository, IndexedAssetRepository } from '@kerros/editor';

const adapters = {
  projects: new LocalProjectRepository(),
  assets: new IndexedAssetRepository(),
  status: myFeed,          // implements StatusFeed
  basemap: myBasemap,      // optional
};

<FloorEditor project={project} adapters={adapters} onChange={save} />;
```

## No env, no URL — the host owns both

The editor reads no environment variables and never touches the URL. Two host hooks keep it embeddable:

- **`onViewChange(view)`** — emitted as the floor, mode or camera changes. Persist it however you like; the reference app writes a deep-link fragment. `initialView` restores it.
- **`onModeChange(mode)`** — `'view' | 'edit' | 'live'`. A monitoring host can, for example, start or stop its feed's traffic when the user enters Live view.

```tsx
<FloorEditor
  project={project}
  adapters={adapters}
  initialView={savedView}
  onViewChange={v => history.replaceState(null, '', toHash(v))}
  onModeChange={mode => feed.setActive(mode === 'live')}
/>
```

## Status panels

The editor keeps **no** command or simulation vocabulary. To offer controls of your own (unlock a door, command a gate, simulate a state) supply `renderStatusPanel` — a slot rendered in the inspector for a selected bound object:

```tsx
<FloorEditor
  …
  renderStatusPanel={({ object, status, editing, live }) =>
    live ? <MyControls id={object.feedId!} status={status} /> : null
  }
/>
```

The reference app supplies no feed and so renders no such panel — what a reading means is the host's. See [Extending](./extending).

## Surveyed basemaps

If your `BasemapConfig` supplies a `vectorSchema`, the editor unlocks building **adoption** (trace a footprint straight from the basemap), a **cadastre** overlay and **3D-city** massing. You name your own tiles' layers and fields there, so any vector basemap can drive them — the reference `mmlBasemap` targets Finland's MML. Omit the schema and those features stay off.
