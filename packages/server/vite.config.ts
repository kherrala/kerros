import { resolve } from 'node:path';
import { mkdirSync, copyFileSync } from 'node:fs';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [{ name: 'kerros-server-tools', closeBundle() {
    mkdirSync(resolve(__dirname, 'dist/tools'), { recursive: true });
    for (const name of ['extract.mjs', 'render.mjs']) copyFileSync(resolve(__dirname, '../../scripts/plan-import', name), resolve(__dirname, 'dist/tools', name));
    copyFileSync(resolve(__dirname, '../../src/server/tools/raster.py'), resolve(__dirname, 'dist/tools/raster.py'));
  } }],
  build: {
    target: 'node22', ssr: true,
    lib: { entry: resolve(__dirname, '../../src/server/index.ts'), formats: ['es'], fileName: () => 'index.js' },
    outDir: 'dist', emptyOutDir: true, sourcemap: true,
    rollupOptions: { external: id => !id.startsWith('.') && !id.startsWith('/') },
  },
});
