# Visitor management

Use spaces for reception, meeting rooms and circulation, and a semantic zone to describe a visit's
destinations. Keep the visitor, host employee, invitation, credential and validity window in your
application database, referring to plan IDs.

## Create a visit area

This helper rejects missing or non-space IDs before adding a zone. The underlying `addZone` helper
filters non-space selections, which is convenient in an editor; a booking workflow usually needs
to report that a requested destination has disappeared.

<<< ./visitorZone.ts

Check `result.ok` before replacing and saving the live project with `result.project`. A refusal
leaves the original document unchanged. For many short-lived visits, reuse persistent destination
zones and store visit-specific membership in the host rather than creating a saved zone per guest.

## Check the journey

Route from a reception space or a `{ floorId, position }` starting point to the destination with
`findRoute`. A `null` result means the model cannot provide a path. Inspect missing circulation
spaces, open boundaries and vertical connections using **Structure → Topology**.

A non-null route can pass through other spaces. Validate the whole journey against the visit's
permissions, including any lift landing and restricted corridor. Zone membership alone neither
constrains the route nor grants passage. The current `RouteOptions` accepts live statuses, not an
authorization predicate; implement policy filtering in your host when required.

## Track arrival and departure

Display expected, arrived or departed state through a status feed bound to the appropriate object.
Record check-in, escort association and access events in the host. A confirmed crossing capability
does not prove an escort was present, and a lift destination request does not establish arrival.

Expire permissions in the policy service when the visit ends. If a destination is removed or split,
reconcile the invitation's plan references before issuing further access or route instructions.
See [access control](./access-control) for directional perimeter mapping.
