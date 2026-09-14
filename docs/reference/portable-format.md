# Portable project format

Kerros exchanges a building model as JSON. A third-party generator can produce the document without
running the editor; a reader can use it for visualization, navigation, analysis or another product.
The public TypeScript contract is `ProjectDocument` from [`@kerros/schema`](./schema), with runtime
validation and mutation helpers in the same framework-free package.

The current format uses `schemaVersion: 1`. It describes local planar geometry, floor elevations,
objects and connectivity. Rendered meshes, textures, camera state and AI conversations are not
required to interpret the building model.

## Document and portable file

The ordinary document references image assets by ID. A self-contained portable export adds an
`embeddedAssets` dictionary **beside the document fields**, not inside a separate `project` wrapper:

```json
{
  "schemaVersion": 1,
  "id": "project-example",
  "name": "Example building",
  "description": "A minimal one-floor project",
  "updatedAt": "2026-09-15T00:00:00.000Z",
  "origin": [24.938, 60.169],
  "datum": "Site ground level = 0 m",
  "buildings": [{ "id": "building-main", "name": "Main building" }],
  "floors": [{
    "id": "floor-ground",
    "buildingId": "building-main",
    "name": "Ground floor",
    "elevation": 0,
    "height": 3.5
  }],
  "junctions": [],
  "barriers": [],
  "objects": [],
  "drawings": [],
  "embeddedAssets": {}
}
```

This example is a valid empty project, not a complete floor plan. Required root collections are
`buildings`, `floors`, `junctions`, `barriers`, `objects` and `drawings`. There must be at least one
building and floor. Optional collections are `virtualBoundaries`, `zones`, `portals`, `portalGroups`,
`navNodes` and `navEdges`.

| Collection | Meaning and important references |
| --- | --- |
| `buildings` | Building identity and optional exterior/roof description |
| `floors` | `buildingId`, elevation, storey height and optional level code |
| `junctions` | Floor-local endpoint identity and `position` |
| `barriers` | Physical wall/fence edges using `startId` and `endId` junctions |
| `virtualBoundaries` | Unwalled edges using the same junction network |
| `objects` | Rooms, openings, transport and other placed entities; `floorId` and optional relationship IDs |
| `drawings` | Aligned reference-image records; `assetId` resolves through an asset repository |
| `zones` | Sets of space IDs, optional nested zones and connectivity declarations |
| `portals` | Connections between spaces `a` and `b`, optionally through `openingId` |
| `portalGroups` | Named sets of portal IDs |
| `navNodes`, `navEdges` | Optional explicitly authored routing graph |

All entity IDs must be unique across these collections within a document. Treat IDs as opaque strings;
UUIDs are convenient but not required. Preserve IDs when updating the same entity. Display names need
not be unique and must not be used as references. References must resolve to the correct entity kind.

`initialFloorId` chooses the opening level. Omit it for the normal default; set it to `null` for the
outdoor site. A valid floor ID, an omitted value and `null` have different meanings.

## Coordinates and units

| Field | Convention |
| --- | --- |
| `Point`, junction positions and rings | `[x, y]` in local metres; positive y is up in the plan |
| `origin` | `[longitude, latitude, bearing?]`; WGS84 degrees, optional clockwise site bearing from true north |
| Floor elevation and height | Metres; elevations share the project datum |
| Object width, depth, height and wall thickness | Metres |
| Object rotation | Degrees in the local mathematical frame; positive rotation is counterclockwise |
| Opening offset | Metres from the directed host wall's start, measured to the opening centre |
| Slope `high` and `low` | Absolute elevations in the same frame as `Floor.elevation` |

At zero site bearing, x points east and y north. Use `toLocal` and `toLngLat` for the library's local
tangent approximation. The `origin` is not an EPSG:3067 easting/northing pair. `datum` is a descriptive
label; it does not perform vertical-coordinate conversion. Separate floors share the same horizontal
frame, so aligned elevator landings have matching plan positions.

Image pixels and PDF points must be calibrated before becoming model coordinates. Preserve numeric
precision when exchanging documents: blindly rounding every derived junction can break a shared
boundary or an oblique intersection. Coordinate magnitude is bounded by the validator; the bound is
a corruption guard, not a surveying accuracy claim.

## Authoritative geometry and derived fields

A barrier stores junction IDs, kind (`wall` or `fence`), thickness, height and name. It does not store
another independent copy of its endpoints. Virtual boundaries use the same endpoints but have no
wall thickness.

A shared-boundary space is a `SiteObject` with `geometry.mode: 'boundaries'`. Its `geometry.loops`
contain ordered `{ edgeId, reversed? }` references. `reversed: true` traverses from the edge's end
to its start. Outer loops are counterclockwise and holes clockwise in the local y-up frame, keeping
the space on the left. Adjacent spaces use opposite directions of the same edge.

For these spaces, `rings`, `position`, `width` and `depth` are a validated generated cache of usable
geometry after wall subtraction. Third-party writers must update the shared edges and regenerate
these values through the core. Editing only cached rings creates a stale document. Renderers may
consume the generated rings without implementing face traversal themselves.

Independent areas use `geometry.mode: 'independent'`, or omit `geometry` for legacy compatibility.
Their own rings are authoritative; without rings, position, dimensions and rotation describe a
rectangle. Rings contain local coordinates, not object-relative vertices. Export explicitly closed
rings using `closeRing`. The first ring is the exterior and later rings are holes.

Doors and windows bind to a barrier using `barrierId` and `offset`. Use `objectPosition` and
`objectRotation` to resolve their effective placement. Keep their width within the resulting host
segment after a split; hinge and swing settings change appearance, not portal passage permissions.
See [space geometry](../guide/geometry) and [door mechanisms](./schema#door-mechanisms).

## Spaces, zones and navigation

Spaces are area objects; there is no separate `spaces` root array. A `Zone` in `zones` is a membership
set with no polygon. This is distinct from the older drawable object kind `zone`. Semantic zones may
overlap, span floors and have multiple parents, but nested zones cannot form cycles.

A portal connects two distinct spaces. `passage` defaults to `both`, with optional `a-to-b`,
`b-to-a` or `none`. A doorless opening can connect spaces without an `openingId`. A window is not
a traversable portal. Use `refreshPortals` to update inferred connections after changing geometry.

Prefer deriving ordinary routes from spaces, portals and `Zone.connects`. The latter can declare
`all` for elevator landings, `adjacent` for stairs, or `up`/`down` for directed vertical circulation.
Transport objects also need correct served floors and placement for physical traversal and playback.
A group name alone does not create a working elevator.

If supplying an authored graph, keep node and edge references, floor transitions, directions and
transport bindings consistent. Omitted navigation arrays enable derivation; explicit empty arrays
represent an empty authored graph. Use `navNodes`, `navEdges` and `findRoute` to access the effective
graph. Rebuild authored geometry-dependent routes after edits.

## Generate a connected room

This complete TypeScript example creates four walls and one shared-boundary room. The transaction
resolves junctions, computes usable rings and validates the result before producing JSON:

```ts
import { emptyProject, geoOrigin, applyMutations, validateProject } from '@kerros/schema';

const base = emptyProject(geoOrigin([24.938, 60.169]), 'Generated plan');
const floorId = base.floors[0].id;
const result = applyMutations(base, [
  { kind: 'drawBarrier', floorId, a: [0, 0], b: [6, 0] },
  { kind: 'drawBarrier', floorId, a: [6, 0], b: [6, 4] },
  { kind: 'drawBarrier', floorId, a: [6, 4], b: [0, 4] },
  { kind: 'drawBarrier', floorId, a: [0, 4], b: [0, 0] },
  { kind: 'encloseRoom', floorId, point: [3, 2], name: 'Meeting room' },
]);
if (!result.ok) throw new Error(result.error);
const project = validateProject(result.project);
// The host owns persistence timestamps; mutations do not stamp updatedAt.
const saved = { ...project, updatedAt: new Date().toISOString() };
const json = JSON.stringify({ ...saved, embeddedAssets: {} }, null, 2);
```

There are no reference drawings in this example, so no image assets need embedding. For a generator
in another language, emit the documented JSON and validate it using the core in a Node process or
service before publishing it. Type definitions describe structure; they do not replace geometric
validation. The generated AI **mutation** tool schema is not a JSON Schema for portable documents.

## Read, import and export

| API | Identity and storage behavior |
| --- | --- |
| `validateProject(value)` | Checks an unknown document and throws on invalid input; does not repair stale geometry |
| `parseExport(json)` | Returns `{ project, assets }` for reading; preserves project/entity IDs and timestamp; writes nothing |
| `importProject(json, assets)` | Imports for editing: stores drawings under fresh asset IDs, assigns a new project ID and timestamp; existing model entity IDs remain |
| `exportProject(project, assets)` | Embeds each referenced drawing and returns formatted JSON; refuses a missing referenced asset |

Validate before exporting. The current `exportProject` implementation serializes the supplied model
and checks asset availability; it does not itself call `validateProject`. The browser helper uses
`FileReader` to encode assets. A Node writer can encode image bytes as base64 directly, while using
the same document validation contract.

```ts
import { parseExport, findRoute } from '@kerros/schema';

const { project, assets } = parseExport(jsonText);
const image = project.drawings[0]
  ? await assets.get(project.drawings[0].assetId)
  : undefined;
// Real object IDs from this document, supplied by your application:
const route = findRoute(project, entranceId, destinationId);
```

`embeddedAssets` maps each drawing asset ID to a `data:image/png;base64,...`,
`data:image/jpeg;base64,...` or `data:image/webp;base64,...` string. The dimensions and alignment remain
in the `Drawing` record. Import-for-editing requires a supported embedded image for every referenced
asset. Read-only `parseExport` returns `undefined` for a missing or unsupported image instead.

The portable export does not include the AI source PDF/DWG, chat, analysis candidates, API keys,
undo history, local map caches or live status readings. Host repositories own these separately.
An aligned reference image is included only when it is referenced by `drawings`.

## Extensions and compatibility

Use supported object kinds with `category` and JSON-serializable `metadata` for product-specific
meaning. Zones, portals and portal groups also support metadata. Namespace your keys, for example
`"com.example.facilities": { "assetCode": "AHU-4" }`. Retain fields your product does not interpret
when forwarding a document; do not replace shared model fields with proprietary meanings.

Keep access policy, secrets and live device state in the host application. A `feedId` is a binding
reference, not credentials or a live sensor reading. Portal attestation and passage direction have
model semantics; they are not a complete authorization system.

The project remains pre-release and version 1 is still evolving. The validator rejects unsupported
schema versions; no general migration chain is promised. Pin the library version used by a writer,
record it in your product's own provenance, and validate exchanged fixtures when upgrading. Unknown
optional fields are not a substitute for negotiating compatibility with another consumer.

Useful interoperability checks include preserving IDs through a read/write round trip, restoring
embedded drawings, moving a wall shared by two spaces, retaining a courtyard hole, fitting a door
after a wall split, and resolving directed routes across floors. The [validation foundations](/academic/validation)
explain what acceptance establishes and where additional product checks remain necessary.
