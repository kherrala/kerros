/** App-owned procedural office layout. Coordinates here are grid cells, not metres. */
export interface OfficeRoom {
  x: number;
  y: number;
  width: number;
  depth: number;
  noise: number;
}
export interface OfficeBoundary {
  a: number;
  /** -1 is the outside of the floor. */
  b: number;
  start: [number, number];
  end: [number, number];
  passage: boolean;
}
export interface OfficeLayout {
  columns: number;
  rows: number;
  rooms: OfficeRoom[];
  boundaries: OfficeBoundary[];
  /** One room index for every cell; useful for previews and coverage checks. */
  cells: number[];
}

export function seedNumber(seed: string): number {
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i++) hash = Math.imul(hash ^ seed.charCodeAt(i), 16777619);
  return hash >>> 0;
}
function random(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
const smooth = (t: number) => t * t * (3 - 2 * t);
function noiseAt(x: number, y: number, seed: number): number {
  const ix = Math.floor(x),
    iy = Math.floor(y);
  const u = smooth(x - ix),
    v = smooth(y - iy);
  const at = (dx: number, dy: number) => random(seed ^ Math.imul(ix + dx, 374761393) ^ Math.imul(iy + dy, 668265263))();
  return (at(0, 0) * (1 - u) + at(1, 0) * u) * (1 - v) + (at(0, 1) * (1 - u) + at(1, 1) * u) * v;
}

/** Correlated noise establishes broad wings; ordered dithering turns it into discrete room sizes.
 * A spanning tree opens shared walls, then extra connections add loops. No isolated rooms, rejection
 * retries or recursion, even at the largest supported size. The centre is a shared stair landing. */
export function generateOfficeLayout(seed: string, columns = 28, rows = columns): OfficeLayout {
  if (![columns, rows].every(n => Number.isInteger(n) && n >= 12 && n <= 48))
    throw new Error('Office dimensions must be whole numbers from 12 to 48 cells.');
  const salt = seedNumber(seed),
    rng = random(salt);
  const cells = Array<number>(columns * rows).fill(-1);
  const rooms: OfficeRoom[] = [];
  const field = (x: number, y: number) =>
    noiseAt(x / 9, y / 9, salt) * 0.7 + noiseAt(x / 3, y / 3, salt ^ 0x51ed) * 0.3;
  const place = (x: number, y: number, width: number, depth: number) => {
    const id = rooms.length;
    rooms.push({ x, y, width, depth, noise: field(x, y) });
    for (let dy = 0; dy < depth; dy++) for (let dx = 0; dx < width; dx++) cells[(y + dy) * columns + x + dx] = id;
  };
  place(Math.floor(columns / 2) - 1, Math.floor(rows / 2) - 1, 2, 2);
  for (let y = 0; y < rows; y++)
    for (let x = 0; x < columns; x++) {
      if (cells[y * columns + x] !== -1) continue;
      const dithered = field(x, y) + ((BAYER[(y % 4) * 4 + (x % 4)] + 0.5) / 16 - 0.5) * 0.42;
      let width = dithered > 0.42 ? 2 : 1,
        depth = dithered > 0.64 ? 2 : 1;
      if (dithered > 0.76) {
        width = 3;
        depth = 1;
      }
      if (rng() > 0.5) [width, depth] = [depth, width];
      const fits = () =>
        x + width <= columns &&
        y + depth <= rows &&
        Array.from({ length: depth }, (_, dy) =>
          Array.from({ length: width }, (_, dx) => cells[(y + dy) * columns + x + dx] === -1).every(Boolean),
        ).every(Boolean);
      while (!fits()) {
        if (width >= depth && width > 1) width--;
        else depth--;
      }
      place(x, y, width, depth);
    }
  const boundaries: OfficeBoundary[] = [];
  const edge = (a: number, b: number, start: [number, number], end: [number, number]) => {
    if (a !== b) boundaries.push({ a, b, start, end, passage: false });
  };
  for (let y = 0; y < rows; y++)
    for (let x = 0; x < columns; x++) {
      const a = cells[y * columns + x];
      edge(a, x + 1 < columns ? cells[y * columns + x + 1] : -1, [x + 1, y], [x + 1, y + 1]);
      edge(a, y + 1 < rows ? cells[(y + 1) * columns + x] : -1, [x, y + 1], [x + 1, y + 1]);
      if (x === 0) edge(a, -1, [0, y], [0, y + 1]);
      if (y === 0) edge(a, -1, [x, 0], [x + 1, 0]);
    }
  const parents = rooms.map((_, i) => i);
  const root = (i: number): number => {
    while (parents[i] !== i) {
      parents[i] = parents[parents[i]];
      i = parents[i];
    }
    return i;
  };
  const candidates = boundaries
    .filter(e => e.b !== -1)
    .map(e => ({ e, weight: rng() + field(...e.start) * 0.35 }))
    .sort((a, b) => a.weight - b.weight);
  const connected = new Set<string>();
  for (const { e } of candidates) {
    const a = root(e.a),
      b = root(e.b),
      pair = [e.a, e.b].sort((a, b) => a - b).join(':');
    if (a !== b || (!connected.has(pair) && rng() < 0.16)) {
      e.passage = true;
      parents[a] = b;
      connected.add(pair);
    }
  }
  return { columns, rows, rooms, boundaries, cells };
}
