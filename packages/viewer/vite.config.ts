import { resolve } from 'node:path';
import { defineConfig } from 'vite';

// Library build: bundles the shared src/ closure behind this package's facade; framework and
// heavyweight rendering dependencies stay external (declared as peer/regular deps below).
export default defineConfig({
  build: {
    // Two entries: the facade, and the map-free `./host` subpath a consumer imports when it only
    // wants persistence or theming. Their shared closure lands in a chunk both of them import, so
    // importing one after the other costs nothing twice.
    lib: {
      entry: {
        index: resolve(__dirname, '../../src/viewer/index.ts'),
        host: resolve(__dirname, '../../src/viewer/host.ts'),
      },
      formats: ['es'],
      fileName: (_format, entry) => `${entry}.js`,
    },
    outDir: 'dist', emptyOutDir: true, sourcemap: true,
    rollupOptions: { external: [/^react/, /^maplibre-gl/, /^three(\/|$)/, 'lucide-react', 'polygon-clipping', 'proj4', 'pdfjs-dist'] },
  },
});
