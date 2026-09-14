# `@kerros/schema`

The framework-free core: the data model and pure operations. No React, no MapLibre, no browser storage — usable in a browser, a server, a CLI or a mobile backend. Full TypeScript types ship with the package; this page is the map.

## Document & entity types

| Type | Description |
| --- | --- |
| `ProjectDocument` | The serializable root: `buildings`, `floors`, `objects`, `barriers`, `drawings`, the ontology (`zones`, `portals`, `portalGroups`), the optional authored graph (`navNodes`/`navEdges`), `origin`, `initialFloorId`. |
| `ProjectSummary` | Lightweight `{ id, name, updatedAt }` for pickers. |
| `Building`, `Floor`, `Junction` | Structure. Floors carry `elevation` + `height`. |
| `SiteObject` | Any placed object; `kind: ObjectKind`, optional `rings`, `slope`, `feedId`, `category`, `metadata`. |
| `Slope` | Makes an area a sloped plane: `{ axis: [Point, Point]; high; low }`. |
| `Barrier` | A wall or fence segment between junctions. |
| `VirtualBoundary` | An unwalled edge sharing the same junction network. |
| `BoundaryUse`, `SpaceGeometry` | A directed edge reference and an area’s independent/shared-boundary geometry mode. |
| `Drawing` | A reference image aligned to the map. |
| `Origin`, `Point`, `Ring` | Spatial primitives (local metres). |
| `NavNode`, `NavEdge`, `NavEdgeKind` | The routing graph. Derived from spaces and portals when a document authors none. |
| `Zone` | A named **set** of spaces — no geometry of its own, so it may span floors, nest as a DAG, and overlap. `connects` declares internal reachability: `'all'` for a lift, `'adjacent'` for a stair, `'up'`/`'down'` for an escalator. |
| `Portal` | A way through, joining exactly **two** spaces: `a`, `b`, optional `openingId`, `passage`, and `attests`. |
| `PortalGroup` | An explicit set of portals, for sets that are not a zone boundary. |

`ObjectKind` covers areas (`room`, `zone`, `building`, `parcel`), openings (`door`, `window`, `gate`, `turnstile`), fixed equipment (`camera`, `reader`, `sensor`, `alarm`, `equipment`), vertical circulation (`stairs`, `elevator`), plus `evacuation`, `fixture`, `landscape`, `poi` and more. The taxonomy is deliberately broad — it names things a plan may contain, not an application you must build.

Guards & ids: `isArea`, `isDevice`, `isOpening`, `uid`. The full list is exported as `OBJECT_KINDS`.

For read-only navigation integrations, use `navNodes(project)` and `navEdges(project)` to read the
effective graph, including derived connectivity when authored arrays are absent. `findRoute` accepts
`RouteEnd` values (object IDs or floor/position pairs) and returns a `Route`; `RoutePlace` describes a
resolved endpoint. The `HERE` constant identifies the avatar option in navigation controls.

### Materials and lights

Objects and barriers accept `material`, including `terrazzo` (600 mm stone floor tiles), `carpet` (matte loop pile) and `wallpaper` (a repeated
pattern with paper seams). Textures are generated locally and use metre-scaled UVs.

A `light` object describes a ceiling panel. `width` and `depth` are its dimensions; `height` is its
mounting height above the floor. Its required `light: LightFixture` settings are `kelvin` (1000–12000),
`intensity` (0–10000 candela; zero switches it off), `range` (0–100 metres, excluding zero), and optional
`flicker` (0–1, default zero). For example:

```ts
const panel = createObject('light', [6, 3], floorId, 'Fluorescent panel');
panel.light = { kelvin: 4000, intensity: 55, range: 13, flicker: 0.8 };
```

The 2D plan shows the fitting footprint. In walk mode the renderer instances the panels and lights
the room from the nearest four, of which the nearest two cast shadows; distant fixtures remain
visible but do not add unbounded lighting cost. Flicker is intermittent and deterministic per object ID. These local lights
supplement the floor's existing `light: InteriorLight` ambient setting.

`light.mountHeight` overrides the fitting's mounting elevation and may be negative for submerged
pool lights. `Floor.light.tint` optionally supplies a `#rrggbb` ambient cast while `level` continues
to control brightness. Raised fixtures such as lintels use `baseHeight`, measured above the floor
surface; their `height` remains the solid's own height.

### Tall spaces and pools

`room` and `zone` areas may set `ceilingHeight` above the floor datum. Taller rooms can span several
storeys; holes in the overlying area rings expose the space beneath. In Walk, entering an uncovered
authored floor hole drops the walker to the nearest supporting floor in the same building.

An area's `water: { depth, ripple? }` creates a tiled basin below its floor surface. The same outline
cuts the surrounding floor and defines the basin and transparent water surface. Depth is positive
and at most 20 m; ripple amplitude is 0–0.1 m. The renderer animates small surface waves with refraction
and underwater lighting. Lit pools project animated blue caustics onto the tiled surfaces of their
containing room (`parentId`). This is a visual approximation of ripple-focused light, not a ray-traced
optics simulation. Setting the floor's ambient light `level` to zero on a pool floor also disables
daylight fill and ceiling emission: the submerged lamps and their reflected light carry the room.
Tiled chambers without a pool receive a weaker diffuse approximation through connected open portals;
sealed walls do not transmit it. Ripple caustics remain inside the source chamber. Tiled perimeter
walls retain their authored finish instead of receiving the default plaster lining.
Swimming and buoyancy are not modelled.

A fixture's `slide: { path, radius }` defines an open water slide. Each path point is `[x, y, z]` in
metres relative to the fixture's position and rotation; `z` is above its floor. The radius is positive.

### Ambient sound

A floor's `ambience` is what it sounds like from inside it, and any room or zone can carry its own
`ambience` to override the floor's. Both are `{ preset, level? }`: `preset` is one of `silent`,
`office` (ventilation and a faint ballast hum), `backrooms` (louder ballasts, a breathing HVAC and a
compressor that cycles), `plant` (machinery), `baths` (original ambient music: slow chords and
soft glass bells with a long stereo reverb), or `elevator` (a gentle lounge melody with electric keys). `level` is 0–1 (default 1). Absent is silence.

```ts
floor.ambience = { preset: 'backrooms' };
serverRoom.ambience = { preset: 'plant', level: 0.8 };
poolFloor.ambience = { preset: 'baths', level: 0.55 };
```

Walk mode synthesises the sound locally — nothing is downloaded — and cross-fades as you cross from
one space into the next. `M` mutes it; the plan views are silent.

### Sloped areas

Any area can be a ramp. Give it a `slope` and its plate is drawn as an inclined plane instead of a flat
one, in both the 2D plan and the 3D scene:

```ts
ramp.rings = [footprint];
ramp.slope = { axis: [streetEnd, deckEnd], high: 0, low: -12.6 };
```

The axis always runs downhill — `high` is the elevation at `axis[0]`, `low` at `axis[1]`, both absolute
metres in the same frame as `Floor.elevation`, so one ramp can span several floors. Elevation is
constant beyond either end of the axis, so a footprint longer than its axis keeps level aprons where it
meets the decks it joins. `slopeElevation(slope, point)` gives the elevation anywhere on the plate.

Below-grade ramps also widen the excavation: the 3D pit is the union of every below-grade floor plate
*and* every ramp, so a driveway that surfaces out at the street is cut through soil for its whole run
rather than hanging in open air.

### Door mechanisms

Door objects also accept `doorType?: 'hinged' | 'sliding' | 'double'`. Omission preserves the single hinged leaf used by older documents. For sliding doors, `doorHinge` selects travel toward the wall start (`left`) or end (`right`), and `doorSwing` selects the side carrying the surface-mounted track. Double doors hinge at both jambs and use `doorSwing` for their common opening side. These fields do not change the opening width or portal connectivity.


## Factories

- `emptyProject(origin, name?, datum?)` — a valid empty single-floor project.
- `createObject(kind, position, floorId, name?)` — a sized object of a kind.
- `copyProject(project)` — a deep copy with a fresh id and cleared feed bindings.
- `removeFloor(project, floorId)` — delete a floor and everything anchored to it, clearing every
  reference that would otherwise dangle: openings whose wall went, nested zones whose parent went,
  `watchedIds`, `servedFloorIds`, nav nodes/edges, a building roof on that level, and `initialFloorId`.
  Refuses to remove the last floor. Returns the removed ids.
- `openingFloorId(project)` — the floor a viewer should open on: the document's `initialFloorId` when
  it names a floor that still exists, else the ground floor, else the lowest. An explicit `null` means
  the outdoor site, which is why it is distinguished from the field being absent. Both `FloorEditor`
  and `FloorViewer` resolve through this, so a saved plan opens where its author intended; hosts can
  still override per session via `initialView.floor` / `FloorViewer`'s `floorId`.

## Geometry

See [Space geometry & walls](/guide/geometry) for the relationship between shared wall and virtual boundaries, generated space footprints, independent outlines and rendering meshes.

`geoOrigin`, `toLngLat`, `toLocal` (coordinate conversions), `rectangle`, `rotate`, `centroid`, `distance`, `closeRing`, `openRing`, `ringArea`, `objectArea`, `pointInRing`, `objectPosition`, `objectRotation`, `addBarrier`, `barrierEnds`, `segmentProjection`, `slopeElevation`.

Connected-space operations, called inside `transact`:

- `addVirtualBoundary(project, floorId, a, b)` — draw an unwalled boundary.
- `connectSpace(project, objectId, source?)` — connect an existing area using its outline (default) or explicitly adopt surrounding `'walls'`.
- `disconnectSpace(project, objectId)` — retain the current polygon as an independent outline.
- `boundaryEdges`, `boundaryRings`, `boundaryRegions`, `boundaryRegionAt` — query the shared graph and its centreline faces, including holes. Small unlabelled faces are included.
- `derivedSpaceRings(project, space)` — derive a connected space’s usable footprint after subtracting walls.
- `bindSpaceToRegion(project, space, region)` — attach an area to an already identified boundary face and generate its cache, useful for importers.

The `addBoundary`, `drawBoundary`, `connectSpace`, `disconnectSpace`, `encloseRoom`, `addHole` and `moveGeometry` mutation variants expose these edits as data. Transactions normalize crossings and update affected space loops automatically.

## Documents

- `exportProject(project, assets)` / `importProject(json, assets)` — portable JSON with embedded reference images.
- `parseExport(json)` — read an export into `{ project, assets }` without writing anything.
- `blobDataUrl(blob)`.

## Validity & transactions

Every rule lives in one module (`model/validate.ts`), and one contract holds everywhere: **a
document in circulation is always valid**. Loading validates, and editing goes through a
transaction that cannot produce an invalid result.

- `validateProject(value)` — parse + validate an unknown value into a `ProjectDocument`; throws
  with the reason. Runs every rule — structure, geometry, spatial relationships, the ontology, the
  navigation graph. The focused sub-validators `validateRings`, `validateRelationships` and
  `validateNavigation` are exported for targeted checks.
- `transact(project, change, options?)` — the atomic gate: work on a clone, apply `change`, normalize boundaries, regenerate connected spaces, run
  every rule, and return `{ ok: true, project }` — **deep-frozen**, so an out-of-band edit throws at
  the assignment — or `{ ok: false, error }` with the original untouched. A change that throws is a
  refusal, not a crash. `{ freeze: false }` hands back a mutable result when you really want one.
- `freezeProject(project)` — the deep freeze on its own.
- `applyMutation(project, mutation)` / `applyMutations(project, mutations)` — **change as data**:
  the authoring vocabulary as a serializable `Mutation` (`{ kind: 'addZone', … }`), executed through
  `transact`. A sequence applies whole or not at all, and `outcomes` reports what each step
  returned. Because mutations are plain data they can be logged, replayed over a wire, and
  table-tested. The data API also covers building/floor creation and updates, floor duplication/removal,
  barrier properties/removal, wall and junction movement, drawing boundaries, room enclosure and holes,
  all object fields (including doors and vertical transport), portal/zone connectivity and explicit navigation.
  `addBarrier` reports the created barrier ID; `inspect_document` in the AI tool loop can read generated IDs
  and state. Unknown mutation names and attempts to patch immutable IDs are refused.
- Geometry limits: `MIN_SEGMENT` (0.01 m — rejects degenerate walls while preserving short returns
  and jambs), `OPENING_MIN_SEGMENT` (the same base limit; actual opening width determines how much
  wall is needed), `COORD_LIMIT` (100 km — a corruption guard, not a site size). The 0.5 m drawing
  grid is independent of validation; turn snapping off for precise small details. New or resized areas require at least 1 m² of usable area, after holes and (for connected spaces) walls.

## Spaces, zones and portals

The spatial ontology layered over the geometry — see the [guide](/guide/ontology) for the concepts.
One module per concern in the source: space queries (`model/spaces.ts`), zone/portal semantics and
authoring (`model/ontology.ts`), reading the plan (`model/inference.ts`), and the derived routing
graph (`model/topology.ts`) — all exported flat from `@kerros/schema`.

### Space queries

- `enclosedRegion(project, floorId, point)` / `enclosedRegions(project, floorId, minArea?)` — derive enclosed outer outlines from barrier footprints; the default minimum region area is 1 m². This legacy helper returns outer rings only; use `boundaryRegions` for shared topology and holes.
- `refitEnclosedRooms(project, floorId, before)` — legacy overlap-based refitting for rooms without an explicit geometry mode. Connected spaces are regenerated automatically by `transact`; they do not use this helper.
- `spaces(project)` — every space; a room *is* a space, nothing is duplicated.
- `spaceAt(project, floorId, point)` — the **smallest** space containing a point.
- `spacePoint(project, space)` — where a space sits for routing (footprint centroid).
- `inSpace(space, point)` — inside the outline and outside the holes.

### Asking the described layer

- `entryInto(portal, spaceId)` — which way you must cross to arrive there, or `null`. Direction is
  asked rather than stored, because a door's entry side is relative to the area you mean.
- `perimeter(project, zone)` / `captive(project, zone)` — the portals bounding a zone versus those
  wholly inside it, **derived from the plan** rather than enumerated by hand.
- `zoneSpaces(project, zone)` — every space in a zone, including through nested zones.

### Authoring zones and portal groups

- `addZone(project, name, spaceIds, purpose?)` / `removeZone` / `setZoneMembers` / `nestZone` —
  zone authoring; non-space ids are dropped, membership is a set, nesting refuses cycles.
- `addPortalGroup(project, name, portalIds)` / `removePortalGroup` / `setPortalGroupMembers` — the
  explicit-set escape hatch for door sets that are not a zone boundary.
- `pruneOntology(project)` — drop references to deleted things; call after removing objects.

### Reading the plan

- `inferPortals(project)` — read the portals a plan already describes, probing each door for the
  space on either side. Unresolvable openings are skipped, not guessed at.
- `inferOpenBoundaries(project)` — the connections with **no door in them**: two spaces sharing an
  unwalled boundary long enough to walk through. Open-plan floors are made of these.
- `refreshPortals(project)` — re-read both kinds from the plan. Hand-authored portals survive
  wholesale; `passage`/`attests`/`name`/`metadata` set on an inferred portal are carried onto its
  replacement.
- `divideSpaces` / `spacesDividedBy` — legacy independent-outline splitting. Connected spaces subdivide through the transaction’s boundary synchronization.
- `spacesRejoinedBy(project, barrierId)` — the two spaces a wall was the only thing keeping apart.
- `mergeSpaces(project, keepId, absorbedId)` — unite footprints after a confirmed merge; never
  automatic, because one identity is always destroyed.

### The derived graph

- `derivedGraph(project)` — the routing graph as the dual of the plan: spaces are nodes, portals are
  edges, `Zone.connects` supplies the vertical ones. Used automatically by `findRoute` when a
  document authors no `navNodes`/`navEdges`.

## Navigation

- `findRoute(project, from, to, options?): Route | null` — cross-floor A→B routing. Each end can be an object ID or `{ floorId, position, name? }`. Optional `statuses` is a `ReadonlyMap<string, StatusReading>`; it supplies current escalator direction and whether a machine is stopped.
- `buildRoomNavigation(project, access, graph?): RoomNavigationGraph` — core geometric walking graph. `access` contains `{ spaceId, nodeId }` entries associating supplied graph nodes with rooms. The builder connects visible access points directly, adds waypoints around concave corners, floor holes and pools, and checks the full segment against wall thickness and open door/gate apertures. Supplied graph edges are retained, including directed door crossings and vertical connections. It returns new `nodes` and `edges` without mutating the inputs.
- `routeSteps`, `floorPhrase` — turn-by-turn narration.
- `validateNavigation`, `addNavNode`, `addNavEdge`, `navPath`, `chainVertical`, `routeAnchors` — authoring the graph.
- `edgeCost`, `edgeLength`, and the cost constants `ELEVATOR_BASE`, `ELEVATOR_PER_METRE`, `STAIR_CLIMB_FACTOR`, `DOOR_COST`, `NAV_WELD`.
- Types: `Route`, `RouteStep`, `RouteLeg`, `RouteOptions`, `RoomAccess`, `RoomNavigationGraph`.

For a controlled doorway, supply a node on each side, associate each node with its room, and connect
the pair with a `door` edge carrying the required `directed` and `objectId` values. A freely traversable
opening can share one access node between its two rooms. Keep vertical edges bound to their physical
stairs or elevator so playback can traverse them. Room navigation belongs to `@kerros/schema`; the
Backrooms generator supplies room geometry and doorway locations to this same public API.

```ts
const graph = buildRoomNavigation(project, roomAccess, {
  nodes: doorwayAndLandingNodes,
  edges: doorAndVerticalEdges,
});
const routable = { ...project, navNodes: graph.nodes, navEdges: graph.edges };
const route = findRoute(routable, { floorId, position }, destinationId, { statuses });
```

Rebuild after geometry/access changes. Generated IDs use the reserved `@room-nav:` prefix; rebuilding
with the preceding graph replaces these entries instead of accumulating waypoints. Authored access
nodes and crossing edges keep their identities. Without an explicit geometric graph, the existing
space/portal dual remains the default connectivity graph.

## Materials

`EXTERIOR_PRESETS`, `ExteriorPreset` — named exterior finishes for 3D massing.

### Door handing and shared stair wells

Doors accept `doorHinge?: 'left' | 'right'` and `doorSwing?: 1 | -1`. The defaults are `left` and `1`,
preserving existing drawings. Left hinges at the directed wall's start; right hinges at its end.
Swing `1` opens to the left of the start-to-end axis; `-1` opens to its right. Unattached doors use
their own rotation as that axis. These settings affect presentation, not passage permissions.

`drawVirtualBoundary(project, floorId, start, end)` is the authoring operation for an unwalled
boundary, including opening a collinear wall span. Call it inside `transact`. `addVirtualBoundary`
retains its non-destructive behavior for constructing generated space outlines.

Stairs may set `wellGroup?: string`. Group members intersecting the same level share one rectangular
floor/ceiling void enclosing their footprints; their individual tread and landing geometry remains.
The Stockmann sample uses one group per escalator pair. Rotation sets the physical slope orientation;
`travel` and live `StatusReading.travel` independently set the direction of motion.
