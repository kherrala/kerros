# The editor

`FloorEditor` (from `@kerros/editor`) is the full authoring product: draw walls and zones, place doors/cameras/devices, import footprints and reference drawings, trace buildings, author routes, switch to 3D, and monitor live status. The sidebar's **structure panel** browses the [ontology](/guide/ontology) — spaces by building and floor, semantic zones, portals and portal groups, and the navigation topology — and authors zones in edit mode. `SiteViewer` is the same component in read-only mode.

![Reference editor in 3D](/media/editor-3d.png)

For doors, **Door hinge** chooses left- or right-handed leaves (wall start or end). **Opening side**
chooses which side of the wall receives the swing. Dragging a door along the wall moves it; dragging
across the wall flips its opening side. The drag preview, plan symbol and 3D leaf agree.

For drawing behavior, read [Space geometry & walls](/guide/geometry): how **Space from walls** builds an outline, what follows a moved wall, how splitting and merging work, and how snapping differs from coordinate precision.

## Importing a drawing with AI

The reference editor's **Import plan → AI import** sidebar accepts images, PDFs and DWGs. Supply known dimensions or a footprint area, then follow Claude's activity as validated edits appear and save in the live project. The sidebar includes a source SVG overlay, chat, token usage and saved continuation after a reload. See [AI import with Claude](./ai-import) for setup, controls and troubleshooting, and [source analysis and calibration](./ai-import-analysis) for the extraction tools and geometry checks.

## Keyboard navigation

In **2D**, W/A/S/D pans up/left/down/right, like the arrow keys. This also works with the editor's
Select or Pan tool. Choose a drawing tool from the toolbar to use W/D/S as wall/door/split shortcuts;
while drawing, the arrow keys still pan. Keyboard navigation ignores text fields and dialogs.

## Walking through a floor

Choose **Walk** to view the active floor at eye height. Use W/S or the up/down arrows to move, A/D or the left/right arrows to turn, and drag the view with the left mouse button to look around. The cursor stays visible; releasing the button lets you use the panels immediately. Press Escape once to leave Walk.

Pool water uses a simple static translucent surface in the normal **3D** overview. Waves, refraction,
underwater fixture lighting and animated caustics run only in **Walk**, where those details are visible.

The **Field of view** slider in the upper right adjusts the horizontal viewing angle from **60° to 120°**, with **100°** as the default. It changes how much you can see without moving you or changing your eye height. Your browser remembers the setting, including after a reload. Leaving Walk restores the normal map camera's field of view.

Selecting an object from the list turns you toward it from your current position. Changing to a floor
with a smaller footprint moves an unsupported walking position to a dry navigation point on that floor.

Mezzanine collision includes walls rising from the storey below, using their actual height and
door openings. Exposed edges of elevated and basement floors stop movement at the slab edge.
Authored gallery holes allow a drop when there is a supporting floor below; holes without a landing
stop movement. Stairs and escalators provide their own support through these openings, and
ground-level exits remain walkable.

### Stairs and escalators

Walk onto the steps to climb or descend; your eye height follows the flight and the active floor
changes at the landing. Turning stairs use their intermediate landings. Escalators carry you while
you stand on the moving steps, following their configured or live direction. A stopped machine can
still be walked. The side rails block sideways passage.

Stockmann’s selling floors, including −1, −1A and −2A, share a terrazzo tile finish. Ground-floor service partitions reach the hall’s full height; the entresol is a separate partial level. Exterior walls use plaster on their inward faces and masonry outside, with transparent glazing.

Stockmann's escalator pairs have opposing slopes within shared rectangular wells. Ribbed metal
steps have yellow edge markings, and the ground-floor shopping hall uses large terrazzo tiles.

### Elevators and music

In the reference app, open **Elevator controls** in Walk. **Call to this floor** brings the car to you;
walk to its doors and choose **Enter elevator**, or walk through the open doorway. Inside, choose a
destination. The doors close before travel and open at the destination; **Exit elevator** steps onto
the landing. You can also walk out through the open doors. Calls keep your current view in place.

The Backrooms uses one elevator for all three office levels and both bath levels. Its cabin plays an
original lounge melody; the baths have a separate, slower ambient score. **M** mutes both, and the
sidebar's **Cabin music** button shows the current setting.

The cabin has its own stone floor, brushed metal doors that retract into the frame, handrails,
ceiling diffusers, and a floor display. **Look in mirror** turns your view toward the live cabin mirror. A three-dimensional
passenger follows your position and movement; its head appears in reflections while your normal
POV stays unobstructed. Press **Wave** to try the articulated reflection. Looking down reveals your
own legs and shoes. Mirror rendering is limited to nearby cabins and does not recurse between mirrors.

The passenger view stays at eye height inside the closed cabin and changes storeys before the doors
open. The overview animates the car between elevations. This is a timed ride simulation, not lift physics.

Hosts enable these controls with the optional `elevators` prop:

```tsx
<FloorEditor project={project} adapters={adapters}
  elevators={{ statuses: liftReadings, call: callLift, hold: holdLiftDoors }} />
```

The host owns the commands and their sequence. `carFloorId` reports the last arrival, `targetFloorId`
names a destination during travel, `open` animates the leaves, and `moving` prevents boarding during
travel or door movement. Supply `moving: false` only once the doors have finished moving. These
readings are transient and are not saved in the floor plan. `app/liftSimulation.ts` provides the
reference simulator, including independent timers for multiple cars.

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

For domain-specific controls of your own (unlock a door, command a gate, simulate a state) supply `renderStatusPanel` — a slot rendered in the inspector for a selected bound object:

```tsx
<FloorEditor
  …
  renderStatusPanel={({ object, status, editing, live }) =>
    live ? <MyControls id={object.feedId!} status={status} /> : null
  }
/>
```

The reference app supplies the optional elevator simulation separately; it supplies no monitoring feed or inspector status panel. See [Extending](./extending).

## Surveyed basemaps

If your `BasemapConfig` supplies a `vectorSchema`, the editor unlocks building **adoption** (trace a footprint straight from the basemap), a **cadastre** overlay and **3D-city** massing. You name your own tiles' layers and fields there, so any vector basemap can drive them — the reference `mmlBasemap` targets Finland's MML. Omit the schema and those features stay off.

### Door mechanisms

Select a door and use **Door type** to choose a hinged, sliding or double-leaf door. Existing doors default to hinged. The plan symbol, drag preview and animated 3D door follow the chosen mechanism. Doors have jambs, trim, inset panels, metal handles and thresholds.

**Door hinge** selects the jamb for a hinged leaf. For a sliding door, **Slide direction** chooses travel along the wall toward its start (left) or end (right); the leaf runs on a surface-mounted rail, so leave room beside the opening. Double doors hinge at both jambs. **Opening side** selects the side of the wall for the swing or sliding track; dragging across the wall also changes this side. A bound feed’s `open` state drives the animation, and doors with unknown state remain closed in 3D.
