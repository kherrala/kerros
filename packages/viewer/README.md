# @kerros/viewer

An embeddable React viewer for Kerros projects with 2D, 3D, first-person movement, structure views,
live statuses, indoor routes, and journey playback.

```sh
npm install @kerros/viewer maplibre-gl three react react-dom
```

```tsx
import { FloorViewer, emptyProject } from '@kerros/viewer';
import { setWorkerUrl } from 'maplibre-gl';
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import '@kerros/viewer/styles.css';

setWorkerUrl(maplibreWorkerUrl);
const project = emptyProject([24.938, 60.169], 'Example building');

export function App() {
  return <FloorViewer project={project} controls />;
}
```

The worker import above is for Vite. Configure the MapLibre worker with the equivalent mechanism for
your bundler before rendering a Kerros map.

The `@kerros/viewer/host` entry point exposes persistence, theming, status, and schema utilities
without loading the map renderer. See the [viewer reference](https://github.com/kherrala/kerros/blob/main/docs/reference/viewer.md),
[getting-started guide](https://github.com/kherrala/kerros/blob/main/docs/guide/getting-started.md), and
[changelog](https://github.com/kherrala/kerros/blob/main/CHANGELOG.md).

MIT licensed.
