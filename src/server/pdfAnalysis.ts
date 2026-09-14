import type { PDFPageProxy } from 'pdfjs-dist/types/src/display/api';
import { vectorBounds, vectorPath, type SourceCandidate, type VectorCommand } from './analysis';

const rectangle = (b: number[]): VectorCommand[] => [
  ['M', b[0], b[1]],
  ['L', b[2], b[1]],
  ['L', b[2], b[3]],
  ['L', b[0], b[3]],
  ['Z'],
];
const multiply = (a: number[], b: number[]) => [
  a[0] * b[0] + a[2] * b[1],
  a[1] * b[0] + a[3] * b[1],
  a[0] * b[2] + a[2] * b[3],
  a[1] * b[2] + a[3] * b[3],
  a[0] * b[4] + a[2] * b[5] + a[4],
  a[1] * b[4] + a[3] * b[5] + a[5],
];
/** PDF.js 6 constructPath uses DrawOPS, not the public OPS.moveTo values. Keep an actual-PDF regression. */
function readPath(data: unknown): VectorCommand[] {
  if (!Array.isArray(data) && !ArrayBuffer.isView(data)) throw new Error('Unsupported PDF path encoding.');
  const values = Array.from(data as ArrayLike<number>);
  const path: VectorCommand[] = [];
  for (let i = 0; i < values.length; ) {
    const code = values[i++],
      op = ['M', 'L', 'C', 'Q', 'Z'][code],
      length = [2, 2, 6, 4, 0][code];
    if (length === undefined || i + length > values.length) throw new Error('Unsupported PDF drawing command.');
    path.push([op, ...values.slice(i, i + length)] as VectorCommand);
    i += length;
  }
  return path;
}
export async function extractPdfVectors(page: PDFPageProxy, ops: Record<string, number>) {
  // Extract before rasterization: PDF.js may replace cached typed paths with native Path2D objects.
  const list = await page.getOperatorList();
  const viewport = page.getViewport({ scale: 1 });
  type State = { matrix: number[]; clips: string[]; width: number; stroke: string; fill: string; unsupported: boolean };
  let state: State = {
    matrix: [...viewport.transform],
    clips: [],
    width: 1,
    stroke: '#000000',
    fill: '#000000',
    unsupported: false,
  };
  const stack: State[] = [];
  const candidates: SourceCandidate[] = [];
  const warnings = new Set<string>();
  let pendingClip: 'evenodd' | 'nonzero' | undefined;
  const save = () => stack.push({ ...state, matrix: [...state.matrix], clips: [...state.clips] });
  const restore = () => {
    state = stack.pop() ?? state;
  };
  const add = (
    kind: SourceCandidate['kind'],
    path: VectorCommand[],
    evidence: string,
    properties: Partial<SourceCandidate> = {},
  ) => {
    if (!path.length) return;
    const candidate: SourceCandidate = {
      id: `p${page.pageNumber}-v${candidates.length}`,
      kind,
      path,
      bounds: vectorBounds(path),
      evidence,
      ...properties,
    };
    candidates.push(candidate);
    if (candidates.length > 20_000) throw new Error('PDF has too many vector candidates. Use a simpler sheet.');
    return candidate.id;
  };
  const clip = (path: VectorCommand[], evidence: string, fillRule: 'evenodd' | 'nonzero' = 'nonzero') => {
    const id = add('clip', path, evidence, { fillRule });
    if (id) state.clips.push(id);
  };
  const fillOps = [ops.fill, ops.eoFill, ops.fillStroke, ops.eoFillStroke, ops.closeFillStroke, ops.closeEOFillStroke];
  const strokeOps = [
    ops.stroke,
    ops.closeStroke,
    ops.fillStroke,
    ops.eoFillStroke,
    ops.closeFillStroke,
    ops.closeEOFillStroke,
  ];
  for (let i = 0; i < list.fnArray.length; i++) {
    const fn = list.fnArray[i],
      args = list.argsArray[i] ?? [];
    if (fn === ops.save) save();
    else if (fn === ops.restore) restore();
    else if (fn === ops.transform) state.matrix = multiply(state.matrix, args);
    else if (fn === ops.setLineWidth) state.width = args[0];
    else if (fn === ops.setStrokeRGBColor) state.stroke = args[0];
    else if (fn === ops.setFillRGBColor) state.fill = args[0];
    else if (fn === ops.clip || fn === ops.eoClip) pendingClip = fn === ops.eoClip ? 'evenodd' : 'nonzero';
    else if (fn === ops.paintFormXObjectBegin) {
      save();
      if (args[0]) state.matrix = multiply(state.matrix, args[0]);
      if (args[1]) clip(vectorPath(rectangle(args[1]), state.matrix), `PDF form bounds at operator ${i}`);
    } else if (fn === ops.paintFormXObjectEnd) restore();
    else if (fn === ops.beginGroup || fn === ops.beginAnnotation) {
      save();
      state.unsupported = true;
      warnings.add(
        'Transparency groups and annotations are omitted from vector candidates; review the original page for these regions.',
      );
    } else if (fn === ops.endGroup || fn === ops.endAnnotation) restore();
    else if (fn === ops.setGState) {
      for (const [key, value] of args[0] ?? []) {
        if (key === 'LW') state.width = value;
        if (
          (key === 'SMask' && value) ||
          (['CA', 'ca'].includes(key) && value !== 1) ||
          (key === 'BM' && !['source-over', 'Normal'].includes(value))
        ) {
          state.unsupported = true;
          warnings.add('Masked, translucent or blended geometry is omitted; use a focused visual review.');
        }
      }
    } else if (fn === ops.constructPath) {
      if (state.unsupported) continue;
      let path: VectorCommand[];
      try {
        path = vectorPath(readPath(args[1]?.[0]), state.matrix);
      } catch {
        warnings.add('An unsupported PDF path was omitted. Native vector analysis is incomplete.');
        continue;
      }
      const paint = args[0],
        filled = fillOps.includes(paint),
        stroked = strokeOps.includes(paint);
      if (filled || stroked) {
        const scale = Math.sqrt(Math.abs(state.matrix[0] * state.matrix[3] - state.matrix[1] * state.matrix[2]));
        add('path', path, `PDF operator ${i}`, {
          ...(filled ? { fill: state.fill } : {}),
          ...(stroked ? { stroke: state.stroke, strokeWidth: state.width * scale } : {}),
          fillRule: [ops.eoFill, ops.eoFillStroke, ops.closeEOFillStroke].includes(paint) ? 'evenodd' : 'nonzero',
          ...(state.clips.length
            ? {
                clipIds: [...state.clips],
                uncertainty:
                  'Path coordinates precede clipping; inspect the clipping evidence before adopting geometry.',
              }
            : {}),
        });
      }
      if (pendingClip) {
        clip(path, `PDF clipping path at operator ${i}`, pendingClip);
        pendingClip = undefined;
      }
    } else if ([ops.paintImageXObject, ops.paintInlineImageXObject, ops.paintImageMaskXObject].includes(fn)) {
      add('image-region', vectorPath(rectangle([0, 0, 1, 1]), state.matrix), `PDF image at operator ${i}`, {
        uncertainty: 'Raster image region; wall extraction is not yet available.',
      });
      warnings.add('This page contains raster images. Vector paths alone may not describe the floor layout.');
    } else if ([ops.shadingFill, ops.rawFillPath, ops.setFillColorN, ops.setStrokeColorN].includes(fn))
      warnings.add(
        'Patterns, shadings or glyph outlines are not classified as geometry. Review the original where relevant.',
      );
  }
  const text = await page.getTextContent();
  for (const item of text.items)
    if ('str' in item && item.str.trim()) {
      const at = viewport.convertToViewportPoint(item.transform[4], item.transform[5]);
      add('label', [['M', at[0], at[1]]], 'PDF embedded text', {
        text: item.str.slice(0, 2000),
        strokeWidth: Math.max(1, item.height),
        uncertainty: 'Text position is the baseline anchor; not a wall measurement.',
      });
    }
  return { candidates, warnings: [...warnings] };
}
