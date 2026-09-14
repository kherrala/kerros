import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import { openVisualSource } from '../../src/server/visualSource';
import { analysisSvg, calibrateSource, queryCandidates, type SourceAnalysis, type SourceCandidate } from '../../src/server/analysis';
import { SourceAnalysisTools } from '../../src/server/analysisTools';

// Native tests are explicit and deterministic. They NEVER create a model provider or read API keys.
const suite = process.env.KERROS_NATIVE_ANALYSIS_TESTS === '1' ? describe : describe.skip;
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fixture(bytes: Buffer, extension = 'png') {
  const dir = await mkdtemp(join(tmpdir(), 'kerros-raster-test-')); directories.push(dir);
  const path = join(dir, `plan.${extension}`); await writeFile(path, bytes);
  return { path, cacheDirectory: join(dir, 'cache') };
}
function drawing(width = 800, height = 600) {
  const canvas = createCanvas(width, height), c = canvas.getContext('2d');
  c.fillStyle = 'white'; c.fillRect(0, 0, width, height); c.strokeStyle = 'black'; c.fillStyle = 'black'; c.lineWidth = 12;
  const line = (x: number, y: number, xx: number, yy: number, thickness = 12) => {
    c.lineWidth = thickness; c.beginPath(); c.moveTo(x, y); c.lineTo(xx, yy); c.stroke();
  };
  return { canvas, c, line };
}
const walls = (a: SourceAnalysis) => a.candidates.filter(c => c.kind === 'wall');
function horizontal(c: SourceCandidate, y: number, x0: number, x1: number, tolerance = 2) {
  return Math.abs(c.bounds[1] - y) < tolerance && Math.abs(c.bounds[3] - y) < tolerance && c.bounds[0] <= x0 && c.bounds[2] >= x1;
}
async function analyse(bytes: Buffer, extension = 'png', ocr = false) {
  const file = await fixture(bytes, extension);
  const source = await openVisualSource(file.path, file);
  try { return await source.analyse!({ ocr }); } finally { await source.close(); }
}
// Binary-safe PDF with a raster page and native vector annotation, no external samples.
function scannedPdf(jpeg: Buffer) {
  const stream = Buffer.from('q 400 0 0 300 0 0 cm /Im0 Do Q\n0 0 0 RG 20 20 m 50 20 l S');
  const objects = [Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'), Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
    Buffer.from('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 300] /Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>'),
    Buffer.concat([Buffer.from(`<< /Length ${stream.length} >>\nstream\n`), stream, Buffer.from('\nendstream')]),
    Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width 800 /Height 600 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`), jpeg, Buffer.from('\nendstream')])];
  let pdf = Buffer.from('%PDF-1.4\n'); const offsets: number[] = [];
  objects.forEach((o, i) => { offsets.push(pdf.length); pdf = Buffer.concat([pdf, Buffer.from(`${i + 1} 0 obj\n`), o, Buffer.from('\nendobj\n')]); });
  const xref = pdf.length;
  return Buffer.concat([pdf, Buffer.from(`xref\n0 6\n0000000000 65535 f \n${offsets.map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`)]);
}

suite('local OpenCV source tools (no LLM)', () => {
  it('finds rotated/mirrored exemplars as bounded symbol hypotheses and rejects blank examples', async () => {
    const { canvas, c } = drawing();
    const symbol = createCanvas(54, 54), s = symbol.getContext('2d');
    s.fillStyle = 'white'; s.fillRect(0, 0, 54, 54); s.strokeStyle = 'black'; s.lineWidth = 2;
    s.beginPath(); s.moveTo(5, 5); s.lineTo(5, 49); s.arc(5, 5, 44, Math.PI / 2, 0, true); s.lineTo(5, 5); s.stroke();
    c.drawImage(symbol, 100, 100);
    c.save(); c.translate(400, 150); c.rotate(Math.PI / 2); c.drawImage(symbol, 0, 0); c.restore();
    c.save(); c.translate(550, 350); c.scale(-1, 1); c.drawImage(symbol, 0, 0); c.restore();
    c.strokeRect(230, 300, 54, 54); // Hard negative: a cupboard, not the arc example.
    const file = await fixture(canvas.toBuffer('image/png'));
    const source = await openVisualSource(file.path);
    try {
      const tools = new SourceAnalysisTools(source);
      const a = JSON.parse((await tools.execute('analyse_source', { ocr: false }))!);
      const matched = JSON.parse((await tools.execute('find_similar_symbols', { artifactId: a.artifactId, exemplarBounds: [100, 100, 154, 154], label: 'hinged door' }))!);
      expect(matched.artifactId).not.toBe(a.artifactId);
      const result = JSON.parse((await tools.execute('query_candidates', { artifactId: matched.artifactId, kind: 'symbol', minScore: .8 }))!);
      const hits: SourceCandidate[] = result.candidates;
      expect(hits).toHaveLength(2);
      expect(hits.some(c => Math.abs(c.bounds[0] - 346) < 3 && Math.abs(c.bounds[1] - 150) < 3)).toBe(true);
      expect(hits.some(c => Math.abs(c.bounds[0] - 496) < 3 && Math.abs(c.bounds[1] - 350) < 3)).toBe(true);
      expect(hits.every(c => c.uncertainty?.includes('no geometry'))).toBe(true);
      expect(JSON.stringify(result)).not.toContain('image_png');
      await expect(tools.execute('find_similar_symbols', { artifactId: a.artifactId, exemplarBounds: [10, 10, 40, 40], label: 'door' })).rejects.toThrow('little contrast');
      await expect(tools.execute('find_similar_symbols', { artifactId: a.artifactId, exemplarBounds: [-5, 0, 40, 40], label: 'door' })).rejects.toThrow('inside');
    } finally { await source.close(); }
  }, 60_000);
  it('measures filled walls and preserves a 60 px doorway without joining across it', async () => {
    const { canvas, line } = drawing();
    line(80, 160, 300, 160); line(360, 160, 700, 160);
    // Adjacent real walls must not become one wall in the empty space between them.
    line(80, 300, 700, 300, 10); line(80, 326, 700, 326, 10);
    const a = await analyse(canvas.toBuffer('image/png'));
    for (const [y, x0, x1, thickness] of [[160, 90, 290, 12], [160, 370, 690, 12], [300, 90, 690, 10], [326, 90, 690, 10]]) {
      const wall = walls(a).find(c => horizontal(c, y, x0, x1));
      expect(wall, JSON.stringify(walls(a))).toBeDefined();
      expect(Math.abs(wall!.thickness! - thickness)).toBeLessThan(2);
      expect(wall!.evidenceIds).toHaveLength(2);
    }
    expect(walls(a).some(c => horizontal(c, 160, 300, 360))).toBe(false);
    expect(walls(a).some(c => horizontal(c, 313, 100, 600))).toBe(false);
  }, 60_000);

  it('retains a partially filled wall and both sides of a T junction', async () => {
    const { canvas, c, line } = drawing();
    line(80, 160, 700, 160, 16);
    line(400, 160, 400, 280, 16);
    line(80, 420, 700, 420, 16);
    // Interrupted infill leaves both outer faces intact, as in a hatched partition.
    c.fillStyle = 'white';
    for (let x = 84; x < 698; x += 8) c.fillRect(x, 414, 2, 12);
    const a = await analyse(canvas.toBuffer('image/png'));
    expect(walls(a).some(c => horizontal(c, 160, 90, 380))).toBe(true);
    expect(walls(a).some(c => horizontal(c, 160, 420, 690))).toBe(true);
    expect(walls(a).some(c => horizontal(c, 420, 90, 690))).toBe(true);
  }, 60_000);

  it('pairs thin double-line wall faces, while retaining the uncertainty', async () => {
    const { canvas, line } = drawing();
    line(80, 190, 700, 190, 2); line(80, 204, 700, 204, 2);
    const a = await analyse(canvas.toBuffer('image/png'));
    const wall = walls(a).find(c => horizontal(c, 197, 90, 690));
    expect(wall, JSON.stringify(walls(a))).toBeDefined();
    expect(wall!.thickness).toBeGreaterThan(13);
    expect(wall!.thickness).toBeLessThan(18);
    expect(wall!.uncertainty).toContain('Parallel objects');
  }, 60_000);

  it('retains a 15 degree wall and reports the observed main axis without snapping its coordinates', async () => {
    const { canvas, line } = drawing();
    const angle = Math.PI / 12;
    line(100, 160, 100 + 550 * Math.cos(angle), 160 + 550 * Math.sin(angle));
    const a = await analyse(canvas.toBuffer('image/png'));
    const wall = walls(a).sort((a, b) => (b.bounds[2] - b.bounds[0]) - (a.bounds[2] - a.bounds[0]))[0];
    expect(wall).toBeDefined();
    const [p, q] = wall.path;
    expect(Math.atan2(Number(q[2]) - Number(p[2]), Number(q[1]) - Number(p[1])) * 180 / Math.PI).toBeCloseTo(15, 0);
    expect(a.raster!.mainAxes[0].degrees).toBeCloseTo(15, 0);
  }, 60_000);

  it('preserves an L-shaped exterior instead of calibrating its bounding rectangle as area', async () => {
    const { canvas, c } = drawing();
    c.beginPath(); c.moveTo(80, 80); c.lineTo(680, 80); c.lineTo(680, 280); c.lineTo(380, 280); c.lineTo(380, 520); c.lineTo(80, 520); c.closePath(); c.stroke();
    const a = await analyse(canvas.toBuffer('image/png'));
    const outline = a.candidates.find(c => c.kind === 'outline')!;
    expect(outline).toBeDefined(); expect(outline.path.length).toBeGreaterThan(5);
    const scale = calibrateSource(a, { widthMetres: 20 }, { referenceIds: [outline.id] });
    const result = queryCandidates(a, { ids: [outline.id] }, scale);
    expect(result.units).toBe('m');
    const b = 'candidates' in result && result.candidates[0].bounds;
    expect(b && b[2] - b[0]).toBeCloseTo(20, 4);
    // Actual polygon area ~204000 px²; its bounding box is ~277000 px².
    const byArea = calibrateSource(a, { footprintAreaM2: 204 }, { referenceIds: [outline.id] });
    expect(byArea.metresPerUnit).toBeGreaterThan(.030);
    expect(byArea.metresPerUnit).toBeLessThan(.033);
  }, 60_000);

  it('recognizes Finnish/English labels as text rather than wall candidates', async () => {
    const { canvas, c, line } = drawing();
    line(80, 80, 720, 80); line(80, 520, 720, 520);
    c.font = '36px DejaVu Sans'; c.fillText('KEITTIÖ', 220, 220); c.fillText('WC', 220, 330); c.fillText('20 m', 480, 420);
    const a = await analyse(canvas.toBuffer('image/png'), 'png', true);
    const labels = a.candidates.filter(c => c.kind === 'label');
    expect(labels.map(c => c.text).join(' ')).toContain('KEITTIÖ');
    expect(labels.map(c => c.text)).toContain('WC');
    expect(labels.map(c => c.text).join(' ')).toContain('20');
    // OCR unit/word segmentation can differ; it must remain explicitly uncertain evidence.
    expect(labels.every(c => c.uncertainty?.includes('units'))).toBe(true);
    expect(walls(a).filter(c => c.bounds[1] > 150 && c.bounds[3] < 460)).toHaveLength(0);
  }, 60_000);

  it('analyses a compressed scan and keeps thin page borders out of outline candidates', async () => {
    const { canvas, c, line } = drawing();
    c.lineWidth = 1; c.strokeRect(5, 5, 790, 590);
    c.lineWidth = 12; c.strokeRect(80, 80, 640, 440);
    line(80, 200, 700, 200);
    const file = await fixture(await canvas.encode('jpeg', 45), 'jpeg');
    const source = await openVisualSource(file.path);
    try {
      const a = await source.analyse!({ profile: 'scan', ocr: false });
      expect(walls(a).some(c => horizontal(c, 200, 90, 690))).toBe(true);
      expect(a.candidates.some(c => c.kind === 'outline' && c.bounds[0] < 20)).toBe(false);
      expect(a.candidates.some(c => c.kind === 'outline' && Math.abs(c.bounds[0] - 74) < 3)).toBe(true);
    } finally { await source.close(); }
  }, 60_000);

  it('maps a resized crop back to original pixels and caches distinct options across source reopen', async () => {
    const { canvas, line } = drawing(4800, 3000);
    line(1000, 1200, 3600, 1200, 40);
    const file = await fixture(canvas.toBuffer('image/png'));
    const source = await openVisualSource(file.path, file);
    const query = { bbox: [800, 600, 3800, 2400] as [number, number, number, number], ocr: false };
    let a: SourceAnalysis;
    try {
      a = await source.analyse!(query);
      const wall = walls(a).find(c => horizontal(c, 1200, 1020, 3580, 3))!;
      expect(wall).toBeDefined(); expect(Math.abs(wall.thickness! - 40)).toBeLessThan(3);
      expect(a.raster!.rasterToSource).toEqual([1.25, 0, 0, 1.25, 800, 600]);
      const t = calibrateSource(a, undefined, { referenceIds: [wall.id], realLengthMetres: 20 });
      const measured = queryCandidates(a, { ids: [wall.id] }, t);
      expect('candidates' in measured && measured.candidates[0].thickness).toBeCloseTo(40 / 2600 * 20, 1);
      expect((await source.analyse!({ ...query, profile: 'scan' })).id).not.toBe(a.id);
      await expect(source.analyse!({ bbox: [-1, 0, 200, 200], ocr: false })).rejects.toThrow('Crop');
    } finally { await source.close(); }
    // A nonexistent worker proves reopen reads the saved artifact without doing native work again.
    const reopened = await openVisualSource(file.path, { ...file, raster: { python: '/no-python-here' } });
    try { expect(await reopened.analyse!(query)).toEqual(a!); } finally { await reopened.close(); }
  }, 60_000);

  it('analyses a mixed/scanned PDF locally, retaining native evidence and original PDF point coordinates', async () => {
    const { canvas, line } = drawing(); line(80, 160, 700, 160);
    const file = await fixture(scannedPdf(await canvas.encode('jpeg', 95)), 'pdf');
    const source = await openVisualSource(file.path, file);
    try {
      // Rendering first must not consume the operator arrays before vector extraction.
      await source.render({ width: 500 });
      const a = await source.analyse!({ ocr: false });
      expect(a.units).toBe('pt'); expect(a.bounds).toEqual([0, 0, 400, 300]);
      const wall = walls(a).find(c => horizontal(c, 80, 45, 345, 1))!;
      expect(wall).toBeDefined(); expect(wall.thickness).toBeCloseTo(6, 0);
      expect(a.candidates.some(c => c.kind === 'image-region')).toBe(true);
      const native = await source.analyse!({ mode: 'native' });
      expect(walls(native)).toHaveLength(0); expect(native.candidates.some(c => c.kind === 'path')).toBe(true);
      expect(native.id).not.toBe(a.id);
      const tools = new SourceAnalysisTools(source);
      const summary = JSON.parse((await tools.execute('analyse_source', { ocr: false }))!);
      const result = (await tools.execute('query_candidates', { artifactId: summary.artifactId, kind: 'wall' }))!;
      expect(result).not.toContain('image_png'); expect(result.length).toBeLessThanOrEqual(12000);
      expect(analysisSvg(a)).toContain('data-layer="wall-centrelines"');
      expect(analysisSvg(a)).not.toContain('<image');
    } finally { await source.close(); }
  }, 60_000);
});
