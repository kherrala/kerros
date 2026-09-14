// Local extraction only. Does not load .env, create a provider, or contact an LLM.
import { extname, resolve, dirname } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { openDwgSource, openVisualSource, analysisSvg, analysisSummary } from '../../src/server';
import { analysisRequest } from '../../src/server/rasterAnalysis';

const args = process.argv.slice(2).filter(a => a !== '--');
const option = (name: string) => { const i = args.indexOf(`--${name}`); return i < 0 ? undefined : args[i + 1]; };
const input = args[0];
if (!input || input.startsWith('--')) throw new Error('Usage: analyse.ts -- drawing.pdf --out analysis.json [--page 1] [--svg analysis.svg] [--mode auto|native|raster] [--profile clean|scan] [--bbox x0,y0,x1,y1] [--no-ocr]');
const output = resolve(option('out') ?? 'analysis.json');
const page = Number(option('page') ?? 1);
const source = extname(input).toLowerCase() === '.dwg'
  ? await openDwgSource(resolve(input), { toolsDirectory: dirname(fileURLToPath(import.meta.url)), rasterize: async () => { throw new Error('Vector analysis does not rasterize.'); }, cacheDirectory: resolve('.cache/plan-analysis') })
  : await openVisualSource(resolve(input), { cacheDirectory: resolve('.cache/plan-analysis') });
try {
  const query = analysisRequest({ page, mode: option('mode') as 'auto' | 'native' | 'raster' | undefined, profile: option('profile') as 'clean' | 'scan' | undefined, bbox: option('bbox')?.split(',').map(Number) as [number, number, number, number] | undefined, ocr: !args.includes('--no-ocr') });
  const analysis = await source.analyse!(query);
  await writeFile(output, JSON.stringify(analysis, null, 2), { mode: 0o600 });
  await writeFile(resolve(option('svg') ?? output.replace(/\.json$/i, '') + '.svg'), analysisSvg(analysis), { mode: 0o600 });
  console.log(JSON.stringify(analysisSummary(analysis), null, 2));
} finally { await source.close(); }
