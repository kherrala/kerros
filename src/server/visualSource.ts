import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import type { PlanSource } from './aiImport';
import { AnalysisStore, sourceHash } from './analysisStore';
import { extractPdfVectors } from './pdfAnalysis';
import type { SourceAnalysis, VectorBounds } from './analysis';
import { analyseRaster, analysisRequest, type RasterAnalysisOptions, type SourceAnalysisQuery } from './rasterAnalysis';

export const MAX_PDF_PAGES = 20;
const MAX_PIXELS = 40_000_000;
function dimensions(width: number, height: number) {
  if (!(width > 0 && height > 0) || width * height > MAX_PIXELS || Math.max(width, height) > 16000)
    throw new Error('Drawing is too large. Use an image under 40 megapixels and 16000 pixels per side.');
}
function crop(bbox: string | undefined, width: number, height: number) {
  const box = bbox ? bbox.split(',').map(Number) : [0, 0, width, height];
  const [x0, y0, x1, y1] = box;
  if (
    box.length !== 4 ||
    !box.every(Number.isFinite) ||
    x0 < 0 ||
    y0 < 0 ||
    x1 > width ||
    y1 > height ||
    x1 <= x0 ||
    y1 <= y0
  )
    throw new Error(`Crop must be x0,y0,x1,y1 inside 0,0,${width},${height}, with positive size.`);
  return [x0, y0, x1 - x0, y1 - y0];
}
function renderSize(width: number | undefined, w: number, h: number) {
  const requested = Number(width ?? 1400);
  if (!Number.isFinite(requested)) throw new Error('Render width must be a number.');
  const scale = Math.min(Math.max(400, Math.min(2000, requested)) / w, 2000 / h);
  return { scale, width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
}

/** PDFs and images are visual sources. Their coordinates are never represented as metre CAD data. */
export async function openVisualSource(
  path: string,
  options: { cacheDirectory?: string; raster?: RasterAnalysisOptions } = {},
): Promise<PlanSource & { close(): Promise<void> }> {
  const bytes = await readFile(path);
  const hash = sourceHash(bytes);
  const store = new AnalysisStore(hash, options.cacheDirectory);
  if (extname(path).toLowerCase() === '.pdf') {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const task = pdfjs.getDocument({ data: new Uint8Array(bytes), useSystemFonts: true, verbosity: 0 });
    const pdf = await task.promise;
    if (pdf.numPages > MAX_PDF_PAGES) {
      await task.destroy();
      throw new Error(`PDF has ${pdf.numPages} pages. Split it into files of at most ${MAX_PDF_PAGES} pages.`);
    }
    const getPage = (page = 1) => {
      if (!Number.isInteger(page) || page < 1 || page > pdf.numPages)
        throw new Error(`Choose a PDF page from 1 to ${pdf.numPages}.`);
      return pdf.getPage(page);
    };
    const analyseNative = async ({ page = 1 }: { page?: number } = {}) => {
      const p = await getPage(page);
      return store.get(page, async id => {
        const viewport = p.getViewport({ scale: 1 });
        return {
          version: 1,
          id,
          sourceHash: hash,
          sourceKind: 'pdf',
          units: 'pt',
          axis: 'y-down',
          page,
          bounds: [0, 0, viewport.width, viewport.height],
          ...(await extractPdfVectors(p, pdfjs.OPS)),
        };
      });
    };
    const analyse = async (query: SourceAnalysisQuery = {}) => {
      const request = analysisRequest(query);
      // PDF.js rendering can replace operator arrays with Path2D. Preserve native evidence first.
      const native = await analyseNative(request);
      const raster =
        request.mode === 'raster' ||
        (request.mode === 'auto' &&
          (request.symbol || request.bbox || native.candidates.some(c => c.kind === 'image-region')));
      if (!raster) return native;
      const region = request.bbox ?? native.bounds;
      const [x, y, w, h] = crop(region.join(','), native.bounds[2], native.bounds[3]);
      return store.get(
        request.page,
        async id => {
          const p = await getPage(request.page);
          const scale = Math.min(2, 2400 / Math.max(w, h));
          const canvas = createCanvas(Math.max(1, Math.round(w * scale)), Math.max(1, Math.round(h * scale)));
          await p.render({
            canvas: canvas as unknown as HTMLCanvasElement,
            canvasContext: canvas.getContext('2d') as unknown as CanvasRenderingContext2D,
            viewport: p.getViewport({ scale }),
            transform: [
              canvas.width / (w * scale),
              0,
              0,
              canvas.height / (h * scale),
              (-x * canvas.width) / w,
              (-y * canvas.height) / h,
            ],
            background: 'white',
          }).promise;
          const detected = await analyseRaster(canvas.toBuffer('image/png'), region, request, options.raster);
          return {
            ...native,
            id,
            ...detected,
            candidates: [...native.candidates, ...detected.candidates],
            warnings: [
              ...native.warnings.filter(w => !w.includes('raster analysis')),
              ...detected.warnings,
              'Native evidence and rendered raster proposals can overlap; they are alternatives, not additional walls.',
              ...(request.bbox
                ? ['Analysis crop may truncate walls/outline. Confirm exterior references against the complete page.']
                : []),
            ],
          };
        },
        JSON.stringify(request),
      );
    };
    return {
      kind: 'pdf',
      analyse,
      async stats() {
        const pages = [];
        for (let n = 1; n <= pdf.numPages; n++) {
          const viewport = (await getPage(n)).getViewport({ scale: 1 });
          pages.push({ page: n, width: viewport.width, height: viewport.height });
        }
        return JSON.stringify({
          type: 'PDF',
          pages,
          units:
            'PDF points, top-left origin, y down. Scale to metres using written dimensions. render and extract accept page (1-based).',
        });
      },
      async extract({ page }) {
        const p = await getPage(page);
        const viewport = p.getViewport({ scale: 1 });
        const content = await p.getTextContent();
        return JSON.stringify({
          page: page ?? 1,
          units: 'PDF points, top-left origin, y down',
          text: content.items.flatMap(item =>
            'str' in item
              ? [{ text: item.str, at: viewport.convertToViewportPoint(item.transform[4], item.transform[5]) }]
              : [],
          ),
        });
      },
      async render({ page, width, bbox }) {
        await analyseNative({ page });
        const p = await getPage(page);
        const raw = p.getViewport({ scale: 1 });
        const [x, y, w, h] = crop(bbox, raw.width, raw.height);
        const size = renderSize(width, w, h);
        const canvas = createCanvas(size.width, size.height);
        await p.render({
          canvas: canvas as unknown as HTMLCanvasElement,
          canvasContext: canvas.getContext('2d') as unknown as CanvasRenderingContext2D,
          viewport: p.getViewport({ scale: size.scale }),
          transform: [1, 0, 0, 1, -x * size.scale, -y * size.scale],
          background: 'white',
        }).promise;
        return {
          pngBase64: canvas.toBuffer('image/png').toString('base64'),
          note: `PDF page ${page ?? 1}; crop ${x},${y},${x + w},${y + h} page points; top-left origin, y down. Output ${size.width}×${size.height}px.`,
        };
      },
      close: () => task.destroy(),
    };
  }
  const img = await loadImage(bytes);
  dimensions(img.width, img.height);
  return {
    kind: 'image',
    analyse: async (query = {}) => {
      const request = analysisRequest(query);
      if (request.page !== 1) throw new Error('An image has only one page.');
      if (request.mode === 'native')
        throw new Error('Images have no native vectors. Use auto/raster for local OpenCV analysis.');
      const region: VectorBounds = request.bbox ?? [0, 0, img.width, img.height];
      const [x, y, w, h] = crop(region.join(','), img.width, img.height);
      return store.get(
        1,
        async id => {
          // Small exported plans often have 6–8 px lettering. Local upsampling helps
          // OCR/line segmentation, but does not add measurement precision.
          const scale = Math.min(3, 2400 / Math.max(w, h));
          const canvas = createCanvas(Math.max(1, Math.round(w * scale)), Math.max(1, Math.round(h * scale)));
          const context = canvas.getContext('2d');
          context.fillStyle = 'white';
          context.fillRect(0, 0, canvas.width, canvas.height);
          context.drawImage(img, x, y, w, h, 0, 0, canvas.width, canvas.height);
          const detected = await analyseRaster(canvas.toBuffer('image/png'), region, request, options.raster);
          return {
            version: 1,
            id,
            sourceHash: hash,
            page: 1,
            sourceKind: 'image',
            units: 'px',
            axis: 'y-down',
            bounds: [0, 0, img.width, img.height],
            ...detected,
            warnings: [
              ...detected.warnings,
              ...(request.bbox
                ? ['Analysis crop may truncate walls/outline. Confirm exterior references against the complete image.']
                : []),
            ],
          } satisfies SourceAnalysis;
        },
        JSON.stringify(request),
      );
    },
    async stats() {
      return JSON.stringify({
        type: 'image',
        width: img.width,
        height: img.height,
        units:
          'pixels, top-left origin, y down. No CAD entities. Read written dimensions or user instructions for metre scale.',
      });
    },
    async extract() {
      return 'This image has no CAD entities or embedded text. Use analyse_source and query_candidates for local OpenCV wall evidence and OCR labels; use render only for unresolved visual ambiguity.';
    },
    async render({ width, bbox }) {
      const [x, y, w, h] = crop(bbox, img.width, img.height);
      const size = renderSize(width, w, h);
      const canvas = createCanvas(size.width, size.height);
      const context = canvas.getContext('2d');
      context.fillStyle = 'white';
      context.fillRect(0, 0, size.width, size.height);
      context.drawImage(img, x, y, w, h, 0, 0, size.width, size.height);
      return {
        pngBase64: canvas.toBuffer('image/png').toString('base64'),
        note: `Image crop ${x},${y},${x + w},${y + h} source pixels; top-left origin, y down. Output ${size.width}×${size.height}px.`,
      };
    },
    async close() {},
  };
}
