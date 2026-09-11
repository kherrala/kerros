# Extending

Kerros keeps its contract small and pushes domain specifics to the host. The main extension seams:

## A custom status feed

The live-status contract is a single method:

```ts
interface StatusFeed {
  subscribe(project: ProjectDocument, listener: (statuses: StatusReading[]) => void): () => void;
}
```

Implement it against any telemetry source and map your domain onto `tone`, `label` and optional
`metrics` or `details`. Import `StatusFeed` and `StatusReading` from `@kerros/viewer/host` or
`@kerros/editor/host`.

Each notification is a complete snapshot, replacing previous readings. Accumulate incremental
backend events before publishing and release subscriptions when the host unmounts. The
[facility-monitoring guide](/applications/facility-monitoring#publish-complete-snapshots) provides a
typed, executable adapter for this contract.

## Carrying rich state with `details`

`tone` + `label` are all the viewer needs, but your own UI often needs more. Put anything extra in `details` — the library forwards it untouched:

```ts
// feed: emit rich state alongside the generic tone/label
{ feedId, tone: 'critical', label: 'Forced open', details: { lock: 'unlocked', contact: 'open' } }

// your status panel: cast it back
const { lock, contact } = status.details as MyDoorState;
```

## Categories & metadata

Attach host-defined data to an object or barrier inside a transaction draft. For example, after
finding the required draft object:

```ts
object.category = 'meeting-room';                // a host subtype
object.metadata = { asset: 'MR-14', seats: 8 };
```

`category` drives `mapStyle.objectColor`, becomes a `cat-<category>` CSS class and a `data-category` attribute on the plan marker, and — with `metadata` — is available in `onSelect` / `onHoverObject` handlers. Model your own subtypes (a door variety, a sensor class, a tenancy code…) and any domain extension as **data**, not new object kinds.

## Injecting your own controls

The optional `elevators` prop enables passenger controls in Walk (see [the editor guide](./editor#elevators-and-music)). Render other domain-specific commands for a selected bound object via `renderStatusPanel`:

```tsx
<FloorEditor …
  renderStatusPanel={({ object, status, editing, live }) =>
    <MyControls feedId={object.feedId!} status={status} enabled={live} />
  }
/>
```

## Custom basemaps

Any MapLibre style works underneath the plan. Provide a `BasemapConfig`
(`{ style, transformRequest?, styleTransform?, label?, vectorSchema? }`) as `adapters.basemap`
(editor) or the `basemap` prop (viewer). `neutralBasemap` is the offline default. Describe the
provider's building and parcel layers in `vectorSchema` to enable adoption, cadastre and 3D city
features. See [MML vector maps](./mml-maps) for a complete reference configuration and API-key setup.

See [Application guides](/applications/) for access control, ONVIF, reservations, visitors and wayfinding.
