# Getting started

Kerros is an indoor-mapping toolkit shipped as four composable packages:

| Package | What it is | Depends on |
| --- | --- | --- |
| **`@kerros/schema`** | The data model and pure operations — geometry, validation, routing. No React, no MapLibre, no browser storage. | — |
| **`@kerros/viewer`** | `FloorViewer`, a read-only 2D/3D floor viewer, plus the live-status contract. | React, MapLibre, Three.js |
| **`@kerros/editor`** | `FloorEditor`, browser adapters and browser-safe CAD/SVG conversion. | React, MapLibre, Three.js |
| **`@kerros/server`** | PDF/DWG extraction, OpenCV/OCR analysis and streamed AI import. | Node.js 22+; native analysis tools as needed |

The viewer and editor re-export the schema APIs. The server is a separate optional package; its
heavy extraction and analysis dependencies stay out of browser bundles. See the
[server reference](/reference/server) and [CAD conversion API](/reference/import) for the boundary.

## Installation

```sh
npm install @kerros/viewer maplibre-gl three react react-dom
```

`react`, `react-dom`, `maplibre-gl` and `three` are peer dependencies — Kerros uses the copies your app already has.

Import the stylesheet once (it bundles MapLibre's own CSS):

```ts
import '@kerros/viewer/styles.css';
```

## Embed the viewer

The viewer renders a `ProjectDocument`. The quickest way to get one is `parseExport`, which reads a portable Kerros JSON export:

```tsx
import { createRoot } from 'react-dom/client';
import { FloorViewer, parseExport } from '@kerros/viewer';
import '@kerros/viewer/styles.css';

const { project, assets } = parseExport(await (await fetch('/site.json')).text());

createRoot(document.getElementById('app')!).render(
  <FloorViewer project={project} assets={assets} threeD showLabels />,
);
```

That's a complete, read-only floor plan in 2D or 3D. See [The viewer](./viewer) for the full prop list.

## Embed the editor

The editor needs a few host **adapters** — where projects and images are stored, and (optionally) a live status feed and a basemap:

```tsx
import { FloorEditor, LocalProjectRepository, IndexedAssetRepository, emptyProject, geoOrigin } from '@kerros/editor';
import '@kerros/editor/styles.css';

const adapters = { projects: new LocalProjectRepository(), assets: new IndexedAssetRepository() };
const project = emptyProject(geoOrigin([24.94, 60.17]), 'My site');

<FloorEditor project={project} adapters={adapters} />;
```

See [The editor](./editor) for adapters, modes, deep links and the status-panel slot.

## Build a project in code

To run the reference applications, start with [the Docker development stack](./development): `make up` runs the apps, documentation and importer. The [MML vector maps](./mml-maps) and [Import features](./ai-import) guides link to the optional API-key setup.

`@kerros/schema` is a pure, framework-free core. This complete example creates two connected spaces,
separates them with a virtual boundary and computes a route through their open passage:

<<< ../snippets/connected-plan.ts

Call `createConnectedPlan()` to get the validated, frozen `project`, its two spaces and the route.
All positions are local metres. `applyMutations` applies the sequence atomically and synchronizes
the shared geometry; there are no duplicate room outlines to maintain.

Schema operations do not save the document. Persist successful changes through your host or export
them using the [portable format](/reference/portable-format). Continue with [Core concepts](./concepts)
and [Space geometry](./geometry).
