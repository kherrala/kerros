#!/usr/bin/env node
// Extract normalized 2D entities from a DWG (via LibreDWG's dwgread) or from its cached JSON dump.
//
// This is agent tooling: the output is small, uniform JSON an agent (or a person) can reason over —
// {type, layer, ...geometry in drawing units} — with filtering by layer regex, entity type and
// bounding box, so the caller can ask for exactly "the wall lines inside this room" instead of
// receiving four megabytes of everything.
//
//   node scripts/plan-import/extract.mjs plan.dwg --stats
//   node scripts/plan-import/extract.mjs plan.dwg --layers '27_OVET|26_IKKUNAT' --out openings.json
//   node scripts/plan-import/extract.mjs plan.dwg --types TEXT,MTEXT --bbox 0,0,600,400
//
// Requires `dwgread` on PATH (brew install libredwg). The dwgread JSON is cached beside the DWG.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const input = args.find(a => !a.startsWith('--'));
const opt = (name, fallback = undefined) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? (args[i + 1]?.startsWith('--') ? true : (args[i + 1] ?? true)) : fallback;
};
if (!input) {
  console.error('usage: extract.mjs <plan.dwg|plan.dwg.json> [--stats] [--layers regex] [--types A,B] [--bbox x0,y0,x1,y1] [--out file.json]');
  process.exit(2);
}

const jsonPath = input.endsWith('.json') ? input : `${input}.json`;
if (!input.endsWith('.json') && !existsSync(jsonPath)) {
  execFileSync('dwgread', ['-O', 'json', '-o', jsonPath, input], { stdio: ['ignore', 'ignore', 'pipe'] });
}
const dump = JSON.parse(readFileSync(jsonPath, 'utf8'));
const objects = dump.OBJECTS ?? [];

// Layer references are handle refs; the last element is the absolute handle of the LAYER object.
const layerByHandle = new Map();
for (const o of objects) if (o.object === 'LAYER') layerByHandle.set(o.handle?.[2], o.name ?? String(o.handle?.[2]));
const layerOf = e => layerByHandle.get(e.layer?.[e.layer.length - 1]) ?? '?';

// Block definitions, so INSERTs can be reported with their block name — and so entities can be
// classified by the space they live in. A door symbol's lines sit in a BLOCK at local coordinates;
// only model-space entities are the plan itself. entmode 2 = model space, 1 = paper space,
// 0 = owned by a block (the owner handle names which).
const blockByHandle = new Map();
for (const o of objects) if (o.object === 'BLOCK_HEADER') blockByHandle.set(o.handle?.[2], o.name ?? '?');
const spaceOf = e =>
  e.entmode === 2 ? 'model' : e.entmode === 1 ? 'paper' : (blockByHandle.get(e.ownerhandle?.[e.ownerhandle.length - 1]) ?? 'block');

const p2 = pt => (Array.isArray(pt) ? [round(pt[0]), round(pt[1])] : undefined);
const round = v => Math.round(v * 1000) / 1000;

/** One entity, normalized to the fields that matter for a floor plan. Returns null to skip. */
function normalize(e) {
  const layer = layerOf(e);
  switch (e.entity) {
    case 'LINE':
      return { type: 'LINE', layer, a: p2(e.start), b: p2(e.end) };
    case 'LWPOLYLINE':
      return { type: 'POLYLINE', layer, closed: !!(e.flag & 512) || !!e.closed, points: (e.points ?? []).map(p2) };
    case 'POLYLINE_2D':
      return { type: 'POLYLINE', layer, closed: !!(e.flag & 1), points: [] }; // vertices follow as VERTEX entities; rare here
    case 'ARC':
      return { type: 'ARC', layer, center: p2(e.center), r: round(e.radius), start: round(e.start_angle), end: round(e.end_angle) };
    case 'CIRCLE':
      return { type: 'CIRCLE', layer, center: p2(e.center), r: round(e.radius) };
    case 'TEXT':
      return { type: 'TEXT', layer, at: p2(e.ins_pt ?? e.insertion_pt), text: e.text_value ?? e.text, h: round(e.height ?? 0) };
    case 'MTEXT':
      return { type: 'TEXT', layer, at: p2(e.ins_pt ?? e.insertion_pt), text: (e.text ?? '').replace(/\\[A-Za-z][^;]*;|[{}]/g, ''), h: round(e.text_height ?? 0) };
    case 'INSERT':
      return {
        type: 'INSERT',
        layer,
        block: blockByHandle.get(e.block_header?.[e.block_header.length - 1]) ?? '?',
        at: p2(e.ins_pt),
        rotation: round(((e.rotation ?? 0) * 180) / Math.PI),
        scale: p2(e.scale),
      };
    case 'DIMENSION_LINEAR':
      return { type: 'DIMENSION', layer, text: e.user_text || undefined, measurement: round(e.measurement ?? 0), a: p2(e.xline1_pt ?? e._13_pt), b: p2(e.xline2_pt ?? e._14_pt) };
    case 'POINT':
      return { type: 'POINT', layer, at: p2(e.point ?? [e.x, e.y]) };
    default:
      return null;
  }
}

const bboxOf = n => {
  const pts = [n.a, n.b, n.at, n.center, ...(n.points ?? [])].filter(Boolean);
  if (n.center && n.r) pts.push([n.center[0] - n.r, n.center[1] - n.r], [n.center[0] + n.r, n.center[1] + n.r]);
  if (!pts.length) return null;
  const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
};

// ——— INSERT expansion. In Vertex-style drawings the plan is not drawn in model space: model space
// holds a sheet, and the building arrives as blocks of real-millimetre geometry INSERTed at the plot
// scale (here 1WALLS_VXP at 0.02 = 1:50). Flattening inserts recursively puts every leaf entity in
// ONE coordinate frame; --units m then converts sheet-millimetres to metres via the plot scale.
const rawByOwner = new Map();
for (const o of objects)
  if (o.entity && o.entmode === 0) {
    const owner = o.ownerhandle?.[o.ownerhandle.length - 1];
    const list = rawByOwner.get(owner);
    if (list) list.push(o);
    else rawByOwner.set(owner, [o]);
  }
const blockHandleByName = new Map([...blockByHandle].map(([h, n]) => [n, h]));

const apply = (n, t) => {
  const pt = p => {
    if (!p) return p;
    const [x, y] = [p[0] * t.sx, p[1] * t.sy];
    const c = Math.cos(t.rot), s = Math.sin(t.rot);
    return [round(x * c - y * s + t.dx), round(x * s + y * c + t.dy)];
  };
  const out = { ...n };
  for (const k of ['a', 'b', 'at', 'center']) if (out[k]) out[k] = pt(out[k]);
  if (out.points) out.points = out.points.map(pt);
  if (out.r) out.r = round(out.r * Math.abs(t.sx));
  if (out.type === 'ARC') {
    out.start = round(out.start + (t.rot * 180) / Math.PI);
    out.end = round(out.end + (t.rot * 180) / Math.PI);
  }
  if (out.h) out.h = round(out.h * Math.abs(t.sx));
  return out;
};
function expand(raw, t, depth, out) {
  if (depth > 8) return;
  for (const e of raw) {
    if (e.entity === 'INSERT') {
      const targetHandle = e.block_header?.[e.block_header.length - 1];
      const inner = rawByOwner.get(targetHandle) ?? [];
      const rot = e.rotation ?? 0;
      const sx = (e.scale?.[0] ?? 1) * t.sx, sy = (e.scale?.[1] ?? 1) * t.sy;
      const c = Math.cos(t.rot), s = Math.sin(t.rot);
      const ix = (e.ins_pt?.[0] ?? 0) * t.sx, iy = (e.ins_pt?.[1] ?? 0) * t.sy;
      expand(inner, { dx: ix * c - iy * s + t.dx, dy: ix * s + iy * c + t.dy, rot: t.rot + rot, sx, sy }, depth + 1, out);
      continue;
    }
    const n = normalize(e);
    if (n) out.push(apply(n, t));
  }
}

let entities;
if (opt('expand')) {
  const modelRaw = objects.filter(o => o.entity && o.entmode === 2);
  entities = [];
  expand(modelRaw, { dx: 0, dy: 0, rot: 0, sx: 1, sy: 1 }, 0, entities);
  for (const e of entities) e.space = 'model';
  // Sheet millimetres → metres: multiply by plotScale/1000 (default 1:50 → ×0.05).
  if (opt('units', 'sheet') === 'm') {
    const k = Number(opt('plot-scale', 50)) / 1000;
    const scalePt = p => p && [round(p[0] * k), round(p[1] * k)];
    for (const e of entities) {
      for (const key of ['a', 'b', 'at', 'center']) if (e[key]) e[key] = scalePt(e[key]);
      if (e.points) e.points = e.points.map(scalePt);
      if (e.r) e.r = round(e.r * k);
      if (e.h) e.h = round(e.h * k);
    }
  }
} else {
  entities = objects
    .filter(o => o.entity)
    .map(e => {
      const n = normalize(e);
      if (n) n.space = spaceOf(e);
      return n;
    })
    .filter(Boolean);
}
void blockHandleByName;

// Default to the plan itself. --space paper for the sheet, --space blocks for symbol definitions,
// --space all when hunting for where something lives.
const space = opt('space', 'model');
if (space !== 'all')
  entities = entities.filter(e =>
    space === 'model' ? e.space === 'model' : space === 'paper' ? e.space === 'paper' : e.space !== 'model' && e.space !== 'paper',
  );

const layers = opt('layers');
if (typeof layers === 'string') {
  const re = new RegExp(layers);
  entities = entities.filter(e => re.test(e.layer));
}
const types = opt('types');
if (typeof types === 'string') {
  const wanted = new Set(types.split(','));
  entities = entities.filter(e => wanted.has(e.type));
}
const bbox = opt('bbox');
if (typeof bbox === 'string') {
  const [x0, y0, x1, y1] = bbox.split(',').map(Number);
  entities = entities.filter(e => {
    const b = bboxOf(e);
    return b && b[2] >= x0 && b[0] <= x1 && b[3] >= y0 && b[1] <= y1;
  });
}

if (opt('stats')) {
  const byLayer = new Map();
  for (const e of entities) {
    const s = byLayer.get(e.layer) ?? { count: 0, types: {}, bbox: null };
    s.count++;
    s.types[e.type] = (s.types[e.type] ?? 0) + 1;
    const b = bboxOf(e);
    if (b) s.bbox = s.bbox ? [Math.min(s.bbox[0], b[0]), Math.min(s.bbox[1], b[1]), Math.max(s.bbox[2], b[2]), Math.max(s.bbox[3], b[3])] : b;
    byLayer.set(e.layer, s);
  }
  const rows = [...byLayer].sort((a, b) => b[1].count - a[1].count);
  for (const [layer, s] of rows)
    console.log(
      `${String(s.count).padStart(5)}  ${layer.padEnd(30)} ${Object.entries(s.types).map(([t, n]) => `${t}:${n}`).join(' ')}  bbox ${s.bbox?.map(v => v.toFixed(0)).join(',')}`,
    );
  console.log(`TOTAL ${entities.length} entities on ${byLayer.size} layers`);
} else {
  const payload = JSON.stringify({ source: input, count: entities.length, entities });
  const out = opt('out');
  if (typeof out === 'string') {
    writeFileSync(out, payload);
    console.log(`${entities.length} entities -> ${out}`);
  } else console.log(payload);
}
