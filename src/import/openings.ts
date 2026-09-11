// Opening resolution. Two different sources of truth, learned from the drawings themselves:
//
// ENVELOPE walls: the face layers alternate coverage along the wall (each layer's "gaps" are the
// other's segments), so face breaks say nothing about openings there. What does is the SYMBOL
// geometry — a door leaf and swing, a window's sill-and-frame block — which always stands in the
// opening it fills. Envelope openings are therefore symbol clusters projected onto the wall.
//
// PARTITION walls: both faces genuinely break at every opening, so the paired gap IS the opening;
// symbols only decide its kind. A partition gap with no symbol at all is a doorless passage —
// modelled as NO wall (the barrier splits around it), not as a sealed one.
import type { Point } from '../schema';
import { along, type Wall } from './walls';

export interface ResolvedOpening {
  kind: 'door' | 'window';
  /** Along-axis centre and width, in the wall's own coordinate. */
  centre: number;
  width: number;
}
export interface GapResolution {
  gap: [number, number];
  openings: ResolvedOpening[];
  /** A stretch with no wall at all — the barrier must be split around it. */
  passage?: [number, number];
}

/** Along-coordinates of the symbol points standing in this wall's band. */
const inBand = (pts: Point[], w: Wall, lo: number, hi: number): number[] =>
  pts
    .filter(p => {
      const alongP = w.axis === 'h' ? p[0] : p[1];
      const crossP = w.axis === 'h' ? p[1] : p[0];
      return alongP > lo - 0.1 && alongP < hi + 0.1 && Math.abs(crossP - w.c) < 0.9;
    })
    .map(p => (w.axis === 'h' ? p[0] : p[1]));

/** 1D clustering along the wall: sorted alongs split wherever consecutive points sit further apart
 *  than `split`. Small or short clusters are noise, not openings. */
function clusters(alongs: number[], split: number, minPoints: number, minExtent: number): [number, number][] {
  const sorted = [...alongs].sort((a, b) => a - b);
  const out: [number, number][] = [];
  let start = 0;
  for (let i = 1; i <= sorted.length; i++) {
    if (i === sorted.length || sorted[i] - sorted[i - 1] > split) {
      const size = i - start;
      const extent = sorted[i - 1] - sorted[start];
      if (size >= minPoints && extent >= minExtent) out.push([sorted[start], sorted[i - 1]]);
      start = i;
    }
  }
  return out;
}

/** Envelope openings: door and window symbol clusters projected onto the wall. Door clusters win
 *  where the two overlap — a swing sweeps across the window symbols beside it. */
export function resolveEnvelopeOpenings(w: Wall, doorPts: Point[], windowPts: Point[]): ResolvedOpening[] {
  const doors = clusters(inBand(doorPts, w, w.lo, w.hi), 0.4, 3, 0.5).map(
    ([lo, hi]): ResolvedOpening => ({
      kind: 'door',
      centre: (lo + hi) / 2,
      width: Math.min(3, Math.max(0.8, hi - lo + 0.15)),
    }),
  );
  const windows = windowsFromJambs(inBand(windowPts, w, w.lo, w.hi)).filter(
    win => !doors.some(d => Math.abs(d.centre - win.centre) < (d.width + win.width) / 2 + 0.1),
  );
  return [...doors, ...windows];
}

/** Read windows off their jambs.
 *
 *  A window symbol is not one blob of geometry: it is a dense little block at each jamb with the
 *  glass between them drawn as nothing at all. So the biggest gap in a window is INSIDE it — around
 *  0.7 m for an ordinary casement — while the gap between two windows in a bank is the mullion, a
 *  tenth of a metre. Clustering by gap size therefore cannot work and did not: splitting on anything
 *  wide enough to separate two windows split every window down its own middle, and the halves were
 *  then too short to count as openings and were dropped. A three-window bank imported as no windows
 *  at all.
 *
 *  Reading it as the drawing draws it: cluster tightly to find the jambs, then take each consecutive
 *  PAIR of jambs a plausible pane apart as one window. A gap too narrow to be glass is the mullion
 *  between two windows, and the walk simply steps over it to start the next pair. */
function windowsFromJambs(alongs: number[]): ResolvedOpening[] {
  // 80 mm: wider than the few centimetres a jamb block spans, narrower than any mullion.
  const jambs = clusters(alongs, 0.08, 1, 0);
  const out: ResolvedOpening[] = [];
  for (let i = 0; i + 1 < jambs.length; ) {
    const glass = jambs[i + 1][0] - jambs[i][1];
    // A pane: too narrow and this is a mullion between two windows, too wide and the two jambs
    // belong to different openings with a stretch of blank wall between them.
    if (glass >= 0.25 && glass <= 3) {
      const lo = jambs[i][0],
        hi = jambs[i + 1][1];
      out.push({ kind: 'window', centre: (lo + hi) / 2, width: Math.max(0.4, hi - lo) });
      i += 2;
    } else i += 1;
  }
  return out;
}

/** Partition gaps: the gap is the opening; symbols say the kind, and no symbol means a passage. */
export function resolvePartitionGap(
  w: Wall,
  gap: [number, number],
  doorPts: Point[],
  windowPts: Point[],
): GapResolution {
  const [glo, ghi] = gap;
  const doors = inBand(doorPts, w, glo, ghi);
  const windows = inBand(windowPts, w, glo, ghi);
  if (doors.length >= 2) {
    const lo = Math.max(glo, Math.min(...doors));
    const hi = Math.min(ghi, Math.max(...doors));
    const width = Math.min(ghi - glo, Math.max(0.8, hi - lo + 0.2));
    const centre = Math.min(ghi - width / 2, Math.max(glo + width / 2, (lo + hi) / 2));
    return { gap, openings: [{ kind: 'door', centre, width }] };
  }
  if (windows.length >= 2)
    return { gap, openings: [{ kind: 'window', centre: (glo + ghi) / 2, width: Math.min(3, ghi - glo) }] };
  return { gap, openings: [], passage: gap };
}

/** The barrier spans a wall keeps once its passages are cut out of it. */
export function barrierSpans(w: Wall, passages: [number, number][]): [number, number][] {
  const sorted = [...passages].sort((x, y) => x[0] - y[0]);
  const spans: [number, number][] = [];
  let start = w.lo;
  for (const [plo, phi] of sorted) {
    if (plo > start) spans.push([start, plo]);
    start = Math.max(start, phi);
  }
  if (w.hi > start) spans.push([start, w.hi]);
  return spans;
}

export const openingLabel = (w: Wall, o: ResolvedOpening) =>
  along(w, o.centre)
    .map(v => v.toFixed(1))
    .join(',');
