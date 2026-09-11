# Access control

Describe the building with spaces, zones and portals, then derive the crossings your policy service
needs. Kerros supplies that topology; the host supplies identities, credentials, schedules, grants
and enforcement.

## Group destinations

An office tenancy can contain an open-plan space and a nested server-room zone. `zoneSpaces`
expands that membership. Nesting does not inherit permissions: a host may grant tenancy access
while requiring a separate permission for the server room.

Use `perimeter(project, zone)` to find connections with exactly one endpoint in the zone.
`captive(project, zone)` finds connections wholly within it. A connection can be captive to the
tenancy while on the server room's perimeter, so it can still need a separate control rule.

These queries use `effectivePortals`, including shared virtual boundaries. Looking only at
`project.portals` can omit an unwalled passage and falsely suggest that a zone is enclosed.

## Project directional crossings

One portal records two endpoints. `entryInto(portal, destinationSpaceId)` resolves a permitted
direction or returns `null` for a sealed or wrong-way crossing. Use it when deriving host records:

<<< ./directionalCrossings.ts

Keys include the portal and both endpoint IDs. Naming records only `portal:in` and `portal:out`
would collide when the same door is viewed from two adjacent zones: entering one is leaving the
other. The key above is a host identity, not an ONVIF device token.

The helper intentionally includes open boundaries without `openingId`. They matter when reviewing
a zone's perimeter even though no lock or reader can be inferred there. Bind controlled openings
to actual hardware in your host configuration; not every door is access-controlled.

## Apply policy in the host

Store grants against the appropriate zone, destination or directional crossing. Evaluate the
current person, schedule and required permissions on the backend before issuing a device command.
Define how overlapping zone rules combine; the schema does not prescribe an allow/deny policy.

`passage` expresses modelled traversability, not a user's temporary grant. A status reading with
`open: true` reports a leaf position and does not override a sealed portal. A successful
`findRoute` establishes connectivity only. If a route must remain in permitted areas, evaluate
its full path or use a host policy-aware graph; checking only the endpoints is insufficient.

## Reconcile changes and events

Edit zones and portal annotations through [transactions](/reference/schema#validity-transactions).
`refreshPortals(draft)` retains authored portals and carries annotations onto re-inferred portals
with matching IDs. Deleted or replaced geometry may change IDs or endpoint membership. Reconcile
external bindings after structural edits instead of assuming that a redraw preserves policy.

`attests` is a static declaration of evidence quality. A grant is not a crossing observation, and
a door opening does not prove identity, direction or headcount. Occupancy and anti-passback logic
need the host's actual event stream, ordering, reconciliation and uncertainty handling. Lift calls
and destination requests alone cannot establish where a passenger went.

Continue with [ONVIF integration](./onvif) or [visitor management](./visitor-management).
