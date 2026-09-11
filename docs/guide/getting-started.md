# Getting started

Kerros is an indoor-mapping toolkit shipped as three composable packages:

| Package | What it is | Depends on |
| --- | --- | --- |
| **`@kerros/schema`** | The data model and pure operations — geometry, validation, routing. No React, no MapLibre, no browser storage. | — |
| **`@kerros/viewer`** | `FloorViewer`, a read-only 2D/3D floor viewer, plus the live-status contract. | React, MapLibre, Three.js |
| **`@kerros/editor`** | `FloorEditor`, the full authoring editor, plus browser adapters. | everything in viewer |

Each package re-exports everything from the one below it, so you only install what you use.

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

const adapters = { projects: new LocalProjectRepository(), assets: new IndexedAssetRepository(), status: { subscribe: () => () => {} } };
const project = emptyProject(geoOrigin([24.94, 60.17]), 'My site');

<FloorEditor project={project} adapters={adapters} />;
```

See [The editor](./editor) for adapters, modes, deep links and the status-panel slot.

## Build a project in code

`@kerros/schema` is a pure, framework-free core — you can construct and route projects with no DOM at all (a server, a CLI, a mobile backend):

```ts
import { emptyProject, createObject, geoOrigin, findRoute } from '@kerros/schema';

const p = emptyProject(geoOrigin([24.94, 60.17]), 'Office');
// …add floors, rooms, doors, a nav graph…
const route = findRoute(p, fromId, toId);
```

No DOM, no React, no MapLibre — the core is a pure library, equally usable on a server or from a CLI. Continue with [Core concepts](./concepts).
