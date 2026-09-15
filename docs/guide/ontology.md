# Spaces, zones and portals

The ontology describes places, groups of places and the connections between them. Shared wall and
virtual-boundary geometry describes their shape. Hosts attach their own records and
observations using the same entity IDs; those records and events are not part of the topology.

## Three words

**Space** is an area object such as a room, corridor, lobby or elevator. It has a footprint and a
floor reference; outdoor spaces use `floorId: null`. Query spaces with `spaces(project)` and the
smallest containing space with `spaceAt(project, floorId, point)`.

**Zone** is a named set of space IDs. It has no geometry and may include disconnected areas on
several floors or in several buildings. This differs from a drawn object of kind `zone`, which is
an area object. A space may belong to multiple semantic zones.

**Portal** connects two space IDs, optionally referencing a physical opening. Doors, gates,
turnstiles and unwalled passages can connect spaces. Windows are openings but not walking portals.
A sealed portal can remain in the document with `passage: 'none'`.

## Browsing the structure

Open **Structure** in the editor or viewer. Its tabs read the same document as the plan:

- **Spaces** lists buildings, floors and all spaces, including rooms that belong to no semantic zone. Expand a space to see parent/contained objects, zone memberships, served floors and direct portals. The location icon (**Find on map**) selects it and changes floors.
- **Zones** groups named zones by purpose, with nested-zone relationships, expanded membership and perimeter crossings. Edit mode also supports creating, naming and changing zones through the normal undo history.
- **Portals** lists every portal, including open boundaries outside named zones. Optionally enable **Filter by portal group** and inspect endpoints, physical openings, passage direction and crossing evidence. A sealed portal remains visible here.
- **Topology** shows the same nodes and edges used by routing, including authored graph overrides when present. Expand a node for incoming/outgoing connections and transport kinds; filter to isolated nodes to find places with no graph connection. Sealed portals produce no routing edge.

Use the location icon on rows to find buildings, floors, spaces, zones, portals or graph connections on the map. Multi-space groups frame their members on the current relevant floor.

From **Topology**, choose **Open graph view** to replace the map with an interactive navigation graph. It reads the same authored or derived graph as routing. **Auto balance** uses a force layout; drag individual nodes, pan the background and scroll to zoom. **Fit graph** reframes the graph; **Rebalance** restarts the layout. Edge colors distinguish walking, doors, stairs/escalators and elevators; arrows indicate one-way travel. Filter by floor, search for a node, and use its location icon to return to the map. Layout changes are view-only and do not move floor-plan coordinates or modify routes.

Search and floor filters apply independently of the displayed map floor. Large lists load more entries as you scroll; collapsed details render only when opened. Stockmann and Silo derive circulation zones using the same shaft identity as rendering and routing (kind, name and position). Backrooms has an explicit circulation zone and one landing portal on each of the elevator’s five served floors. A single shaft object can therefore mean one zone member serving many floors. Circulation zones describe only lift/stair/escalator groupings; their count is not the number of spaces or connections in the building.

## Geometry, semantics and live state

| Layer | What it stores | How it changes |
| --- | --- | --- |
| Geometry | Shared junctions, physical/virtual boundaries, independent polygons and transport objects. | Validated transactions regenerate connected space outlines. |
| Ontology | Zone membership, portal endpoints, passage direction and expected crossing evidence. | Transactions update references; queries derive effective connections. |
| Live state | Current readings keyed by `feedId`. | Host snapshots replace the transient overlay; they do not rewrite the document. |

A zone groups existing spaces; it does not create their geometry. A portal describes a connection;
it does not cut a hole through a wall. A live reading describes an observation; it does not change
zone membership or the saved portal's passage direction.

## Zones

| Field | Meaning |
| --- | --- |
| `spaceIds` | Direct members; existing space IDs, potentially on different floors. |
| `childZoneIds` | Nested membership. Multiple parents are allowed; cycles are invalid. |
| `connects` | Optional cross-floor connectivity between members. See below. |
| `purpose` | Host vocabulary such as `security`, `evacuation` or `hvac`; no built-in policy. |
| `metadata` | Host-defined data attached to the zone. |

`zoneSpaces(project, zone)` expands nested membership. This forms a directed acyclic graph of
semantic groups, distinct from `SiteObject.parentId`: geometric containment has one parent, on
the same floor, whose footprint contains the child.

## Authoring zones

Make model changes inside `transact` or use `applyMutation` / `applyMutations`. Helpers such as
`addZone` mutate their argument, so pass the transaction draft rather than a live document.

```ts
import { addZone, spaces, transact, type ProjectDocument } from '@kerros/schema';

export function groupSpaces(project: ProjectDocument, name: string, spaceIds: string[]) {
  return transact(project, draft => {
    const known = new Set(spaces(draft).map(space => space.id));
    if (spaceIds.length === 0 || spaceIds.some(id => !known.has(id))) {
      throw new Error('Select existing spaces to group.');
    }
    addZone(draft, name, spaceIds);
  });
}
```

`addZone` filters out non-space IDs rather than throwing. This example checks required members
explicitly before calling it. `nestZone(draft, parentId, childId)` adds nested membership and
returns `false` if the relationship cannot be added, including a cycle.

Only replace and persist the project when the result has `ok: true`. Failed transactions preserve
the original; successful transactions synchronize shared geometry, validate and freeze the new
snapshot. `setZoneMembers`, `removeZone` and portal-group helpers follow the same draft convention.

## Portals

A portal has `id`, endpoint IDs `a` and `b`, and optionally `openingId`, `passage`, `attests`,
`name` and `metadata`. The opening remains a separate object, so geometry and device bindings can
refer to the same physical leaf. Several portals may refer to one opening where the model needs
multiple connections.

### Direction is asked, not stored

The stored `passage` permits `both` (default), `a-to-b`, `b-to-a` or `none`. “Entry” is relative to
a destination: `entryInto(portal, spaceId)` returns a permitted direction into that endpoint, or
`null`. A connection can enter one zone and leave another at the same time.

Use explicit endpoint IDs when mapping directional crossings into a host system. “Into zone A”
and “into zone B” can describe opposite directions through the same opening.

### Attestation and observations

`attests` describes expected crossing evidence; it is static model data, not a live event:

| Value | Intended interpretation |
| --- | --- |
| `confirmed` | The host expects a source capable of confirming a crossing. |
| `assumed` | A crossing may be inferred, for example from an access grant. This is the default. |
| `none` | No crossing evidence is claimed, as with an unobserved open passage or lift request. |

A door contact alone does not establish identity, direction or headcount. A lift call does not
establish arrival. Calculations based on crossing observations require actual host events and their uncertainty;
changing `attests` does not create that evidence.

### Portals are inferred from your plan

`inferPortals(project)` probes doors, gates and turnstiles for a space on each side. It skips
openings that it cannot resolve. `inferOpenBoundaries(project)` finds unwalled connections.
`refreshPortals(draft)` updates both in a transaction, retaining authored portals and annotations
on re-inferred portals with matching IDs.

Do not replace all stored portals with only the output of `inferPortals`: doing so discards
hand-authored connections and omits open passages. Reconciliation is identity-based. When a space,
opening or its endpoints change, review external bindings and directional annotations; their
meaning is not guaranteed to survive every redraw.

### Most connections have no door in them

Connected spaces use shared virtual edges for open passages. `effectivePortals(project)` combines
these derived connections with stored portals and respects authored sealed or one-way overrides.
It also drops stale inferred open connections when a physical wall replaces their shared virtual
edge. Routing, zone queries and Structure use this effective view.

Independent legacy outlines have a separate geometric open-boundary inference path. See
[space geometry](/guide/geometry) for connected and independent modes. If a room is unreachable,
inspect its virtual boundaries and circulation, as well as the presence of doors.

## Zone boundaries, derived

`perimeter(project, zone)` returns effective portals with exactly one endpoint inside the expanded
zone membership. `captive(project, zone)` returns those with both endpoints inside. These queries
include sealed portals; use `entryInto` when you need currently modelled passage directions.

Crossing a captive portal does not change membership of that particular zone. It can still cross
a nested zone's perimeter. Portal groups provide explicit named sets of portals when the set you
need is not the boundary of a zone.

## Walls and spaces

Connected spaces refer to shared junctions, walls and virtual boundaries. Their cached outlines
are regenerated by transactions. Use drawing and geometry mutations to split spaces, open a
passage or move a junction; do not edit both room rings and wall coordinates by hand.

New or resized usable spaces must meet the 1 m² minimum, independently of the 1 cm wall-segment
minimum. Openings must fit their host segments. Validation checks the resulting geometry and
references, but does not establish physical accessibility or source-drawing accuracy.

Merging spaces removes an identity. Choose the survivor and reconcile host bindings and
zone membership that referred to the absorbed space. The [geometry guide](/guide/geometry)
describes drawing, splitting, merging and the limits of validation.

## Lifts and stairs

Physical transport uses `SiteObject` kinds `elevator` and `stairs`, with geometry and
`servedFloorIds`. Escalators use `stairModel: 'escalator'` and `travel: 'up'` or `'down'`.
The model can represent one shaft serving multiple floors or corresponding per-floor objects.

Semantic circulation zones can describe connections between their cross-floor members:

| `connects` | Derived connectivity |
| --- | --- |
| `all` | Connections between each pair on different floors. |
| `adjacent` | Connections between consecutive members ordered by floor elevation. |
| `up` / `down` | Directed connections between adjacent members in elevation order. |

A zone does not replace transport geometry or its controller. A single multi-floor shaft requires
landing connections in the navigation model; do not assume that naming a zone “Lift” makes its
members rideable. For an authored graph, `chainVertical(draft, object)` creates the vertical nodes
and edges; connect its landing nodes to horizontal paths as well. For semantic derivation, keep
circulation zones and landing portals consistent with the actual transport.

`findRoute` computes a route without issuing commands. The optional `elevators` adapter on the
viewer or editor supplies a `statuses` array and `call(feedId, floorId)` / `hold(feedId, open)`
callbacks for passenger controls and playback. See [Routes and passenger lifts](./viewer#routes-and-passenger-lifts).

### A car with front and rear doors

Use an elevator object's `doorSides` to configure its physical cabin openings. Portals separately
connect the car/landing spaces to the relevant lobbies. Those destinations remain distinct even
when they share a car. The host’s `elevators` adapter supplies passenger commands and live car state.

## Navigation is derived from all this

`derivedGraph(project)` creates a space-level graph from effective portals and zone connectivity.
`navNodes` and `navEdges` return the authored graph when provided, or the derived graph otherwise.
Within-room path geometry is handled by the core room-navigation functions rather than maintained
as duplicate room outlines. See [navigation reference](/reference/schema#navigation).

Draw circulation spaces and connect each landing: an undrawn corridor provides no region for the
model to route through. A valid document may still contain isolated spaces. A non-null route does
not establish authorization or a step-free journey; those require host policy and additional checks.
`RouteOptions` accepts live `statuses` for escalators, but has no built-in permission or step-free
filter. A room’s zone membership does not constrain a route to that zone.

## Where the line is

The schema describes geometry, containment, membership and connectivity. Hosts own their business
rules, event history and device operations. Geometry, semantic declarations and live observations
are separate contracts; none should be treated as an automatic substitute for another.

See [Space geometry](./geometry), [Extending](./extending) and the
[schema reference](/reference/schema) for the corresponding APIs.
