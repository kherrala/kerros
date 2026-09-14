import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PlanSource, AiPlanImportOptions } from './aiImport';
import type { PlanEntity } from '../import/types';
import { AnalysisStore, sourceHash } from './analysisStore';
import { extractCadVectors } from './cadAnalysis';
import { vectorBounds } from './analysis';
import { analysisRequest } from './rasterAnalysis';

const exec = promisify(execFile);
export async function openDwgSource(
  path: string,
  options: { rasterize: AiPlanImportOptions['rasterize']; toolsDirectory?: string; cacheDirectory?: string },
): Promise<PlanSource & { close(): Promise<void> }> {
  const work = await mkdtemp(join(tmpdir(), 'kerros-dwg-'));
  const hash = sourceHash(await readFile(path)),
    store = new AnalysisStore(hash, options.cacheDirectory);
  const directory = options.toolsDirectory ?? fileURLToPath(new URL('./tools/', import.meta.url));
  const run = async (script: string, args: string[]) =>
    (
      await exec(process.execPath, [join(directory, script), ...args], {
        encoding: 'utf8',
        timeout: 60_000,
        maxBuffer: 64 * 1024 * 1024,
      })
    ).stdout;
  const extract: PlanSource['extract'] = query =>
    run('extract.mjs', [
      path,
      '--expand',
      '--units',
      'm',
      ...(query.layers ? ['--layers', query.layers] : []),
      ...(query.types ? ['--types', query.types] : []),
      ...(query.bbox ? ['--bbox', query.bbox] : []),
    ]);
  return {
    kind: 'cad',
    stats: () => run('extract.mjs', [path, '--expand', '--units', 'm', '--stats']),
    extract,
    analyse: async (query = {}) => {
      const { page, mode, bbox, symbol } = analysisRequest(query);
      if (page !== 1) throw new Error('The DWG extractor exposes one model-space drawing.');
      if (mode === 'raster' || bbox || symbol)
        throw new Error(
          'DWG analysis uses native vectors. Filter the extracted candidates with query_candidates instead.',
        );
      return store.get(1, async id => {
        const entities: PlanEntity[] = JSON.parse(await extract({})).entities;
        const data = extractCadVectors(entities);
        return {
          version: 1,
          id,
          sourceHash: hash,
          page: 1,
          sourceKind: 'cad',
          units: 'm',
          axis: 'y-up',
          bounds: vectorBounds(data.candidates.flatMap(c => c.path)),
          ...data,
        };
      });
    },
    render: async query => {
      const requested = query.width ?? 1400;
      if (!Number.isFinite(requested)) throw new Error('Render width must be finite.');
      const width = Math.max(400, Math.min(2000, Math.round(requested)));
      const json = join(work, 'entities.json'),
        svgFile = join(work, 'view.svg');
      await writeFile(json, await extract({ layers: query.layers }), { mode: 0o600 });
      const note = (
        await run('render.mjs', [
          json,
          '--width',
          String(width),
          '--out',
          svgFile,
          ...(query.bbox ? ['--bbox', query.bbox] : []),
        ])
      ).trim();
      const svg = await readFile(svgFile, 'utf8');
      const height = Number(/height="(\d+)"/.exec(svg)?.[1] ?? 900);
      return { pngBase64: await options.rasterize(svg, width, height), note };
    },
    close: () => rm(work, { recursive: true, force: true }),
  };
}
