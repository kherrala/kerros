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
| `Drawing` | A reference image aligned to the map. |
| `Origin`, `Point`, `Ring` | Spatial primitives (local metres). |
| `NavNode`, `NavEdge`, `NavEdgeKind` | The routing graph. Derived from spaces and portals when a document authors none. |
| `Zone` | A named **set** of spaces — no geometry of its own, so it may span floors, nest as a DAG, and overlap. `connects` declares internal reachability: `'all'` for a lift, `'adjacent'` for a stair, `'up'`/`'down'` for an escalator. |
| `Portal` | A way through, joining exactly **two** spaces: `a`, `b`, optional `openingId`, `passage`, and `attests`. |
| `PortalGroup` | An explicit set of portals, for sets that are not a zone boundary. |

`ObjectKind` covers areas (`room`, `zone`, `building`, `parcel`), openings (`door`, `window`, `gate`, `turnstile`), fixed equipment (`camera`, `reader`, `sensor`, `alarm`, `equipment`), vertical circulation (`stairs`, `elevator`), plus `evacuation`, `fixture`, `landscape`, `poi` and more. The taxonomy is deliberately broad — it names things a plan may contain, not an application you must build.

Guards & ids: `isArea`, `isDevice`, `isOpening`, `uid`. The full list is exported as `OBJECT_KINDS`.

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

`geoOrigin`, `toLngLat`, `toLocal` (coordinate conversions), `rectangle`, `rotate`, `centroid`, `distance`, `closeRing`, `openRing`, `ringArea`, `objectArea`, `pointInRing`, `objectPosition`, `objectRotation`, `addBarrier`, `barrierEnds`, `segmentProjection`, `slopeElevation`.

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
- `transact(project, change, options?)` — the atomic gate: work on a clone, apply `change`, run
  every rule, and return `{ ok: true, project }` — **deep-frozen**, so an out-of-band edit throws at
  the assignment — or `{ ok: false, error }` with the original untouched. A change that throws is a
  refusal, not a crash. `{ freeze: false }` hands back a mutable result when you really want one.
- `freezeProject(project)` — the deep freeze on its own.
- `applyMutation(project, mutation)` / `applyMutations(project, mutations)` — **change as data**:
  the authoring vocabulary as a serializable `Mutation` (`{ kind: 'addZone', … }`), executed through
  `transact`. A sequence applies whole or not at all, and `outcomes` reports what each step
  returned. Because mutations are plain data they can be logged, replayed over a wire, and
  table-tested.
- The limits that keep a plan editable: `MIN_SEGMENT` (0.5 m — no wall or fence shorter than the
  editor can grab; splitting welds rather than leaving debris), `OPENING_MIN_SEGMENT` (1 m — a door
  needs a wall to hang in, not a post), `COORD_LIMIT` (100 km — a corruption guard, not a site
  size).

## Spaces, zones and portals

The spatial ontology layered over the geometry — see the [guide](/guide/ontology) for the concepts.
One module per concern in the source: space queries (`model/spaces.ts`), zone/portal semantics and
authoring (`model/ontology.ts`), reading the plan (`model/inference.ts`), and the derived routing
graph (`model/topology.ts`) — all exported flat from `@kerros/schema`.

### Space queries

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
- `divideSpaces` / `spacesDividedBy` — split every space a new wall cuts across.
- `spacesRejoinedBy(project, barrierId)` — the two spaces a wall was the only thing keeping apart.
- `mergeSpaces(project, keepId, absorbedId)` — unite footprints after a confirmed merge; never
  automatic, because one identity is always destroyed.

### The derived graph

- `derivedGraph(project)` — the routing graph as the dual of the plan: spaces are nodes, portals are
  edges, `Zone.connects` supplies the vertical ones. Used automatically by `findRoute` when a
  document authors no `navNodes`/`navEdges`.

## Navigation

- `findRoute(project, fromId, toId): Route | null` — cross-floor A→B routing.
- `routeSteps`, `floorPhrase` — turn-by-turn narration.
- `validateNavigation`, `addNavNode`, `addNavEdge`, `navPath`, `chainVertical`, `routeAnchors` — authoring the graph.
- `edgeCost`, `edgeLength`, and the cost constants `ELEVATOR_BASE`, `ELEVATOR_PER_METRE`, `STAIR_CLIMB_FACTOR`, `DOOR_COST`, `NAV_WELD`.
- Types: `Route`, `RouteStep`, `RouteLeg`.

## Materials

`EXTERIOR_PRESETS`, `ExteriorPreset` — named exterior finishes for 3D massing.
