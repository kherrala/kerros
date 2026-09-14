import { afterEach, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openVisualSource } from '../../src/server/visualSource';
import { analysisSvg, queryCandidates } from '../../src/server/analysis';
import { renderPdfDrawing } from '../../src/server/pdfDrawing';
import { loadImage } from '@napi-rs/canvas';

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(d => rm(d, { force: true, recursive: true }))); });
function pdf(content: string, rotate = 0) {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Rotate ${rotate} /Resources << >> /Contents 4 0 R >>`, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`];
  let s = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((o, i) => { offsets.push(s.length); s += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = s.length;
  s += `xref\n0 ${offsets.length}\n0000000000 65535 f \n${offsets.slice(1).map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(s);
}
async function fixture(content: Buffer) {
  const dir = await mkdtemp(join(tmpdir(), 'kerros-vector-test-')); dirs.push(dir);
  const path = join(dir, 'plan.pdf'); await writeFile(path, content);
  return { path, cacheDirectory: join(dir, 'cache') };
}

it('extracts PDF paths with nested transforms, clipping and restored graphics state', async () => {
  const f = await fixture(pdf('q 2 0 0 2 10 5 cm 0 0 20 10 re W n 1 w 0 0 m 30 0 l S Q 0 0 1 RG 50 20 m 70 20 l S'));
  const source = await openVisualSource(f.path, f);
  try {
    const a = await source.analyse!({});
    const paths = a.candidates.filter(c => c.kind === 'path');
    expect(paths).toHaveLength(2);
    expect(paths[0].path).toEqual([['M', 10, 95], ['L', 70, 95]]);
    expect(paths[0].strokeWidth).toBe(2);
    expect(paths[0].clipIds).toHaveLength(1);
    expect(paths[1].path).toEqual([['M', 50, 80], ['L', 70, 80]]);
    expect(paths[1].clipIds).toBeUndefined();
    expect(a.candidates.find(c => c.kind === 'clip')?.bounds).toEqual([10, 75, 50, 95]);
    expect(analysisSvg(a)).toContain('clip-path="url(#');
    await source.render({ width: 400 });
    expect(await source.analyse!({})).toEqual(a);
    const result = queryCandidates(a);
    expect('candidates' in result && result.candidates).toHaveLength(3);
  } finally { await source.close(); }
});

it('preserves page rotation and reuses persistent artifacts after reopening the source', async () => {
  const f = await fixture(pdf('50 20 m 70 20 l S', 90));
  const source = await openVisualSource(f.path, f);
  const a = await source.analyse!({}); await source.close();
  expect(a.bounds).toEqual([0, 0, 100, 200]);
  expect(a.candidates[0].path).toEqual([['M', 20, 50], ['L', 20, 70]]);
  const files = await readdir(f.cacheDirectory);
  expect(files).toContain(`${a.id}.json`); expect(files).toContain(`${a.id}.svg`);
  expect(await readFile(join(f.cacheDirectory, `${a.id}.svg`), 'utf8')).toContain('<svg');
  const again = await openVisualSource(f.path, f);
  try { expect(await again.analyse!({})).toEqual(a); } finally { await again.close(); }
  await writeFile(join(f.cacheDirectory, `${a.id}.json`), '{broken');
  const repaired = await openVisualSource(f.path, f);
  try { expect(await repaired.analyse!({})).toEqual(a); } finally { await repaired.close(); }
});

it('renders reference PDFs locally without a provider or API key and validates page selection', async () => {
  const bytes = pdf('1 0 0 rg 0 0 200 100 re f');
  const image = await loadImage(Buffer.from(await renderPdfDrawing(bytes)));
  expect([image.width, image.height]).toEqual([400, 200]);
  await expect(renderPdfDrawing(bytes, 2)).rejects.toThrow('between 1 and 1');
});
