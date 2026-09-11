# Space reservations

Use a space ID as the reference from a booking to its room. Store reservations, recurrence,
availability and user identity in the host. A plan revision changes the room's geometry; it should
not also rewrite the booking ledger.

## Describe reservable spaces

Use `SiteObject.category`, for example `meeting-room`, and host-defined `metadata` such as an asset
reference or seating capacity. Set these fields inside `transact` or with `patchObject` mutations.
`objectArea(space)` gives geometric area in square metres; it is not an approved occupancy limit
or a reliable way to infer the number of seats.

Publish availability through a bound `feedId`. A reading might carry `label: 'Reserved until 15:00'`
and a `details` object containing the reservation ID. The
[monitoring guide](./facility-monitoring) explains snapshot updates and custom status panels.

## Connect bookings to access

Resolve a booking's room and any required circulation into host permissions. A semantic zone can
group a suite of bookable spaces; `perimeter` derives its crossings. The reservation service decides
the validity window and coordinates with the access-control service. Neither zone membership nor
a live label grants a visitor access.

Check the route from the expected entrance, including intervening spaces and vertical transport.
A destination that is reachable in the general building graph may require additional permissions.

## Operable partitions

Keep two spaces separate when bookings must retain their identities while a partition opens.
Represent the physical open state with an actual opening or virtual boundary and update affected
connections through a validated transaction. Setting a portal's `passage` alone does not cut a
hole in a wall or change its rendered geometry.

If the rooms are permanently merged, choose the surviving space and reconcile future bookings,
zone memberships and external references to the absorbed ID. A geometric merge cannot decide
whether two reservations conflict or which customer should retain the room.
