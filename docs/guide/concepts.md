# Core concepts

Everything in Kerros revolves around one serializable value: the **`ProjectDocument`**.

## The project document

A `ProjectDocument` is a plain, JSON-serializable object — the single source of truth you store, version and pass around. It holds:

- **`buildings`** and **`floors`** — floors carry an `elevation` and `height` and belong to a building.
- **`objects`** (`SiteObject[]`) — rooms, zones, doors, cameras, stairs, elevators, POIs, sensors, and more (see `ObjectKind`).
- **`barriers`** (`Barrier[]`) — walls and fences; openings (doors/windows) attach to them.
- **`junctions`** and optional **`virtualBoundaries`** — the shared boundary network used by connected spaces.
- **`drawings`** — reference images (PDF/PNG) aligned to the map.
- **`zones`**, **`portals`** and **`portalGroups`** — optional semantic membership and connection records.
- **`navNodes` / `navEdges`** — an optional authored graph overriding derived routing.
- **`origin`** — the geographic anchor (see Coordinates below).

Construct an empty one with `emptyProject(origin, name)`. `createObject(kind, position, floorId)`
creates an object value; add or change document entities through `transact` or mutations.

## Coordinates

Geometry is stored in **local metric coordinates** — metres east/north of the project `origin`, with an optional site rotation. The origin is a plain WGS84 lng/lat point; Kerros projects to/from local metres with an ellipsoidal local-tangent-plane around it, so the core needs **no projection library and works anywhere on Earth** (it converts to lng/lat only at the map boundary):

```ts
import { geoOrigin, toLngLat, toLocal } from '@kerros/schema';
const origin = geoOrigin([24.94, 60.17]);   // a WGS84 lng/lat origin (optional 2nd arg = site bearing)
const lngLat = toLngLat([12, 8], origin);    // local metres → lng/lat for the map
```

Need survey-grade coordinates from a projected CRS? Convert them to lng/lat with your own tools (e.g. proj4) before importing — the library stays CRS-free. The footprint importer accepts a host-supplied converter for exactly this.

## Objects, barriers and openings

Walls and fences are **barriers**, defined by shared junction endpoints — they are the authoritative wall geometry, and wall surfaces are derived at render time. **Openings** (doors, windows, gates) attach to a barrier via `barrierId` + an `offset` along it. Connected areas reference ordered loops of physical or virtual edges; their `rings` are generated from those boundaries and wall thickness. Independent areas keep their own polygons. See [Space geometry & walls](/guide/geometry) for conversion, consistent wall edits and the distinction between the shared planar model and generated rendering meshes.

## Live status

Any object can be bound to a live feed by setting a **`feedId`**. A [`StatusFeed`](./viewer#live-status) then streams `StatusReading` snapshots keyed by that id, and the viewer colours the object by the status **tone** and shows its **label**. Areas can also report **metrics** (occupancy, CO₂, …) which roll up per floor and building. A binding need not be a device: a room whose occupancy comes from a booking system reads exactly like a door with a sensor.

Status is *transient overlay data* — it is **not** part of the persisted `ProjectDocument`.

## Navigation

`findRoute(project, fromId, toId)` uses the graph derived from spaces, effective portals and zone
connectivity unless an explicit `navNodes` / `navEdges` graph is supplied. `navPath` and
`chainVertical` support authored graphs; connect their horizontal and vertical paths explicitly.
Routing is pure and lives in `@kerros/schema`, so it works headlessly. A route does not itself
operate a lift or enforce host permissions.

## Spaces, zones and portals

Geometry describes the building; the **ontology** describes what it means — which areas group into
zones, which portals connect them, and which way you may go through each one. It is the layer your own
application joins to by space, zone or portal ID. Portals can be inferred from openings, derived
from shared virtual boundaries or authored explicitly. See [Spaces, zones & portals](/guide/ontology).

## The document is always valid

There is no such thing as a half-edited Kerros document. Every change — the editor's and yours —
goes through one gate: `transact` clones the document, applies the change, normalizes shared boundaries, regenerates connected space footprints, runs **every** rule
(structure, geometry, spatial relationships, ontology, navigation), and only then returns the
result, deep-frozen so nothing can alter it except the next transaction. If the change throws or
breaks any rule, you get the reason back and the original document, untouched.

Valid means the document passes those checks. It does not mean every independent space polygon
tiles the floor without gaps or follows every wall; see [what validation guarantees](/guide/geometry#what-validation-guarantees).

For changes worth naming there is also a data form: a `Mutation` (`{ kind: 'addZone', … }`) applied
with `applyMutations` — a sequence lands whole or not at all, which is what makes migrations and
table-driven tests safe to write. See
[Validity & transactions](/reference/schema#validity-transactions).

## Host extensibility

Objects and barriers carry two optional, host-defined fields the library forwards but never interprets:

- **`category`** — a string you use to style or group (exposed as a CSS class and to `mapStyle.objectColor`).
- **`metadata`** — an arbitrary record you attach and read back in event handlers.

See [Extending](./extending) for custom feeds, categories and status panels.
