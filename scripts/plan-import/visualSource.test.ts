import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { openVisualSource } from '../../src/server/visualSource';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fixture(name: string, content: Buffer) { const path = await mkdtemp(join(tmpdir(), 'kerros-source-test-')); directories.push(path); await writeFile(join(path, name), content); return join(path, name); }

it.each(['png', 'jpeg', 'webp'] as const)('renders and crops %s sources without pretending pixels are metres', async format => {
  const canvas = createCanvas(200, 100);
  const context = canvas.getContext('2d'); context.fillStyle = 'red'; context.fillRect(0, 0, 100, 100); context.fillStyle = 'blue'; context.fillRect(100, 0, 100, 100);
  const path = await fixture(`plan.${format}`, format === 'png' ? await canvas.encode('png') : await canvas.encode(format));
  const source = await openVisualSource(path);
  expect(await source.stats()).toContain('pixels');
  expect(await source.extract({})).toContain('no CAD entities');
  const result = await source.render({ bbox: '100,0,200,100', width: 500 });
  const image = await loadImage(Buffer.from(result.pngBase64, 'base64'));
  expect([image.width, image.height]).toEqual([500, 500]);
  const sampled = createCanvas(1, 1); sampled.getContext('2d').drawImage(image, 0, 0, 1, 1);
  expect(sampled.getContext('2d').getImageData(0, 0, 1, 1).data[2]).toBeGreaterThan(200);
  await expect(source.render({ bbox: '-1,0,10,10' })).rejects.toThrow('Crop');
  await source.close();
});

// Minimal two-page PDF, with different colours and selectable text; no external fixture download.
export function samplePdf() {
  const stream = (color: string, text: string) => `${color} rg 0 0 200 100 re f BT /F1 12 Tf 10 40 Td (${text}) Tj ET`;
  const a = stream('1 0 0', 'Ground floor'), b = stream('0 0 1', 'Upper floor');
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    ...[5, 6].map(n => `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Resources << /Font << /F1 7 0 R >> >> /Contents ${n} 0 R >>`),
    ...[a, b].map(s => `<< /Length ${s.length} >>\nstream\n${s}\nendstream`), '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  let pdf = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((o, i) => { offsets.push(pdf.length); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = pdf.length;
  pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n${offsets.slice(1).map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf);
}
it('renders the selected PDF page and reads its dimension labels', async () => {
  const source = await openVisualSource(await fixture('plan.pdf', samplePdf()));
  try {
    expect(await source.stats()).toContain('"page":2');
    expect(await source.extract({ page: 2 })).toContain('Upper floor');
    expect(await source.extract({ page: 1 })).toContain('Ground floor');
    const result = await source.render({ page: 2, width: 500 });
    const image = await loadImage(Buffer.from(result.pngBase64, 'base64'));
    expect([image.width, image.height]).toEqual([500, 250]);
    expect(result.note).toContain('PDF page 2');
    await expect(source.render({ page: 3 })).rejects.toThrow('Choose a PDF page');
  } finally { await source.close(); }
});
