// The DWG → Kerros AI import, script-runner host.
//
//   npx vite-node scripts/plan-import/agent.ts -- ~/Downloads/plan.dwg --out imported.json
//
// The import itself — tool catalog, Kerros briefing, conversation loop, atomic document state —
// lives in @kerros/import (src/import/aiImport.ts) and is provider-agnostic. This script supplies
// the three host-shaped pieces: an AiProvider backed by the Anthropic SDK (credentials from the
// environment or .env.local/.env), a PlanSource backed by LibreDWG via extract.mjs/render.mjs, and
// a Playwright rasterizer. The reference application can host the same import with its own
// provider and credentials.
//
// Requires `dwgread` on PATH (brew install libredwg) and ANTHROPIC_API_KEY.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import {
  runAiPlanImport,
  type AiContent,
  type AiMessage,
  type AiProvider,
  type PlanSource,
} from '../../src/import';

const args = process.argv.slice(2).filter(a => a !== '--');
const dwg = args.find(a => !a.startsWith('--'));
const opt = (name: string, fallback?: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? (args[i + 1] ?? fallback) : fallback;
};
if (!dwg) {
  console.error('usage: agent.ts <plan.dwg> [--out doc.json] [--origin lng,lat,bearing] [--max-turns 40]');
  process.exit(2);
}
const dwgFile: string = dwg;
const outPath = opt('out', 'imported-plan.json')!;
const origin = (opt('origin', '24.938,60.169,0') ?? '').split(',').map(Number) as [number, number, number];

// ——— Credentials: environment first, then the repo's env files (never committed).
for (const file of ['.env.local', '.env']) {
  if (process.env.ANTHROPIC_API_KEY) break;
  if (!existsSync(file)) continue;
  const match = readFileSync(file, 'utf8').match(/^ANTHROPIC_API_KEY=(.+)$/m);
  if (match) process.env.ANTHROPIC_API_KEY = match[1].trim();
}
if (!process.env.ANTHROPIC_API_KEY) {
  console.error('No ANTHROPIC_API_KEY found in the environment, .env.local or .env. Add one and re-run.');
  process.exit(2);
}
const client = new Anthropic();

// ——— PlanSource: LibreDWG extraction + SVG rendering, shelling to the sibling scripts.
const work = mkdtempSync(join(tmpdir(), 'plan-agent-'));
const scriptsDir = resolve(import.meta.dirname ?? __dirname);
const source: PlanSource = {
  async stats() {
    return execFileSync('node', [join(scriptsDir, 'extract.mjs'), dwgFile, '--expand', '--units', 'm', '--stats'], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
  },
  async extract(query) {
    const extra: string[] = [];
    if (query.layers) extra.push('--layers', query.layers);
    if (query.types) extra.push('--types', query.types);
    if (query.bbox) extra.push('--bbox', query.bbox);
    return execFileSync('node', [join(scriptsDir, 'extract.mjs'), dwgFile, '--expand', '--units', 'm', ...extra], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
  },
  async render(query) {
    const entPath = join(work, 'render.json');
    execFileSync('node', [
      join(scriptsDir, 'extract.mjs'),
      dwgFile,
      '--expand',
      '--units',
      'm',
      ...(query.layers ? ['--layers', query.layers] : []),
      '--out',
      entPath,
    ]);
    const svgPath = join(work, 'render.svg');
    const width = Number(query.width ?? 1400);
    const renderArgs = [join(scriptsDir, 'render.mjs'), entPath, '--width', String(width), '--legend', '--out', svgPath];
    if (query.bbox) renderArgs.push('--bbox', query.bbox);
    const note = execFileSync('node', renderArgs, { encoding: 'utf8' }).trim();
    const height = Number(/\d+x(\d+)/.exec(note)?.[1] ?? 900);
    return { pngBase64: await rasterize(readFileSync(svgPath, 'utf8'), width, height), note };
  },
};

// ——— Rasterizer: the repo's Playwright Chromium, one browser for the whole run.
let browserPromise: Promise<import('playwright').Browser> | null = null;
async function rasterize(svg: string, width: number, height: number): Promise<string> {
  const { chromium } = await import('playwright');
  browserPromise ??= chromium.launch();
  const browser = await browserPromise;
  const svgPath = join(work, `frame-${process.hrtime.bigint()}.svg`);
  writeFileSync(svgPath, svg);
  const page = await browser.newPage({ viewport: { width, height: Math.max(100, height) } });
  await page.goto(`file://${svgPath}`);
  const png = await page.screenshot();
  await page.close();
  return png.toString('base64');
}

// ——— AiProvider: Anthropic SDK. Neutral blocks map 1:1; thinking blocks ride through as opaque.
const toSdkContent = (c: AiContent): Anthropic.ContentBlockParam => {
  switch (c.type) {
    case 'text':
      return { type: 'text', text: c.text };
    case 'image_png':
      return { type: 'image', source: { type: 'base64', media_type: 'image/png', data: c.base64 } };
    case 'tool_use':
      return { type: 'tool_use', id: c.id, name: c.name, input: c.input };
    case 'tool_result':
      return {
        type: 'tool_result',
        tool_use_id: c.toolUseId,
        content: c.content.map(toSdkContent) as Anthropic.ToolResultBlockParam['content'],
        ...(c.isError ? { is_error: true } : {}),
      };
    case 'opaque':
      return c.raw as Anthropic.ContentBlockParam;
  }
};
const fromSdkContent = (block: Anthropic.ContentBlock): AiContent => {
  if (block.type === 'text') return { type: 'text', text: block.text };
  if (block.type === 'tool_use')
    return { type: 'tool_use', id: block.id, name: block.name, input: block.input as Record<string, unknown> };
  return { type: 'opaque', raw: block };
};
const provider: AiProvider = {
  async turn({ system, tools, messages }) {
    const stream = client.messages.stream({
      model: 'claude-opus-4-8',
      max_tokens: 64000,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'xhigh' },
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      tools: tools.map(t => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
      })),
      messages: messages.map((m: AiMessage) => ({ role: m.role, content: m.content.map(toSdkContent) })),
    });
    stream.on('text', delta => process.stdout.write(delta));
    const message = await stream.finalMessage();
    process.stdout.write('\n');
    if (message.stop_reason === 'refusal') return [{ type: 'text', text: 'The provider declined this request.' }];
    return message.content.map(fromSdkContent);
  },
};

async function main() {
  const result = await runAiPlanImport(provider, source, {
    origin,
    rasterize,
    maxTurns: Number(opt('max-turns', '40')),
    onEvent: e => {
      if (e.type === 'tool') console.log(`\n[${e.detail}]`);
    },
    onDocument: doc => writeFileSync(outPath, JSON.stringify(doc, null, 1)),
  });
  writeFileSync(outPath, JSON.stringify(result.document, null, 1));
  console.log(`\nDone in ${result.turns} turns. Document: ${outPath}`);
  if (browserPromise) await (await browserPromise).close();
}

main().catch(async error => {
  console.error(error);
  if (browserPromise) await (await browserPromise).close();
  process.exit(1);
});
