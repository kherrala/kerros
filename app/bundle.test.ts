import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/** Every source file under app/, recursively. */
function hostFiles(dir = 'app'): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return hostFiles(path);
    return /\.(ts|tsx)$/.test(name) && !name.endsWith('.test.ts') ? [path] : [];
  });
}

describe('what the reference apps load before they draw anything', () => {
  // The renderer — SitePlanner, MapCanvas, maplibre-gl, three — is 1.7 MB and reaches the hosts only
  // through a dynamic import. Rollup cannot warn about this: one static `import { X } from
  // '@kerros/editor'` anywhere under app/ silently puts the whole facade back in the eager list and
  // the build still succeeds, two megabytes heavier. `import type` erases and is fine; the `/host`
  // subpath is the map-free half and is fine. This is the check that says which is which.
  it('reaches the renderer only through a dynamic import', () => {
    const offenders: string[] = [];
    for (const file of hostFiles()) {
      const source = readFileSync(file, 'utf8');
      for (const line of source.split('\n')) {
        const match = /^\s*import\s+(?!type\b)([^;]*?)\s+from\s+'(@kerros\/(?:editor|viewer))'/.exec(line);
        if (match) offenders.push(`${file}: ${line.trim()}`);
      }
    }
    expect(offenders, 'use @kerros/…/host for the map-free surface, or lazy(() => import(…))').toEqual([]);
  });

  it('builds a blank site without loading a demo', () => {
    // "New blank site" is the first thing the picker offers. newProject lives in its own module so
    // that offering it does not drag the thousand-object Stockmann campus in behind it.
    const blank = readFileSync('app/demo/blank.ts', 'utf8');
    expect(blank).not.toMatch(/from '\.\/(demo|silo|backrooms)'/);
    const host = readFileSync('app/main.tsx', 'utf8');
    for (const generator of ['./demo/demo', './demo/silo', './demo/backrooms'])
      expect(host, `${generator} must be reached with import(), not a static import`).not.toMatch(
        new RegExp(`^\\s*import\\s+(?!type\\b)[^;]*from '${generator.replace('.', '\\.')}'`, 'm'),
      );
  });
});
