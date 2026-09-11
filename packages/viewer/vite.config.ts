import { resolve } from 'node:path';
import { defineConfig } from 'vite';

// Library build: bundles the shared src/ closure behind this package's facade; framework and
// heavyweight rendering dependencies stay external (declared as peer/regular deps below).
export default defineConfig({
  build: {
    lib: { entry: resolve(__dirname, '../../src/viewer/index.ts'), formats: ['es'], fileName: () => 'index.js' },
    outDir: 'dist', emptyOutDir: true, sourcemap: true,
    rollupOptions: { external: [/^react/, /^maplibre-gl/, /^three(\/|$)/, 'lucide-react', 'polygon-clipping', 'proj4', 'pdfjs-dist'] },
  },
});
