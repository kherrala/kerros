import type { Plugin } from 'vite';

/** Fail even for lazy chunks: source extraction and AI schemas belong only to @kerros/server. */
export function browserServerBoundary(): Plugin {
  return { name: 'kerros-browser-server-boundary', generateBundle(_options, bundle) {
    for (const chunk of Object.values(bundle)) if (chunk.type === 'chunk') {
      for (const id of [...chunk.imports, ...chunk.dynamicImports]) if (/^(?:@kerros\/server|pdfjs-dist|@anthropic-ai\/sdk|@napi-rs\/canvas)(?:\/|$)/.test(id)) this.error(`Server-only dependency reached the browser bundle: ${id}`);
      for (const id of Object.keys(chunk.modules)) {
        if (/\/src\/server\/|\/node_modules\/(?:pdfjs-dist|@anthropic-ai\/sdk|@napi-rs\/canvas)\//.test(id)) this.error(`Server-only module reached the browser bundle: ${id}`);
      }
    }
  } };
}
