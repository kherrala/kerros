import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import { browserServerBoundary } from '../../scripts/browser-boundary';

// Library build: bundles the shared src/ closure behind this package's facade; framework and
// heavyweight rendering dependencies stay external (declared as peer/regular deps below).
export default defineConfig({
  plugins: [browserServerBoundary()],
  build: {
    // Two entries: the facade, and the map-free `./host` subpath a consumer imports when it only
    // wants persistence or theming. Their shared closure lands in a chunk both of them import, so
    // importing one after the other costs nothing twice.
    lib: {
      entry: {
        index: resolve(__dirname, '../../src/editor/index.ts'),
        host: resolve(__dirname, '../../src/editor/host.ts'),
      },
      formats: ['es'],
    },
    outDir: 'dist', emptyOutDir: true, sourcemap: true,
    rollupOptions: {
      external: [/^react/, /^maplibre-gl/, /^three(\/|$)/, 'lucide-react', 'polygon-clipping', 'proj4', 'pdfjs-dist'],
      // One file per source module rather than one bundled file per entry. It is the difference
      // between a consumer's bundler being ABLE to drop the renderer and being able to prove it:
      // maplibre-gl and three publish side-effectful dists with no `sideEffects: false`, so an
      // `import "maplibre-gl"` sitting in the same module as the theme provider can never be shaken
      // out, however little of that module is used. Split per module, that import lives in
      // map/MapCanvas and is followed only by someone who actually renders a plan.
      //
      // Rooted at src/, so the tree under dist/ reads like the tree it was built from and the two
      // entries land at dist/<package>/index.js and dist/<package>/host.js.
      output: {
        preserveModules: true,
        preserveModulesRoot: resolve(__dirname, '../../src'),
        entryFileNames: '[name].js',
      },
    },
  },
});
