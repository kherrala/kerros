// Image / PDF / DWG → Kerros AI import, script-runner and backend worker.
//
//   npx vite-node scripts/plan-import/agent.ts -- ~/Downloads/plan.dwg --out imported.json
//
// The import itself — tool catalog, Kerros briefing, conversation loop, atomic document state —
// lives in @kerros/server (src/server/aiImport.ts) and is provider-agnostic. This script supplies
// the three host-shaped pieces: an AiProvider backed by the Anthropic SDK (credentials from the
// environment or .env.local/.env), a PlanSource backed by LibreDWG via extract.mjs/render.mjs, and
// a Playwright rasterizer. The reference application can host the same import with its own
// provider and credentials.
//
// Requires `dwgread` on PATH (brew install libredwg) and ANTHROPIC_API_KEY.
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { loadImportEnv } from './env';
import { openVisualSource, openDwgSource, createClaudeProvider } from '../../src/server';
import { logImport } from './logging';
import { readImportCheckpoint } from '../../src/import/checkpoint';
import { readImportBrief } from '../../src/import/brief';
import { createInterface } from 'node:readline';
import { readImportInstruction, mergeImportInstructions, type ImportInstruction } from '../../src/import/instructions';
import { validateProject } from '../../src/schema';
import Anthropic from '@anthropic-ai/sdk';
import {
  runAiPlanImport,
  type PlanSource,
} from '../../src/server';

const args = process.argv.slice(2).filter(a => a !== '--');
const drawing = args[0]?.startsWith('--') ? undefined : args[0];
const events = args.includes('--events');
const emit = (event: Record<string, unknown>) => process.stdout.write(JSON.stringify(event) + '\n');
const opt = (name: string, fallback?: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? (args[i + 1] ?? fallback) : fallback;
};
if (!drawing) {
  console.error('usage: agent.ts <plan.dwg|pdf|png|jpg|webp> [--out doc.json] [--origin lng,lat,bearing] [--max-turns 40]');
  process.exit(2);
}
const drawingFile: string = resolve(drawing);
const outPath = opt('out', 'imported-plan.json')!;
const origin = (opt('origin', '24.938,60.169,0') ?? '').split(',').map(Number) as [number, number, number];

loadImportEnv();
if (!process.env.ANTHROPIC_API_KEY) {
  console.error('No ANTHROPIC_API_KEY found in the environment, .env.local or .env. Add one and re-run.');
  process.exit(2);
}

// ——— PlanSource: LibreDWG extraction + SVG rendering, shelling to the sibling scripts.
const work = mkdtempSync(join(tmpdir(), 'plan-agent-'));
const scriptsDir = resolve(import.meta.dirname ?? __dirname);
const cacheDirectory = process.env.KERROS_IMPORT_ANALYSIS_CACHE || resolve('.cache/plan-analysis');
// ——— Rasterizer: the repo's Playwright Chromium, one browser for the whole run.
let browserPromise: Promise<import('playwright').Browser> | null = null;
async function rasterize(svg: string, width: number, height: number): Promise<string> {
  const { chromium } = await import('playwright');
  browserPromise ??= chromium.launch();
  const browser = await browserPromise;
  const svgPath = join(work, `frame-${process.hrtime.bigint()}.svg`);
  writeFileSync(svgPath, svg);
  const page = await browser.newPage({ viewport: { width, height: Math.max(100, Math.min(2000, height)) } });
  await page.route('**/*', route => route.request().url().startsWith('file:') ? route.continue() : route.abort());
  await page.goto(`file://${svgPath}`);
  const png = await page.screenshot();
  await page.close();
  return png.toString('base64');
}

const provider = createClaudeProvider({
  apiKey: process.env.ANTHROPIC_API_KEY, model: process.env.ANTHROPIC_MODEL,
  onText: delta => events ? emit({ type: 'text', detail: delta }) : process.stdout.write(delta),
});

let source: (PlanSource & { close(): Promise<void> }) | undefined;
let pendingInstructions: ImportInstruction[] = [];
const commandInput = events ? createInterface({ input: process.stdin }) : undefined;
commandInput?.on('line', line => {
  try {
    if (line.length > 10_000) return;
    pendingInstructions = mergeImportInstructions(pendingInstructions, [readImportInstruction(JSON.parse(line))]);
  } catch { /* Only valid bounded commands enter model context. */ }
});
async function main() {
  logImport({ event: 'worker_started' });
  if (!/\.(dwg|pdf|png|jpe?g|webp)$/i.test(drawingFile)) throw new Error('Choose a DWG, PDF, PNG, JPEG or WebP file.');
  if (origin.length !== 3 || !origin.every(Number.isFinite) || Math.abs(origin[0]) > 180 || Math.abs(origin[1]) > 90) throw new Error('Origin must be longitude,latitude,bearing.');
  const maxTurns = Number(opt('max-turns', '40'));
  if (!Number.isInteger(maxTurns) || maxTurns < 1 || maxTurns > 100) throw new Error('max-turns must be between 1 and 100.');
  const budget = (name: string, fallback: number) => {
    const value = Number(opt(name, String(fallback)));
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer.`);
    return value;
  };
  const maxContextTokens = budget('max-context-tokens', 24_000);
  const maxInputTokens = budget('max-input-tokens', 200_000);
  const maxOutputTokens = budget('max-output-tokens', 24_000);
  const instructionsFile = opt('instructions-file');
  const instructions = instructionsFile ? readFileSync(instructionsFile, 'utf8') : opt('instructions');
  if (instructions && instructions.length > 8000) throw new Error('Instructions must be at most 8000 characters.');
  source = extname(drawingFile).toLowerCase() === '.dwg'
    ? await openDwgSource(drawingFile, { rasterize, toolsDirectory: scriptsDir, cacheDirectory })
    : await openVisualSource(drawingFile, { cacheDirectory });
  const result = await runAiPlanImport(provider, source, {
    origin, rasterize, maxTurns, instructions, maxContextTokens, maxInputTokens, maxOutputTokens,
    takeInstructions: () => pendingInstructions.splice(0),
    brief: opt('brief-file') ? readImportBrief(JSON.parse(readFileSync(opt('brief-file')!, 'utf8'))) : readImportBrief({
      buildingType: opt('building-type'),
      floorCount: opt('floor-count') ? Number(opt('floor-count')) : undefined,
      widthMetres: opt('width-metres') ? Number(opt('width-metres')) : undefined,
      depthMetres: opt('depth-metres') ? Number(opt('depth-metres')) : undefined,
      footprintAreaM2: opt('footprint-m2') ? Number(opt('footprint-m2')) : undefined,
    }),
    base: opt('base') ? validateProject(JSON.parse(readFileSync(opt('base')!, 'utf8'))) : undefined,
    checkpoint: opt('checkpoint-file') ? readImportCheckpoint(JSON.parse(readFileSync(opt('checkpoint-file')!, 'utf8'))) : undefined,
    onCheckpoint: checkpoint => {
      writeFileSync(`${outPath}.checkpoint.json`, JSON.stringify(checkpoint), { mode: 0o600 });
      if (events) emit({ type: 'checkpoint', checkpoint });
    },
    onEvent: e => {
      if (e.type !== 'text') events ? emit(e) : console.log(`\n[${e.detail}]`);
    },
    onAnalysis: events ? preview => { emit({ type: 'analysis', preview }); } : undefined,
    onOperation: operation => logImport({ ...operation, event: `${operation.scope}_${operation.phase}` }),
    onUsage: usage => {
      if (events) emit({ type: 'usage', usage });
      logImport({ event: 'usage', ...usage });
    },
    onDocument: document => {
      writeFileSync(outPath, JSON.stringify(document, null, 1));
      logImport({ event: 'document_saved', objects: document.objects.length, barriers: document.barriers.length, floors: document.floors.length });
      if (events) emit({ type: 'document', document });
    },
  });
  writeFileSync(outPath, JSON.stringify(result.document, null, 1));
  logImport({ event: 'worker_completed', turns: result.turns, ...result.usage });
  if (events) emit({ type: 'done', ...result });
  else console.log(`\n${result.pause?.message ?? "Done"} (${result.turns} turns). Document: ${outPath} · checkpoint: ${outPath}.checkpoint.json`);
}
async function cleanup() {
  commandInput?.close();
  await source?.close();
  if (browserPromise) await (await browserPromise).close();
  rmSync(work, { recursive: true, force: true });
}
process.once('SIGTERM', () => { void cleanup().finally(() => process.exit(0)); });
main().catch(error => {
  logImport({ event: 'worker_failed', status: error instanceof Anthropic.APIError ? error.status : undefined });
  // Never serialize SDK error objects: they can contain request headers and credentials.
  const message = error instanceof Error ? error.message : 'Import failed.';
  const safe = process.env.ANTHROPIC_API_KEY ? message.split(process.env.ANTHROPIC_API_KEY).join('[redacted]') : message;
  if (events) emit({ type: 'error', message: safe });
  else console.error(safe);
  process.exitCode = 1;
}).finally(cleanup);
