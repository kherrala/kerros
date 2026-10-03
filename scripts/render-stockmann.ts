// Render the actual sample geometry into a review atlas, individual SVG/PNG plans and portable JSON.
// Run: npm run render:stockmann -- --out .cache/stockmann-plans
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { createDemo } from '../app/demo/demo';
import {
  barrierEnds,
  centroid,
  footprint,
  objectArea,
  objectPosition,
  pointInRing,
} from '../src/model/geometry';
import { isArea, type Point, type ProjectDocument, type Ring } from '../src/model/types';
import { isVertical } from '../src/model/vertical';
import { validateProject } from '../src/model/validate';

const option = (name: string) => {
  const at = process.argv.indexOf(`--${name}`);
  return at < 0 ? undefined : process.argv[at + 1];
};
const out = resolve(option('out') ?? '.cache/stockmann-plans');
const source = option('input');
const project: ProjectDocument = validateProject(source ? JSON.parse(readFileSync(source, 'utf8')) : createDemo());
mkdirSync(out, { recursive: true });
writeFileSync(`${out}/project.json`, JSON.stringify(project));
const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
const floors = [...project.floors].sort((a, b) => a.elevation - b.elevation);
const width = 1400,
  height = 1500;
const atlas = createCanvas(4 * 560, Math.ceil(floors.length / 4) * 620);
const ctx = atlas.getContext('2d');
ctx.fillStyle = '#edf0f3';
ctx.fillRect(0, 0, atlas.width, atlas.height);
const summaries: object[] = [];
for (const [index, floor] of floors.entries()) {
  const objects = project.objects.filter(o => o.floorId === floor.id);
  const areas = objects.filter(o => isArea(o.kind) && o.rings?.length);
  const plate = areas
    .filter(o => o.kind === 'zone' && !o.parentId && !o.slope)
    .sort((a, b) => objectArea(b) - objectArea(a))[0];
  const points = plate?.rings?.[0] ?? areas.flatMap(o => o.rings![0]);
  const xs = points.map(p => p[0]),
    ys = points.map(p => p[1]);
  const box = [Math.min(...xs) - 5, Math.min(...ys) - 5, Math.max(...xs) + 5, Math.max(...ys) + 5];
  const scale = Math.min((width - 100) / (box[2] - box[0]), (height - 220) / (box[3] - box[1]));
  const x = (n: number) => 50 + (width - 100 - (box[2] - box[0]) * scale) / 2 + (n - box[0]) * scale;
  const y = (n: number) => 125 + (height - 220 - (box[3] - box[1]) * scale) / 2 + (box[3] - n) * scale;
  const path = (rings: Ring[]) =>
    rings
      .map(r => `${r.map((p, i) => `${i ? 'L' : 'M'}${x(p[0]).toFixed(2)},${y(p[1]).toFixed(2)}`).join('')}Z`)
      .join('');
  const draw = (rings: Ring[], fill: string, stroke: string, weight = 1) =>
    `<path d="${path(rings)}" fill="${fill}" fill-rule="evenodd" stroke="${stroke}" stroke-width="${weight}"/>`;
  const line = (a: Point, b: Point, color: string, weight: number) =>
    `<path d="M${x(a[0])},${y(a[1])}L${x(b[0])},${y(b[1])}" stroke="${color}" stroke-width="${weight}"/>`;
  const labels: string[] = [],
    shapes: string[] = [];
  const labelled = new Set<string>();
  for (const o of [...areas].sort(
    (a, b) => Number(a.kind === 'room') - Number(b.kind === 'room') || objectArea(b) - objectArea(a),
  )) {
    const circulation =
      o.category === 'circulation' || /gallery|lobb|corridor|promenade|concourse|aisle|passage/i.test(o.name);
    shapes.push(draw(o.rings!, circulation ? '#cce7ed' : (o.color ?? '#eee6d5'), circulation ? '#83b8c5' : '#b7b5ae'));
    if (o.kind !== 'room' || objectArea(o) < 20 || /bay /i.test(o.name)) continue;
    const key = o.name.replace(/ · \d+$/, '');
    if (labelled.has(key)) continue;
    labelled.add(key);
    const label = pointInRing(o.position, o.rings![0]) ? o.position : centroid(o.rings![0]);
    if (o.rings!.slice(1).some(r => pointInRing(label, r))) continue;
    const words = o.name.split(' '),
      rows: string[] = [];
    for (const word of words) {
      if (!rows.length || `${rows.at(-1)} ${word}`.length > 24) rows.push(word);
      else rows[rows.length - 1] += ` ${word}`;
    }
    labels.push(
      `<text x="${x(label[0])}" y="${y(label[1])}" font-size="${circulation ? 13 : 12}" font-weight="${circulation ? 600 : 400}" text-anchor="middle" fill="#243945">${rows
        .slice(0, 3)
        .map((row, i) => `<tspan x="${x(label[0])}" dy="${i ? 14 : 0}">${escape(row)}</tspan>`)
        .join('')}</text>`,
    );
  }
  for (const o of objects.filter(o => o.kind === 'fixture'))
    shapes.push(draw(footprint(o), o.model === 'post' ? '#40525b' : (o.color ?? '#b5aba0'), '#7f8b91', 0.7));
  for (const wall of project.barriers.filter(b => b.floorId === floor.id))
    shapes.push(line(...barrierEnds(project, wall), '#343d44', Math.max(1.5, wall.thickness * scale)));
  for (const o of objects.filter(o => o.barrierId)) {
    const wall = project.barriers.find(b => b.id === o.barrierId)!;
    const [a, b] = barrierEnds(project, wall),
      len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const at = objectPosition(project, o),
      ux = (b[0] - a[0]) / len,
      uy = (b[1] - a[1]) / len;
    const l: Point = [at[0] - (ux * o.width) / 2, at[1] - (uy * o.width) / 2],
      r: Point = [at[0] + (ux * o.width) / 2, at[1] + (uy * o.width) / 2];
    shapes.push(line(l, r, '#fff', wall.thickness * scale + 2));
    shapes.push(line(l, r, o.kind === 'window' ? '#58a2c0' : '#af7231', o.kind === 'window' ? 2 : 1));
    if (o.kind === 'door') {
      const tip: Point = [l[0] - uy * o.width, l[1] + ux * o.width];
      shapes.push(line(l, tip, '#af7231', 1.2));
      shapes.push(
        `<path d="M${x(r[0])},${y(r[1])}A${o.width * scale},${o.width * scale} 0 0 0 ${x(tip[0])},${y(tip[1])}" stroke="#af7231" fill="none" stroke-width="1"/>`,
      );
    }
  }
  for (const o of project.objects.filter(
    o => isVertical(o.kind) && (o.servedFloorIds ?? [o.floorId]).includes(floor.id),
  )) {
    shapes.push(draw(footprint(o), o.kind === 'elevator' ? '#ead0a7' : '#c7cee7', '#62647e', 1.5));
    const label =
      o.kind === 'elevator'
        ? o.name.replace('Lift ', 'L')
        : o.stairModel === 'escalator'
          ? o.travel === 'up'
            ? '↑'
            : '↓'
          : 'S';
    shapes.push(
      `<text x="${x(o.position[0])}" y="${y(o.position[1]) + 5}" text-anchor="middle" font-size="14" fill="#38444f">${escape(label)}</text>`,
    );
  }
  const walls = project.barriers.filter(b => b.floorId === floor.id).length;
  const rooms = objects.filter(o => o.kind === 'room').length;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" font-family="Arial, sans-serif"><rect width="100%" height="100%" fill="#fff"/><text x="45" y="48" font-size="30" font-weight="700" fill="#193342">${escape(floor.code ?? '')} · ${escape(floor.name)}</text><text x="45" y="82" font-size="16" fill="#677984">${floor.elevation} m · ${rooms} spaces · ${walls} wall segments · illustrative layout, not surveyed</text><clipPath id="plan"><rect x="25" y="110" width="1350" height="1310"/></clipPath><g clip-path="url(#plan)">${shapes.join('')}${labels.join('')}</g><text x="45" y="1470" font-size="16" fill="#677984">Blue: circulation · Ochre: lifts / doors · Indigo: stairs / escalators · Cyan: windows</text><path d="M${width - 50 - 10 * scale},1450h${10 * scale}" stroke="#283d48" stroke-width="3"/><text x="${width - 50 - 5 * scale}" y="1480" text-anchor="middle" font-size="16">10 m</text></svg>`;
  writeFileSync(`${out}/${floor.id}.svg`, svg);
  const picture = await loadImage(Buffer.from(svg));
  const canvas = createCanvas(width, height);
  canvas.getContext('2d').drawImage(picture, 0, 0);
  writeFileSync(`${out}/${floor.id}.png`, canvas.toBuffer('image/png'));
  ctx.drawImage(picture, (index % 4) * 560, Math.floor(index / 4) * 620, 560, 600);
  summaries.push({ floor: floor.code, name: floor.name, rooms, walls });
}
writeFileSync(`${out}/atlas.png`, atlas.toBuffer('image/png'));
writeFileSync(
  `${out}/index.html`,
  `<!doctype html><html lang="en"><meta charset="utf-8"><title>Stockmann plan review</title><style>body{font:16px system-ui;background:#eaf0f3;margin:2rem;color:#193342}main{display:grid;grid-template-columns:repeat(auto-fit,minmax(420px,1fr));gap:1rem}img{width:100%;background:white}a{color:inherit}</style><h1>Stockmann · floor plan review</h1><p>Illustrative layouts within the sample footprint. Open a plan for the full vector drawing.</p><main>${floors.map(f => `<a href="${f.id}.svg"><img src="${f.id}.png" alt="${escape(f.name)}"/></a>`).join('')}</main></html>`,
);
console.log(JSON.stringify(summaries, null, 2));
console.log(`Plans written to ${out}`);
