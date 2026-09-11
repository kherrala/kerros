// Render a Kerros ProjectDocument to a plain SVG plan view — spaces as filled plates with names,
// barriers as strokes, openings as dots, other objects as outlines. This is the "what the document
// says" side of a visual diff against a rendering of the source drawing; both the apply CLI and the
// import agent use it, so a person and a vision model see the same picture.
import { barrierEnds, footprint, isSpace, objectPosition } from '../schema';
import type { ProjectDocument } from '../schema';

export function documentSvg(doc: ProjectDocument, width = 1600): string {
  const pts: [number, number][] = [];
  for (const o of doc.objects) for (const ring of o.rings ?? []) pts.push(...(ring as [number, number][]));
  for (const b of doc.barriers) pts.push(...barrierEnds(doc, b));
  if (!pts.length)
    return `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="60"><text x="10" y="30">empty document</text></svg>`;
  const xs = pts.map(p => p[0]),
    ys = pts.map(p => p[1]);
  const [x0, y0, x1, y1] = [Math.min(...xs) - 1, Math.min(...ys) - 1, Math.max(...xs) + 1, Math.max(...ys) + 1];
  const S = width / (x1 - x0),
    H = Math.round((y1 - y0) * S);
  const X = (v: number) => ((v - x0) * S).toFixed(1);
  const Y = (v: number) => ((y1 - v) * S).toFixed(1);
  const shapes: string[] = [];
  for (const o of doc.objects) {
    if (isSpace(o.kind) && o.rings?.length) {
      const d = o.rings.map(r => `M ${r.map(p => `${X(p[0])} ${Y(p[1])}`).join(' L ')} Z`).join(' ');
      shapes.push(`<path d="${d}" fill="#dde6da" fill-rule="evenodd" stroke="#7a8577" stroke-width="1"/>`);
      const at = objectPosition(doc, o);
      shapes.push(
        `<text x="${X(at[0])}" y="${Y(at[1])}" font-size="12" text-anchor="middle" fill="#3c4440">${o.name}</text>`,
      );
    }
  }
  for (const b of doc.barriers) {
    const [a, z] = barrierEnds(doc, b);
    // Square caps, not the default butt: two walls meeting at a shared corner junction each end at
    // the corner POINT, so butt caps leave the outer half-thickness quadrant of the corner bare.
    // A square cap extends each stroke by half its width — exactly filling that quadrant, the same
    // job the map's 'line-cap: round' does in the editor.
    shapes.push(
      `<line x1="${X(a[0])}" y1="${Y(a[1])}" x2="${X(z[0])}" y2="${Y(z[1])}" stroke="#2b2f2c" stroke-width="${Math.max(2, b.thickness * S)}" stroke-linecap="square"/>`,
    );
  }
  for (const o of doc.objects) {
    if (o.kind === 'door' || o.kind === 'window' || o.kind === 'gate') {
      const at = objectPosition(doc, o);
      shapes.push(
        `<circle cx="${X(at[0])}" cy="${Y(at[1])}" r="4" fill="${o.kind === 'window' ? '#4a90d9' : '#d97b4a'}"/>`,
      );
    } else if (!isSpace(o.kind)) {
      const b = footprint(o)[0];
      if (b?.length)
        shapes.push(
          `<path d="M ${b.map(p => `${X(p[0])} ${Y(p[1])}`).join(' L ')} Z" fill="none" stroke="#9a62c9" stroke-width="1"/>`,
        );
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${H}"><rect width="100%" height="100%" fill="white"/><g font-family="system-ui">${shapes.join('\n')}</g></svg>`;
}
