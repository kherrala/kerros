# Facility monitoring

Bind a room, sensor, door or lift to an external source using `SiteObject.feedId`. The source can
be a building-management system, a booking service or a device gateway. The plan keeps the binding;
the host supplies current readings and owns event history.

## Publish complete snapshots

`StatusFeed.subscribe(project, listener)` returns an unsubscribe function. Each notification
replaces the current set of readings. If your backend sends individual events, accumulate them in
a host-side map before publishing its values. An empty snapshot clears live state.

This adapter holds the latest snapshot, filters it to the subscribed project and releases listeners
on unsubscribe. Construct it once per host session, rather than inside each React render.

<<< ./snapshotFeed.ts

Call `publish` with readings such as `{ feedId: 'room-14', tone: 'normal', label: '3 people',
metrics: { occupancy: 3, capacity: 8 }, timestamp: Date.now() }`. Use the actual observation time
when forwarding backend data, so old observations do not appear fresh.

## Connect the viewer

Subscribe in the viewer host and pass the resulting `statuses` array. The viewer does not take a
`statusFeed` prop. An editor host instead supplies `adapters.statusFeed`.

<<< ./MonitoredPlan.tsx

The optional viewer `controls` provide floor selection, structure, navigation graph, routes and
view modes. See [viewer integration](/guide/viewer).

`tone` and `label` drive the display. `metrics` carries common measurements and `details` can
carry a host-defined payload. Validate that payload at your service boundary before using it in
custom UI. Use `renderStatusPanel` for host actions and details; authorize commands in the backend.

## Doors, lifts and observation

`open` describes the current door leaf state. Lift readings can include `carFloorId`,
`targetFloorId` and `moving`; escalators use `running` and `travel`. These animate equipment and,
where supported, inform route playback. They do not change the saved portal's `passage` or grant
access to a user. [Wayfinding](./wayfinding#passenger-lifts) describes the lift command adapter.

A room's `metrics.occupancy` is a host measurement. A portal's `attests` field describes expected
crossing evidence; it is not a count or a live event. A door contact alone does not identify a
person or count everyone crossing an open doorway.

Keep device secrets and stream credentials in the host backend. The portable document can carry
opaque asset references in `metadata`, while the backend resolves those references for an
authorized session. [ONVIF integration](./onvif) shows one device-system mapping.
