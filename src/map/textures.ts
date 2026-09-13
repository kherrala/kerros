import * as THREE from 'three';
import type { MaterialKind } from '../model/types';

/** `roof` and `ceiling` are finishes with no authorable material behind them: nobody writes "this
 *  wall is made of roof". They exist because the renderer draws two surfaces the document never
 *  names — the cap over a building, and the soffit walk mode puts over the storey you are in. */
export type SurfaceFinish = MaterialKind | 'roof' | 'ceiling' | 'veneer';

// One repeat in real metres. Shared across colours, so an entire site needs only one set per finish.
const SCALE: Record<SurfaceFinish, [number, number]> = {
  brick: [1.04, 0.64],
  stone: [2.4, 1.2],
  plaster: [3, 3],
  timber: [2.4, 1.44],
  veneer: [1, 2.2],
  oak: [2.4, 1.44],
  // Four columns and six rows of 150 mm square swimming-hall / bathroom tiles.
  tile: [0.6, 0.9],
  terrazzo: [2.4, 2.4],
  grass: [3.2, 3.2],
  paving: [1.6, 1.6],
  roof: [2.4, 3.6],
  // Four 600 mm modules across, which is the grid every suspended ceiling in every office is set out
  // on. Getting this wrong is immediately obvious from underneath: the tiles are the one thing in a
  // room whose real size everybody already knows.
  ceiling: [2.4, 2.4],
  carpet: [3, 3],
  wallpaper: [1.2, 2.4],
};
const fract = (x: number) => x - Math.floor(x);
const hash = (x: number, y: number) => fract(Math.sin(x * 127.1 + y * 311.7 + 74.7) * 43758.5453);
const smooth = (x: number) => x * x * (3 - 2 * x);

/** Periodic noise: both value and slope meet at the tile edges, including broad weathering. */
function noise(u: number, v: number, cells: number) {
  const x = u * cells,
    y = v * cells,
    ix = Math.floor(x),
    iy = Math.floor(y);
  const a = smooth(fract(x)),
    b = smooth(fract(y));
  const at = (dx: number, dy: number) => hash((ix + dx) % cells, (iy + dy) % cells);
  return (at(0, 0) * (1 - a) + at(1, 0) * a) * (1 - b) + (at(0, 1) * (1 - a) + at(1, 1) * a) * b;
}

/** Separate colour, relief and roughness maps: a dark stain must not become a dent in the wall. */
export function surfaceTextures(kind: SurfaceFinish) {
  const size = 512;
  const canvases = Array.from({ length: 3 }, () => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    return canvas;
  });
  const contexts = canvases.map(c => c.getContext('2d')!);
  const images = contexts.map(c => c.createImageData(size, size));
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const u = x / size,
        v = y / size,
        grain = hash(x, y);
      const weather = noise(u, v, 4) * 0.6 + noise(u, v, 16) * 0.4;
      // Plaster covers the floor plates — most of any interior frame. Its map must average out
      // near WHITE: the texture multiplies the authored room colour, so any headroom it keeps for
      // itself darkens every interior. At the earlier 0.91 ± 0.065 swing a whole storey read as
      // weathered concrete and the room colour-coding disappeared into the blotches.
      // Masonry used to swing 13% either side of its own colour, which on a whole facade reads as
      // weathering rather than as material — a wall that looks rained on rather than built. Half
      // that keeps the grain legible up close without dirtying the elevation.
      const mottle = kind === 'plaster' ? 0.025 : 0.065;
      let tone = (kind === 'plaster' ? 0.985 : 0.91) + (weather - 0.5) * mottle + (grain - 0.5) * 0.045;
      let relief = 0.55 + (grain - 0.5) * (kind === 'plaster' ? 0.08 : 0.15),
        roughness = 0.88;
      if (kind === 'brick' || kind === 'stone' || kind === 'tile' || kind === 'paving') {
        // Finer courses. Two stones across a tile made every block the size of a window, which is
        // what gave a wall its cyclopean, dated look; real ashlar runs far smaller than its openings.
        const rows = kind === 'brick' ? 8 : 6;
        const columns = kind === 'stone' ? 4 : 4;
        const row = Math.floor(v * rows);
        const stagger = kind === 'tile' ? 0 : (row % 2) * 0.5;
        const cell = u * columns + stagger;
        const fu = fract(cell),
          fv = fract(v * rows);
        const gapU = kind === 'brick' ? 0.022 : kind === 'tile' ? 0.012 : 0.008;
        const gapV = kind === 'brick' ? 0.065 : kind === 'tile' ? 0.012 : 0.015;
        const edge = Math.min(Math.min(fu, 1 - fu) / gapU, Math.min(fv, 1 - fv) / gapV);
        const face = smooth(Math.min(1, edge));
        const variation = hash(Math.floor(cell) % columns, row) - 0.5;
        tone *= 1 + variation * (kind === 'brick' ? 0.12 : 0.06);
        // Mortar sat a third darker than the stone, so every joint drew a hard black line and the
        // wall read as a grid before it read as a surface. Mortar is paler than brick in life.
        if (kind === 'tile') tone = 0.98 + variation * 0.02 + (grain - 0.5) * 0.005;
        tone = tone * face + (kind === 'tile' ? 0.42 : kind === 'brick' ? 0.86 : 0.88) * (1 - face);
        relief = 0.18 + face * (0.56 + (grain - 0.5) * (kind === 'tile' ? 0.015 : 0.12));
        roughness = kind === 'tile' ? 0.35 + weather * 0.16 + (1 - face) * 0.4 : 0.84 + grain * 0.12;
      } else if (kind === 'terrazzo') {
        // Four 600 mm polished stone tiles each way, with 3 mm grout and aggregate flecks.
        const fu = fract(u * 4),
          fv = fract(v * 4);
        const edge = Math.min(fu, 1 - fu, fv, 1 - fv);
        const face = smooth(Math.min(1, edge / 0.006));
        const stone = hash(Math.floor(u * 4), Math.floor(v * 4));
        const chip = grain > 0.95 ? -0.16 : grain < 0.04 ? 0.035 : 0;
        tone = (0.92 + stone * 0.055 + (weather - 0.5) * 0.025 + chip) * face + 0.5 * (1 - face);
        relief = 0.3 + face * 0.35;
        roughness = 0.38 + weather * 0.12 + (1 - face) * 0.42;
      } else if (kind === 'veneer') {
        // Continuous vertical door grain, without the board joints used by timber cladding.
        const fibre = Math.sin(u * Math.PI * 2 * 110 + Math.sin(v * Math.PI * 2) * 1.5 + noise(u, v, 8) * 2);
        tone = 0.97 + fibre * 0.022 + (weather - 0.5) * 0.025;
        relief = 0.55 + fibre * 0.018;
        roughness = 0.43 + weather * 0.08;
      } else if (kind === 'oak' || kind === 'timber') {
        const row = Math.floor(v * 8),
          across = fract(v * 8);
        const along = fract(u + (row % 4) * 0.25);
        const seam = Math.min(across, 1 - across) < 0.012 || Math.min(along, 1 - along) < 0.002;
        const fibre = Math.sin(v * Math.PI * 2 * 180 + Math.sin(u * Math.PI * 4) * 3 + noise(u, v, 8) * 8);
        tone *= 0.94 + hash(0, row) * 0.14 + fibre * 0.035;
        if (seam) tone *= 0.63;
        relief = seam ? 0.22 : 0.6 + fibre * 0.065;
        roughness = kind === 'oak' ? 0.44 + weather * 0.18 : 0.72 + weather * 0.17;
      } else if (kind === 'carpet') {
        // Dense loop pile with broad wear; stains affect colour, not the height of the fibres.
        const fibre = hash(x, Math.floor(y / 2));
        tone = 0.84 + (weather - 0.5) * 0.2 + (fibre - 0.5) * 0.23;
        relief = 0.45 + fibre * 0.3;
        roughness = 0.98;
      } else if (kind === 'wallpaper') {
        // Small repeated ogees and vertical paper seams, all periodic at the metre-scaled tile edge.
        const curve = Math.cos(v * Math.PI * 16) * 0.2;
        const pattern = Math.abs(Math.sin((u * 8 + curve) * Math.PI));
        const ink = Math.max(0, 1 - pattern / 0.22);
        const seam = Math.min(u, 1 - u) < 0.004;
        tone = 0.95 - ink * 0.13 - (seam ? 0.07 : 0) + (weather - 0.5) * 0.08;
        relief = 0.5 + ink * 0.03 + (grain - 0.5) * 0.04;
        roughness = 0.92;
      } else if (kind === 'grass') {
        tone *= 0.78 + weather * 0.32 + (grain - 0.5) * 0.18;
        relief = 0.3 + grain * 0.5;
        roughness = 1;
      } else if (kind === 'ceiling') {
        // Lay-in mineral fibre on an exposed T-bar grid. Three things make it read as a ceiling
        // rather than as tiling: the grid is PALER than the tile (aluminium against fibre, the
        // opposite way round from mortar and brick), the face is fissured rather than smooth, and
        // the odd tile sits a shade off its neighbours because somebody lifted it and put it back.
        // That last one is most of what makes a corridor of them look like somewhere real.
        const cells = 4;
        const cu = u * cells,
          cv = v * cells;
        const fu = fract(cu),
          fv = fract(cv);
        // 13 mm of tee across a 600 mm module.
        const gap = 0.022;
        const edge = Math.min(Math.min(fu, 1 - fu), Math.min(fv, 1 - fv)) / gap;
        const face = smooth(Math.min(1, edge));
        const lifted = hash(Math.floor(cu), Math.floor(cv));
        const fissure = noise(u, v, 40) * 0.55 + grain * 0.45;
        // The grid has to carry in COLOUR, not only in relief: a ceiling is lit from inside itself,
        // and an emissive surface has almost no shading for a bump map to show up in. A tenth is
        // enough to read as a grid from underneath without reading as tiling.
        tone = (0.9 * face + 1.0 * (1 - face)) * (1 + (lifted - 0.5) * 0.05) + (fissure - 0.5) * 0.06;
        // The tile face sits a few millimetres below the tee it rests in, so the grid is the high
        // ground — which is what catches the light and draws the lines without any colour doing it.
        relief = face * (0.42 + (fissure - 0.5) * 0.3) + (1 - face) * 0.86;
        roughness = 0.93 - (1 - face) * 0.25;
      } else if (kind === 'roof') {
        const seam = Math.min(fract(u * 4), 1 - fract(u * 4));
        const raised = Math.max(0, 1 - seam / 0.016);
        tone *= 0.94 + raised * 0.16 + Math.sin(v * Math.PI * 24) * 0.012;
        relief = 0.35 + raised * 0.6;
        roughness = 0.5 + weather * 0.22;
      }
      const index = (y * size + x) * 4;
      [tone, relief, roughness].forEach((value, channel) => {
        const pixels = images[channel].data;
        pixels[index] = pixels[index + 1] = pixels[index + 2] = Math.round(Math.max(0, Math.min(1, value)) * 255);
        pixels[index + 3] = 255;
      });
    }
  return canvases.map((canvas, i) => {
    contexts[i].putImageData(images[i], 0, 0);
    const texture = new THREE.CanvasTexture(canvas);
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    texture.colorSpace = i === 0 ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    texture.anisotropy = 8;
    texture.repeat.set(1 / SCALE[kind][0], 1 / SCALE[kind][1]);
    return texture;
  });
}
