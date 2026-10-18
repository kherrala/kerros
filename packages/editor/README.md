# @kerros/editor

The React authoring interface for Kerros projects, including floor-plan drawing, geometry editing,
browser persistence adapters, reference images, and browser-safe CAD conversion.

```sh
npm install @kerros/editor maplibre-gl three react react-dom
```

```tsx
import { FloorEditor, IndexedAssetRepository, LocalProjectRepository, emptyProject } from '@kerros/editor';
import { setWorkerUrl } from 'maplibre-gl';
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import '@kerros/editor/styles.css';

setWorkerUrl(maplibreWorkerUrl);
const project = emptyProject([24.938, 60.169], 'Example building');
const adapters = {
  projects: new LocalProjectRepository(),
  assets: new IndexedAssetRepository(),
};

export function App() {
  return <FloorEditor project={project} adapters={adapters} />;
}
```

The worker import above is for Vite. Configure the MapLibre worker with the equivalent mechanism for
your bundler before rendering a Kerros map.

Use `@kerros/editor/host` for persistence, theming, schema, and CAD conversion helpers without the
map renderer. See the [editor reference](https://github.com/kherrala/kerros/blob/main/docs/reference/editor.md),
[getting-started guide](https://github.com/kherrala/kerros/blob/main/docs/guide/getting-started.md), and
[changelog](https://github.com/kherrala/kerros/blob/main/CHANGELOG.md).

MIT licensed.
