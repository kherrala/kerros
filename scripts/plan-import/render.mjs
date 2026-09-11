#!/usr/bin/env node
// Render extracted plan entities to SVG (and optionally PNG) so an agent — or a person — can look
// at exactly the slice of the drawing they asked extract.mjs for. Layers get stable distinct
// colours; TEXT renders as text; a --bbox crop turns "the whole sheet" into "this doorway".
//
//   node scripts/plan-import/extract.mjs plan.dwg --expand --units m --out plan-m.json
//   node scripts/plan-import/render.mjs plan-m.json --out plan.svg
//   node scripts/plan-import/render.mjs plan-m.json --bbox 2,6,20,16 --png plan.png
//
// PNG rasterization uses the repo's Playwright Chromium; SVG needs nothing.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const input = args.find(a => !a.startsWith('--'));
const opt = (name, fallback = undefined) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? (args[i + 1]?.startsWith('--') ? true : (args[i + 1] ?? true)) : fallback;
};
if (!input) {
  console.error('usage: render.mjs <entities.json> [--bbox x0,y0,x1,y1] [--width 1600] [--out plan.svg] [--png plan.png] [--no-text]');
  process.exit(2);
}
const { entities } = JSON.parse(readFileSync(input, 'utf8'));

const boxes = [];
for (const e of entities) {
  const pts = [e.a, e.b, e.at, e.center, ...(e.points ?? [])].filter(Boolean);
  for (const p of pts) boxes.push(p);
}
let [x0, y0, x1, y1] = opt('bbox')
  ? String(opt('bbox')).split(',').map(Number)
  : [Math.min(...boxes.map(p => p[0])), Math.min(...boxes.map(p => p[1])), Math.max(...boxes.map(p => p[0])), Math.max(...boxes.map(p => p[1]))];
const pad = (x1 - x0) * 0.02;
[x0, y0, x1, y1] = [x0 - pad, y0 - pad, x1 + pad, y1 + pad];

const width = Number(opt('width', 1600));
const height = Math.round((width * (y1 - y0)) / (x1 - x0));
const sx = width / (x1 - x0);
// CAD y grows up; SVG y grows down.
const X = v => ((v - x0) * sx).toFixed(1);
const Y = v => ((y1 - v) * sx).toFixed(1);

const PALETTE = ['#1668dc', '#d4380d', '#389e0d', '#a25ddc', '#d48806', '#08979c', '#c41d7f', '#5b6068', '#7cb305', '#b8860b'];
const colorFor = new Map();
const color = layer => {
  if (!colorFor.has(layer)) colorFor.set(layer, PALETTE[colorFor.size % PALETTE.length]);
  return colorFor.get(layer);
};
const strokeW = Math.max(0.6, width / 1600);

const parts = [];
const noText = !!opt('no-text');
for (const e of entities) {
  const c = color(e.layer);
  if (e.type === 'LINE' && e.a && e.b)
    parts.push(`<line x1="${X(e.a[0])}" y1="${Y(e.a[1])}" x2="${X(e.b[0])}" y2="${Y(e.b[1])}" stroke="${c}"/>`);
  else if (e.type === 'POLYLINE' && e.points?.length)
    parts.push(`<polyline points="${e.points.map(p => `${X(p[0])},${Y(p[1])}`).join(' ')}${e.closed ? ` ${X(e.points[0][0])},${Y(e.points[0][1])}` : ''}" fill="none" stroke="${c}"/>`);
  else if (e.type === 'ARC' && e.center) {
    const a0 = (e.start * Math.PI) / 180, a1 = (e.end * Math.PI) / 180;
    const p0 = [e.center[0] + e.r * Math.cos(a0), e.center[1] + e.r * Math.sin(a0)];
    const p1 = [e.center[0] + e.r * Math.cos(a1), e.center[1] + e.r * Math.sin(a1)];
    const large = ((a1 - a0 + Math.PI * 2) % (Math.PI * 2)) > Math.PI ? 1 : 0;
    parts.push(`<path d="M ${X(p0[0])} ${Y(p0[1])} A ${(e.r * sx).toFixed(1)} ${(e.r * sx).toFixed(1)} 0 ${large} 0 ${X(p1[0])} ${Y(p1[1])}" fill="none" stroke="${c}"/>`);
  } else if (e.type === 'CIRCLE' && e.center)
    parts.push(`<circle cx="${X(e.center[0])}" cy="${Y(e.center[1])}" r="${(e.r * sx).toFixed(1)}" fill="none" stroke="${c}"/>`);
  else if (e.type === 'TEXT' && e.at && e.text && !noText)
    parts.push(`<text x="${X(e.at[0])}" y="${Y(e.at[1])}" font-size="${Math.max(8, (e.h || 0.2) * sx).toFixed(1)}" fill="${c}">${String(e.text).replace(/&/g, '&amp;').replace(/</g, '&lt;')}</text>`);
  else if (e.type === 'INSERT' && e.at)
    parts.push(`<circle cx="${X(e.at[0])}" cy="${Y(e.at[1])}" r="3" fill="${c}"/>`);
}

const legend = [...colorFor].map(([layer, c], i) => `<text x="8" y="${16 + i * 14}" font-size="11" fill="${c}">${layer}</text>`).join('');
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
<rect width="100%" height="100%" fill="white"/>
<g stroke-width="${strokeW}" font-family="system-ui">${parts.join('\n')}</g>
${opt('legend') ? `<g font-family="system-ui">${legend}</g>` : ''}
</svg>`;

const out = String(opt('out', input.replace(/\.json$/, '.svg')));
writeFileSync(out, svg);
console.log(`${parts.length} shapes -> ${out} (${width}x${height})`);

const png = opt('png');
if (typeof png === 'string') {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width, height } });
  await page.goto(`file://${resolve(out)}`);
  await page.screenshot({ path: png });
  await browser.close();
  console.log(`rasterized -> ${png}`);
}
