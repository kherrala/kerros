import { createCanvas } from '@napi-rs/canvas';

/** PDF reference drawing conversion without any model/provider access. */
export async function renderPdfDrawing(bytes: Uint8Array, page = 1): Promise<Uint8Array> {
  if (bytes.byteLength > 25 * 1024 * 1024) throw new Error('Choose a PDF under 25 MB.');
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), useSystemFonts: true, verbosity: 0 });
  try {
    const pdf = await task.promise;
    if (!Number.isInteger(page) || page < 1 || page > pdf.numPages)
      throw new Error(`Choose a page between 1 and ${pdf.numPages}.`);
    const p = await pdf.getPage(page),
      natural = p.getViewport({ scale: 1 });
    const scale = Math.min(2, 4096 / Math.max(natural.width, natural.height));
    const viewport = p.getViewport({ scale });
    if (!(viewport.width > 0 && viewport.height > 0) || !Number.isFinite(viewport.width + viewport.height))
      throw new Error('Invalid PDF page dimensions.');
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    await p.render({
      canvas: canvas as unknown as HTMLCanvasElement,
      canvasContext: canvas.getContext('2d') as unknown as CanvasRenderingContext2D,
      viewport,
      background: 'white',
    }).promise;
    return canvas.toBuffer('image/png');
  } finally {
    await task.destroy();
  }
}
