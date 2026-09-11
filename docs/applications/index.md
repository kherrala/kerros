# Application guides

Build applications around one connected floor plan. These guides show how the current schema,
viewer and editor fit into a host product, with code examples that use the public package APIs.

| Application | What the guide covers |
| --- | --- |
| [Facility monitoring](./facility-monitoring) | Bind assets to live readings, publish snapshots and add host controls. |
| [Access control](./access-control) | Derive zone boundaries and directional crossings for a separate policy service. |
| [ONVIF integration](./onvif) | Map plan identities to device and access-system identities. |
| [Visitor management](./visitor-management) | Group visit destinations, check routes and manage time-limited host permissions. |
| [Space reservations](./space-reservations) | Attach bookings, capacity and partition state to spaces. |
| [Construction sites](./construction-sites) | Represent outdoor areas, temporary buildings and changing zone membership. |
| [Indoor wayfinding](./wayfinding) | Route through open-plan spaces and between floors, including passenger lifts. |

## Choose the packages

Use `@kerros/schema` for document processing, validation, topology and routing in a browser, server
or CLI. Add `@kerros/viewer` for read-only maps and `@kerros/editor` for authoring. Their `/host`
entry points expose host integration contracts. Use `@kerros/server` when you need PDF/DWG
extraction, OpenCV/OCR or AI import; those dependencies stay on the server.

Start with [Getting started](/guide/getting-started), [space geometry](/guide/geometry) and
[spaces, zones and portals](/guide/ontology). The [portable format](/reference/portable-format)
describes how third-party tools exchange the model.

## Keep responsibilities explicit

The project stores geometry, semantic membership, connections and stable host bindings. Edit it
through `transact` or `applyMutations`, then publish and persist the successful result. Connected
space outlines are generated from shared boundaries; changing their cached `rings` directly is
not an authoring operation.

The host stores users, credentials, bookings, event history and authorization rules. Live readings
arrive through `StatusFeed` and do not rewrite the saved plan. A valid route establishes modelled
connectivity; the host decides whether a particular person may follow it.

The examples are integration building blocks. The reference editor and viewer are available under
**Demos**; domain-specific services described here are supplied by the application developer.
