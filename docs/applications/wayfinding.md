# Indoor wayfinding

`@kerros/schema` routes between object IDs or positions without a renderer. The viewer adds a map,
floor selection, route instructions and playback. The same model can serve a public kiosk, a
facility application or a server-side route service.

## Start with a connected plan

This complete example creates two spaces separated by a virtual boundary and routes between
them. The transaction builds their shared geometry; it does not maintain duplicate room outlines
or add a fictional door to connect the cafe.

<<< ./connectedPlan.ts

The returned document is valid and frozen. Persist successful changes using your host repository;
the pure schema functions do not save them. See the [portable format](/reference/portable-format)
for exchanging the result with other tools.

## Include circulation and openings

Draw corridors, lobbies and open departments as spaces. For connected geometry,
`effectivePortals(project)` includes shared virtual boundaries even when no corresponding portal
was stored. Door, gate and turnstile inference needs a resolvable space on either side; windows
are not walking connections. Re-read opening connections with `refreshPortals` inside a transaction
after relevant plan edits. Independent legacy outlines also have an open-boundary inference path.

`derivedGraph` exposes space-level connectivity. `navNodes` and `navEdges` expose the graph used by
routing. The core room-navigation functions resolve paths within the room geometry. An explicit
`navNodes`/`navEdges` graph replaces the derived accessors, so the host must keep authored graph
geometry and connectivity in sync. Prefer derivation unless the application needs that control.

For a kiosk, start from a placed object ID or `{ floorId, position, name: 'You are here' }`.
`findRoute` returns `null` when it cannot anchor an endpoint or find a path. In the viewer's
**Structure → Topology** tab, inspect isolated nodes and use **Open graph view** to examine
connections. Review the actual route, not just whether endpoints have graph edges.

## Floors, stairs and escalators

Create actual `elevator` and `stairs` objects with the correct position, footprint and
`servedFloorIds`. The floor elevations define their rise. Escalators are stairs with
`stairModel: 'escalator'` and `travel: 'up'` or `'down'`. The direction must agree with the intended
flight; a pair needs two objects. `wellGroup` can group their shared opening.

Semantic circulation zones group shafts or landing spaces. `connects: 'all'` describes cross-floor
pairwise connectivity, `adjacent` links consecutive elevations, and `up`/`down` describes directed
adjacent connections. These declarations do not create a physical stair flight or an operable
elevator. Connect the actual transport to the surrounding circulation on each served floor.

When supplying an authored navigation graph, `chainVertical` can build transport edges, but the
host must connect its landing nodes to the horizontal paths too. Inspect both ascent and descent,
as well as partial mezzanines and below-ground floors.

## Passenger lifts

A call to `findRoute` computes a route; it does not operate a lift. To support passenger controls
and route playback, give the viewer or editor the `elevators` adapter, with a current `statuses`
array and the `call(feedId, floorId)` and `hold(feedId, open)` callbacks. Bind the elevator object's
`feedId` to that same controller and report its car position, door and travel state.

The host forwards calls to a controller or simulator and reports the resulting state. Playback
can then call the lift, wait to board, request the destination and leave at the served floor.
The reference host demonstrates this integration; see [Routes and passenger lifts](/guide/viewer#routes-and-passenger-lifts).

`findRoute(..., { statuses })` uses current escalator direction and stopped state when available.
Live statuses are not a general closure or authorization policy API.

## Permissions and accessible journeys

Route options currently expose `statuses`; there is no built-in permission or step-free filter.
A public kiosk must apply its own destination and route policy. For a strict step-free route,
derive an appropriate graph in the host or use a policy-aware router, excluding unusable transport
and checking widths, thresholds and other application requirements. Reject an unsuitable route
rather than presenting an unfiltered shortest path as accessible.

Likewise, membership in a visitor zone does not keep a route within that zone. Evaluate the full
journey, including intermediate circulation and landings. See [visitor management](./visitor-management).
