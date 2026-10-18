import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const rootDir = process.cwd();
const root = JSON.parse(readFileSync('package.json', 'utf8'));
const temporary = mkdtempSync(join(tmpdir(), 'kerros-packages-'));
const tarballs = join(temporary, 'tarballs');
const consumer = join(temporary, 'consumer');
mkdirSync(tarballs);
mkdirSync(join(consumer, 'src'), { recursive: true });

const run = (command, args, cwd = rootDir) =>
  execFileSync(command, args, {
    cwd,
    stdio: 'inherit',
    env: { ...process.env, npm_config_cache: join(tmpdir(), 'kerros-npm-cache') },
  });

try {
  for (const workspace of ['@kerros/schema', '@kerros/viewer', '@kerros/editor', '@kerros/server'])
    run('npm', ['pack', '--workspace', workspace, '--pack-destination', tarballs]);

  const tarball = name => resolve(tarballs, `kerros-${name}-${root.version}.tgz`);
  writeFileSync(
    join(consumer, 'package.json'),
    JSON.stringify(
      {
        name: 'kerros-package-consumer',
        private: true,
        type: 'module',
        scripts: {
          typecheck: 'tsc --noEmit',
          build: 'vite build',
          smoke: 'node server-smoke.mjs',
        },
        dependencies: {
          '@kerros/schema': `file:${tarball('schema')}`,
          '@kerros/viewer': `file:${tarball('viewer')}`,
          '@kerros/editor': `file:${tarball('editor')}`,
          '@kerros/server': `file:${tarball('server')}`,
          'maplibre-gl': root.dependencies['maplibre-gl'],
          react: root.dependencies.react,
          'react-dom': root.dependencies['react-dom'],
          three: root.dependencies.three,
        },
        devDependencies: {
          '@types/node': root.devDependencies['@types/node'],
          '@types/react': root.devDependencies['@types/react'],
          '@types/react-dom': root.devDependencies['@types/react-dom'],
          typescript: root.devDependencies.typescript,
          vite: root.devDependencies.vite,
        },
      },
      null,
      2,
    ) + '\n',
  );
  writeFileSync(
    join(consumer, 'tsconfig.json'),
    JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2022',
          lib: ['ES2022', 'DOM', 'DOM.Iterable'],
          module: 'ESNext',
          moduleResolution: 'Bundler',
          jsx: 'react-jsx',
          types: ['vite/client', 'geojson'],
          strict: true,
          skipLibCheck: false,
          noEmit: true,
        },
        include: ['src'],
      },
      null,
      2,
    ) + '\n',
  );
  writeFileSync(join(consumer, 'index.html'), '<div id="root"></div><script type="module" src="/src/main.tsx"></script>\n');
  writeFileSync(
    join(consumer, 'src/main.tsx'),
    `import { createRoot } from 'react-dom/client';
import { FloorEditor } from '@kerros/editor';
import { documentSvg } from '@kerros/editor/host';
import { emptyProject, validateProject } from '@kerros/schema';
import { FloorViewer } from '@kerros/viewer';
import { LocalProjectRepository } from '@kerros/viewer/host';
import { setWorkerUrl } from 'maplibre-gl';
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import '@kerros/viewer/styles.css';
import '@kerros/editor/styles.css';

setWorkerUrl(maplibreWorkerUrl);
const project = emptyProject([24.938, 60.169], 'Package consumer');
validateProject(project);
void FloorEditor;
void LocalProjectRepository;
void documentSvg;
createRoot(document.getElementById('root')!).render(
  <main style={{ height: '100vh' }}><FloorViewer project={project} controls /></main>,
);
`,
  );
  writeFileSync(
    join(consumer, 'src/server-types.ts'),
    `import type { PlanSource } from '@kerros/server';
export const source: PlanSource | undefined = undefined;
`,
  );
  writeFileSync(
    join(consumer, 'server-smoke.mjs'),
    `import { emptyProject, validateProject } from '@kerros/schema';
import { documentSvg } from '@kerros/server';
const project = emptyProject([24.938, 60.169], 'Package consumer');
validateProject(project);
const svg = documentSvg(project);
if (!svg.includes('<svg')) throw new Error('Server SVG export failed');
console.log(JSON.stringify({ project: project.name, floors: project.floors.length, svg: svg.length }));
`,
  );

  run('npm', ['install', '--ignore-scripts', '--no-audit'], consumer);
  run('npm', ['run', 'typecheck'], consumer);
  run('npm', ['run', 'build'], consumer);
  run('npm', ['run', 'smoke'], consumer);
  run('npm', ['audit', '--omit=dev', '--audit-level=high'], consumer);
  console.log(`Packed and verified all Kerros ${root.version} packages in a clean consumer project.`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
