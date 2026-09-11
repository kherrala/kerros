# ONVIF integration

Use the floor plan as the spatial model for a host that integrates ONVIF devices. Protocol clients,
device discovery, credentials, subscriptions and command authorization belong in that host.
Kerros does not ship an ONVIF implementation or claim profile conformance.

## Choose the device capabilities

ONVIF separates door control and events ([Profile C](https://www.onvif.org/profiles/onvif-profile-c/)),
credentials, schedules and access-rule configuration
([Profile A](https://www.onvif.org/profiles/onvif-profile-a/)), and access peripherals such as readers
and locks ([Profile D](https://www.onvif.org/profiles/profile-d/)). Choose profiles and operations
according to the actual device and client capabilities; see the official
[profile catalogue](https://www.onvif.org/profiles/).

## Maintain an explicit binding table

The following is an application mapping, not a replacement for the ONVIF service schema:

| Plan concept | Host integration |
| --- | --- |
| `SiteObject.id` and `feedId` | Bind an object to a device/channel and the source of its live state. |
| Door, gate or turnstile object | Associate a physical opening with the appropriate door-control resource. |
| Directional portal crossing | Associate a from/to-space crossing with an access point and reader direction. |
| `Zone` and expanded `spaceIds` | Describe host areas used when evaluating destination access. |
| Camera or reader `watchedIds` | Store authored associations to objects; resolve device resources in the host. |
| `metadata` | Carry opaque asset references or domain labels, without embedding device secrets. |

Use the [directional crossing helper](./access-control#project-directional-crossings) to derive
permitted directions. A portal can reference one opening while yielding two directed crossings.
Map their host keys to protocol tokens explicitly. Open-boundary crossings have no opening to
control; preserve them when assessing whether a zone is physically enclosed.

When zones overlap, the same directed crossing may occur in several zone projections. Merge by
its key and retain the relevant zone memberships. Regenerate and reconcile this mapping after
the plan changes, including endpoint changes, rather than silently reassigning an existing reader.

## Turn device events into map state

Aggregate backend notifications into `StatusReading` snapshots. For example, a door contact can
update `open`, while an alarm changes `tone` and `label`. Keep source-specific event data in your
event store; expose selected details through `details`. The
[monitoring adapter](./facility-monitoring#publish-complete-snapshots) demonstrates the UI contract.

Do not promote a contact notification into an identified crossing merely because a portal is
marked `attests: 'confirmed'`. Actual evidence depends on the equipment and event semantics.
Credentials presented, access granted, a leaf opening and a person crossing are distinct events.

## Camera coverage and commands

Place camera objects and configure their `coverageAngle` and `coverageRange` to visualize intended
coverage. `watchedIds` associates selected objects with a device; it does not prove line of sight,
recognition accuracy or absence of occlusion. Store VMS stream references in the host and resolve
them into authorized playback sessions when a user selects a camera.

Issue lock, unlock and other hardware commands through your backend. The map selects the target
and displays the reported outcome; it does not substitute for the controller's policy or protocol
state machine. Follow the relevant ONVIF service specifications and conformance requirements for
the integration you actually implement.
