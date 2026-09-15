# Extending

Kerros keeps its contract small and pushes domain specifics to the host. The main extension seams:

## A custom status feed

Import `StatusFeed` and `StatusReading` from `@kerros/viewer/host` or `@kerros/editor/host`.
`StatusFeed.subscribe(project, listener)` subscribes to complete current snapshots and returns an
unsubscribe function. Notifications replace previous readings; they are not incremental events.

This source-independent adapter holds the latest snapshot and publishes only readings bound to
the subscribing project's objects. Create it once per host session:

<<< ../snippets/status-feed.ts

Call `publish(readings)` with the full current set. For an event-based source, first accumulate the
latest reading for each feed in your host. Publishing `[]` clears the overlay. Use actual observation
timestamps so forwarding an old reading does not make it appear fresh.

The editor accepts the feed as `adapters.status`. For `FloorViewer`, subscribe in the host and
pass the resulting `statuses` array; the viewer has no `statusFeed` prop. Unsubscribe when the
project or feed changes and on unmount. See [Live status](./viewer#live-status).

## Carrying rich state with `details`

`tone` + `label` are all the viewer needs, but your own UI often needs more. Put anything extra in `details` — the library forwards it untouched:

```ts
// feed: emit rich state alongside the generic tone/label
{ feedId, tone: 'critical', label: 'Forced open', details: { lock: 'unlocked', contact: 'open' } }

// after validating the host payload, read it in your status panel
const { lock, contact } = status.details as MyDoorState;
```

## Categories & metadata

Attach host-defined data to an object or barrier inside a transaction draft. For example:

```ts
import { transact, type ProjectDocument } from '@kerros/schema';

export function setObjectCategory(project: ProjectDocument, objectId: string, category: string) {
  return transact(project, draft => {
    const object = draft.objects.find(object => object.id === objectId);
    if (!object) throw new Error('Object not found.');
    object.category = category;
  });
}
```

Assign `metadata` on the draft in the same way. Persist and publish the returned project only when
`result.ok` is true; an unsuccessful transaction leaves the original unchanged.

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
