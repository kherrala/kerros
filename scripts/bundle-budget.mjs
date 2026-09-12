// What a consumer actually pays to import each part of Kerros.
//
// The packages are published one file per module so a bundler can follow only what is named — but
// nothing in a build fails when that stops being true. One static re-export of a component that
// touches maplibre-gl, and every consumer importing the theme provider silently ships a map: the
// build succeeds, the types are fine, and the only symptom is two megabytes. That is exactly how the
// reference apps came to preload 2.3 MB before drawing a picker.
//
// So this measures the property rather than trusting the shape. Each probe under scripts/budget/ is
// a one-line consumer: it imports some names from a built package and exports them. Bundling it says
// two things, and the second is the one that matters:
//
//   HEAVY   which of maplibre-gl / three / pdfjs the import pulled in. Exact, because they are left
//           external and therefore appear verbatim as import statements in the output.
//   SIZE    how much of Kerros's own code came with it.
//
// Run with `make budget`. Deliberately not part of `make check`: it needs a library build, and the
// point of `make check` is that it is quick enough to run before every commit.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { build } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Inside the repo: Vite refuses to empty an outDir that sits outside the project root, and a
// stale directory would make every probe measure the one before it.
const OUT = join(root, '.budget-out');
/** Left external, so "did this import pull the renderer in?" is answered by reading the output's own
 *  import statements instead of sniffing for minified library internals. */
const HEAVY = ['maplibre-gl', 'three', 'pdfjs-dist'];

/** Every probe, with what it is allowed to cost. Sizes are Kerros's own code only, minified, in kB;
 *  the ceilings sit roughly 30% above the measured truth, which is loose enough not to trip on a
 *  feature and tight enough that a facade re-export cannot hide in the noise. */
const BUDGETS = [
  { probe: 'schema', kB: 80, heavy: [] },
  { probe: 'viewer-host', kB: 80, heavy: [] },
  { probe: 'viewer-light', kB: 80, heavy: [] },
  { probe: 'editor-host', kB: 80, heavy: [] },
  { probe: 'editor-light', kB: 80, heavy: [] },
  // The renderers may pull maplibre, because they are a map. They may NOT pull three: the 3D scene
  // is named with a dynamic import so that a host showing a flat plan — which plenty only ever do —
  // pays nothing for a renderer it never runs. That is the invariant this line exists to hold.
  { probe: 'viewer-render', kB: 240, heavy: ['maplibre-gl'] },
  { probe: 'editor-render', kB: 580, heavy: ['maplibre-gl'] },
];

const PACKAGES = ['schema', 'editor', 'viewer'];

/** What each reference page may fetch and compile before it draws, in kB. The hosts are the other
 *  half of the same question: the packages can be perfectly shakeable and a host still undo it, and
 *  the ways to undo it do not look like mistakes. One static import of the facade puts the renderer
 *  back; so, less obviously, does a manual-chunk rule that happens to capture Vite's preload helper,
 *  which every entry needs the moment it names a lazy import. Both were real, both built cleanly. */
const PAGES = { 'app.html': 420, 'viewer.html': 420 };

/** Build each package the way its own `npm run build` does — its own vite config, so this measures
 *  the artifact that ships rather than a re-description of it. The type and stylesheet steps are
 *  skipped: neither is in the module graph a consumer's bundler walks. */
function buildPackages() {
  for (const name of PACKAGES)
    execFileSync('npx', ['vite', 'build'], { cwd: join(root, 'packages', name), stdio: 'pipe' });
}

const dist = (name, file = 'index.js') => join(root, 'packages', name, 'dist', file);

async function measure(probe) {
  const outDir = join(OUT, probe);
  rmSync(outDir, { recursive: true, force: true });
  /** What the entry pulls in EAGERLY: itself plus everything it imports statically, transitively.
   *  Rollup separates `imports` from `dynamicImports` on each chunk, so following only the first is
   *  exactly the question a consumer cares about — a lazily-named renderer still lands in their
   *  output directory, but nothing downloads it until someone asks for 3D. */
  let eager = { kB: 0, heavy: [] };
  await build({
    root,
    // Without this, Vite loads the repo's own vite.config.ts and builds the reference apps instead —
    // every probe then measures the same thing, which is a very convincing wrong answer.
    configFile: false,
    logLevel: 'error',
    resolve: {
      alias: {
        // Longest first: Vite's string aliases match by prefix.
        '@kerros/editor/host': dist('editor', 'host.js'),
        '@kerros/viewer/host': dist('viewer', 'host.js'),
        '@kerros/editor': dist('editor'),
        '@kerros/viewer': dist('viewer'),
        '@kerros/schema': dist('schema'),
      },
    },
    build: {
      lib: { entry: { [probe]: join(root, 'scripts/budget', `${probe}.js`) }, formats: ['es'] },
      outDir,
      emptyOutDir: true,
      sourcemap: false,
      minify: true,
      rollupOptions: {
        external: [/^react/, 'proj4', ...HEAVY.map(h => new RegExp(`^${h}(/|$)`))],
        plugins: [
          {
            name: 'kerros-eager-closure',
            generateBundle(_options, bundle) {
              const entry = Object.values(bundle).find(c => c.type === 'chunk' && c.isEntry);
              const seen = new Set();
              const externals = new Set();
              let bytes = 0;
              const walk = name => {
                if (seen.has(name)) return;
                seen.add(name);
                const chunk = bundle[name];
                if (!chunk || chunk.type !== 'chunk') return;
                bytes += Buffer.byteLength(chunk.code);
                for (const id of chunk.imports)
                  if (bundle[id]) walk(id);
                  else externals.add(id);
              };
              walk(entry.fileName);
              eager = { kB: bytes / 1024, heavy: HEAVY.filter(h => [...externals].some(e => e === h || e.startsWith(`${h}/`))) };
            },
          },
        ],
      },
    },
  });
  return eager;
}

mkdirSync(OUT, { recursive: true });
buildPackages();
const failures = [];
console.log('\n  what a consumer pays, per import\n');
console.log('  %s  %s  %s', 'probe'.padEnd(15), 'eager'.padStart(9), 'eagerly pulls');
for (const budget of BUDGETS) {
  const { kB, heavy } = await measure(budget.probe);
  const over = kB > budget.kB;
  const wrong = heavy.filter(h => !budget.heavy.includes(h));
  console.log(
    '  %s  %s  %s%s',
    budget.probe.padEnd(15),
    `${kB.toFixed(1)} kB`.padStart(9),
    heavy.join(', ') || '—',
    over || wrong.length ? '   ← over budget' : '',
  );
  if (over) failures.push(`${budget.probe}: ${kB.toFixed(1)} kB eager, budget ${budget.kB} kB`);
  if (wrong.length) failures.push(`${budget.probe}: pulls ${wrong.join(', ')}, which it has no business needing`);
}

// The reference apps, measured the way a browser sees them: the script and modulepreload list in the
// built HTML is exactly what it fetches before first paint.
execFileSync('npm', ['run', 'build'], { cwd: root, stdio: 'pipe' });
console.log('');
console.log('  %s  %s', 'page'.padEnd(15), 'eager'.padStart(9));
for (const [page, ceiling] of Object.entries(PAGES)) {
  const html = readFileSync(join(root, 'dist', page), 'utf8');
  const assets = new Set([...html.matchAll(/\/assets\/([A-Za-z0-9_.\-]+\.(?:js|mjs))/g)].map(m => m[1]));
  const kB = [...assets].reduce((sum, a) => sum + statSync(join(root, 'dist/assets', a)).size, 0) / 1024;
  const over = kB > ceiling;
  console.log('  %s  %s%s', page.padEnd(15), `${kB.toFixed(1)} kB`.padStart(9), over ? '   ← over budget' : '');
  if (over) failures.push(`${page}: ${kB.toFixed(1)} kB before first paint, budget ${ceiling} kB`);
}

rmSync(OUT, { recursive: true, force: true });
if (!failures.length) {
  console.log('\n  within budget\n');
  process.exit(0);
}
console.error('\n  over budget:\n%s\n', failures.map(f => `    ${f}`).join('\n'));
console.error(
  '  A light import that pulls maplibre-gl or three means something in the facade re-exports a\n' +
    '  component statically. Reach it with lazy(() => import(…)) instead, or take the names from the\n' +
    '  /host subpath, which cannot reach the renderer by construction.\n',
);
process.exit(1);
