# Construction sites

Model the outdoor site with spaces on `floorId: null`. Give temporary buildings their own floors,
and use appropriate area objects such as offices, containers and storage spaces. Keep the project
origin fixed so local metre coordinates remain comparable across revisions.

## Describe changing areas

Use semantic zones for a controlled site, contractor work areas, storage compounds and muster
areas. Nest zones with `childZoneIds` when one grouping includes another. Unlike geometric
`SiteObject.parentId` containment, semantic membership may span floors and disconnected areas.

Draw fences and attach gates where people can cross. A fence does not automatically divide an
outdoor space; represent the areas on either side if routing or zone membership needs that
distinction. Model the public approach as a real space too, so an entrance has resolvable endpoints.

Update geometry and zone membership through transactions. Keep an area's ID when it remains the
same operational place; when it is replaced, split or merged, reconcile external work permits and
bindings explicitly. Retain document revisions in the host to explain what an event referred to
at the time it occurred.

## Monitor gates and equipment

Bind gates, cameras, sensors and equipment through `feedId`, and show alarms or availability using
[status snapshots](./facility-monitoring). A `watchedIds` association identifies intended device
coverage; it does not establish that a person or vehicle was actually observed.

For site entry, derive directional perimeter crossings as in [access control](./access-control).
An unwalled boundary is still a possible crossing even when there is no controllable gate.

## Muster and route planning

A muster point can be a space, optionally in a zone with purpose `evacuation`. That label does not
apply evacuation policy or certify a route. Keep headcounts and their uncertainty in the host;
neither `attests: 'confirmed'` nor a gate contact supplies a complete occupant list.

After each layout change, check routes from occupied areas to the intended exits and muster point.
Kerros validates model geometry and graph references, while site-specific egress constraints,
temporary hazards and permissions need additional host checks.
