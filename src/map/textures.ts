import * as THREE from 'three';
import type { MaterialKind } from '../model/types';

export type SurfaceFinish = MaterialKind | 'roof';

// One repeat in real metres. Shared across colours, so an entire site needs only one set per finish.
const SCALE: Record<SurfaceFinish, [number, number]> = {
  brick: [1.04, 0.64],
  stone: [2.4, 1.2],
  plaster: [3, 3],
  timber: [2.4, 1.44],
  oak: [2.4, 1.44],
  tile: [2.4, 2.4],
  grass: [3.2, 3.2],
  paving: [1.6, 1.6],
  roof: [2.4, 3.6],
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
      const mottle = kind === 'plaster' ? 0.025 : 0.13;
      let tone = (kind === 'plaster' ? 0.985 : 0.91) + (weather - 0.5) * mottle + (grain - 0.5) * 0.045;
      let relief = 0.55 + (grain - 0.5) * (kind === 'plaster' ? 0.08 : 0.15),
        roughness = 0.88;
      if (kind === 'brick' || kind === 'stone' || kind === 'tile' || kind === 'paving') {
        const rows = kind === 'brick' ? 8 : 4;
        const columns = kind === 'stone' ? 2 : 4;
        const row = Math.floor(v * rows);
        const stagger = kind === 'tile' ? 0 : (row % 2) * 0.5;
        const cell = u * columns + stagger;
        const fu = fract(cell),
          fv = fract(v * rows);
        const gapU = kind === 'brick' ? 0.022 : 0.008;
        const gapV = kind === 'brick' ? 0.065 : 0.015;
        const edge = Math.min(Math.min(fu, 1 - fu) / gapU, Math.min(fv, 1 - fv) / gapV);
        const face = smooth(Math.min(1, edge));
        const variation = hash(Math.floor(cell) % columns, row) - 0.5;
        tone *= 1 + variation * (kind === 'brick' ? 0.24 : 0.12);
        tone = tone * face + (kind === 'brick' ? 0.67 : 0.64) * (1 - face);
        relief = 0.18 + face * (0.56 + (grain - 0.5) * (kind === 'tile' ? 0.015 : 0.12));
        roughness = kind === 'tile' ? 0.35 + weather * 0.16 + (1 - face) * 0.4 : 0.84 + grain * 0.12;
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
      } else if (kind === 'grass') {
        tone *= 0.78 + weather * 0.32 + (grain - 0.5) * 0.18;
        relief = 0.3 + grain * 0.5;
        roughness = 1;
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
