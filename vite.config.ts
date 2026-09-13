import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/** Which chunk a module belongs to, keyed by a fragment of its resolved id; first match wins.
 *
 *  Left alone, Rollup puts everything the two entries share into one anonymous chunk and names it
 *  after whichever module inside it it happened to pick — which is how 2 MB of maplibre, three and
 *  the model layer came to be served as `reset-*.js`, named after `app/reset.css`. Naming the heavy
 *  dependencies here buys a filename that says what is in it and a cache entry per library, so
 *  editing app code stops invalidating maplibre and three along with it.
 *
 *  The test is a plain substring match, so `react-dom` has to be listed ahead of `react`. pdfjs is
 *  deliberately absent: it is reached only through the `import('pdfjs-dist')` in ImportDialog, and
 *  it should stay that way. */
const CHUNKS: ReadonlyArray<readonly [marker: string, chunk: string]> = [
  // The toolkit's own layers. `src/map` is the whole MapLibre-and-three rendering surface and
  // nothing in `src/model` imports back into it, so the two split cleanly; keeping them apart means
  // a change to the document model does not invalidate the renderer's cache entry, and the build
  // table finally names what it is serving.
  // The 3D renderer, ahead of the blanket `/src/map/` rule below. Every module here is reachable
  // only through SceneLayer, and SceneLayer only through the dynamic import in MapCanvas — so left
  // in `map` they would drag three.js in with the map itself, and a plan shown flat would pay for a
  // renderer it never runs. The reference apps happen to open in 3D, but they are the reference:
  // what they demonstrate is what a host copying them gets.
  //
  // A list rather than a pattern, because "uses three" is not something a path can say. `make budget`
  // fails if the `map` chunk acquires three again, which is what makes the list safe to keep.
  ['/src/map/SceneLayer', 'scene'],
  ['/src/map/FixtureLights', 'scene'],
  ['/src/map/UndergroundContext', 'scene'],
  ['/src/map/architecture', 'scene'],
  ['/src/map/materials', 'scene'],
  ['/src/map/projection', 'scene'],
  ['/src/map/surfaces', 'scene'],
  ['/src/map/textures', 'scene'],
  ['/src/map/water', 'scene'],
  ['/src/map/', 'map'],
  ['/src/model/', 'model'],
  ['/src/schema/', 'model'],
  ['/src/adapters/', 'adapters'],
  ['/src/theme/', 'adapters'],
  ['/src/i18n', 'adapters'],
  ['/node_modules/maplibre-gl/', 'maplibre'],
  ['/node_modules/three/', 'three'],
  ['/node_modules/react-dom/', 'react'],
  ['/node_modules/react/', 'react'],
  ['/node_modules/scheduler/', 'react'],
  ['/node_modules/lucide-react/', 'icons'],
  ['/node_modules/polygon-clipping/', 'clipping'],
  ['/node_modules/robust-predicates/', 'clipping'],
  ['/node_modules/splaytree/', 'clipping'],
  ['/node_modules/proj4/', 'proj4'],
  ['/node_modules/mgrs/', 'proj4'],
  ['/node_modules/wkt-parser/', 'proj4'],
];

const chunkFor = (id: string): string | undefined => {
  // Every real stylesheet in the build — the app's own and maplibre's — belongs in one file. Vite
  // drops the empty JS shell a CSS-only chunk leaves behind, so this only renames the CSS. The
  // query-string ids are Vite's html-proxy modules for the `<style>` block inside index.html; the
  // dev hub is deliberately self-contained, and folding its inline CSS in here would make it link
  // the app's 126 kB stylesheet instead.
  if (id.endsWith('.css')) return id.includes('?') ? undefined : 'styles';
  // Vite's dynamic-import preload helper is a virtual module, and left alone Rollup files it under
  // whichever chunk reaches it first. When MapCanvas started naming SceneLayer with a dynamic import
  // that became `map` — and since every entry needs the helper the instant it names a lazy import,
  // a chunk holding maplibre and three went eager and the hosts' payload went back to 2 MB. It has
  // no business living anywhere but with the small things both pages load regardless.
  if (id.includes('vite/preload-helper')) return 'adapters';
  return CHUNKS.find(([marker]) => id.includes(marker))?.[1];
};

/** Chunks Rollup was told to make, as opposed to the ones it invents for shared code. */
const NAMED = new Set([...CHUNKS.map(([, chunk]) => chunk), 'styles']);

/** The facades the reference hosts reach through a dynamic import, by the module each chunk fronts.
 *
 *  Both are called `index.ts`, as is the dev hub's `index.html`, so left alone the build serves
 *  three different chunks named `index`. Renaming them here rather than through `manualChunks` is
 *  deliberate: pinning a facade to a manual chunk drags the shared modules underneath it — chiefly
 *  StructureView, which the viewer host also uses directly — into that chunk, and the map comes back
 *  into the eager graph with them. This only changes the filename. */
const FACADES: ReadonlyArray<readonly [module: string, chunk: string]> = [
  ['/src/editor/index.ts', 'editor'],
  ['/src/viewer/index.ts', 'floor-viewer'],
];

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // The `/host` subpaths come first: Vite matches a string alias against the start of the id, so
      // a bare '@kerros/editor' listed above them would swallow '@kerros/editor/host' too.
      '@kerros/viewer/host': fileURLToPath(new URL('src/viewer/host.ts', import.meta.url)),
      '@kerros/editor/host': fileURLToPath(new URL('src/editor/host.ts', import.meta.url)),
      '@kerros/schema': fileURLToPath(new URL('src/schema/index.ts', import.meta.url)),
      '@kerros/import': fileURLToPath(new URL('src/import/index.ts', import.meta.url)),
      '@kerros/viewer': fileURLToPath(new URL('src/viewer/index.ts', import.meta.url)),
      '@kerros/editor': fileURLToPath(new URL('src/editor/index.ts', import.meta.url)),
    },
  },
  build: {
    rollupOptions: {
      // Naming `input` replaces Vite's implicit `index.html` entry, so the dev hub has to be listed
      // back explicitly or `dist/` ships without a root page and `vite preview` 404s at `/`. The
      // published site overwrites it with the docs home afterwards (see the build:site script).
      input: {
        index: fileURLToPath(new URL('index.html', import.meta.url)),
        app: fileURLToPath(new URL('app.html', import.meta.url)),
        viewer: fileURLToPath(new URL('viewer.html', import.meta.url)),
      },
      output: {
        manualChunks: chunkFor,
        // What is left over once the rules above have run is, by definition, the odds and ends the
        // two hosts happen to share. Rollup names such a chunk after an arbitrary module inside it,
        // which is how the old bundle came to be called `reset-*.js`; say what it actually is
        // instead. Entries and dynamic-import chunks already carry a name worth keeping.
        chunkFileNames: chunk => {
          const facade = chunk.facadeModuleId;
          const named = facade && FACADES.find(([module]) => facade.endsWith(module))?.[1];
          if (named) return `assets/${named}-[hash].js`;
          return chunk.isEntry || chunk.isDynamicEntry || NAMED.has(chunk.name)
            ? 'assets/[name]-[hash].js'
            : 'assets/shared-[hash].js';
        },
      },
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'app/**/*.test.ts'],
    /* app/demo integration tests build the full 1300-object campus; under parallel load they cross
       vitest's 5s default, which read as a phantom validation flake */
    testTimeout: 30_000,
  },
} as Parameters<typeof defineConfig>[0]);
