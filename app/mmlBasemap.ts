// A reference basemap for the Finnish National Land Survey (MML) open vector tiles — NOT part of the
// library. It's region-specific; hosts elsewhere supply their own BasemapConfig. The vectorSchema
// below tells the editor how to read MML's tiles for the built-in adoption, 3D-city, cadastre and
// below-grade context features. The MML API key is a public open-data credential, injected per request.
import type { StyleSpecification } from 'maplibre-gl';
import type { BasemapConfig } from '@kerros/viewer';

// MML topographic-database attributes: kerrosluku classifies storeys (1 = 1–2, 2 = 3+); kohdeluokka is
// the usage class. They drive the 3D massing height and the adopt tool's defaults.
const KOHDE_NAMES: Record<number, string> = {
  42211: 'Residential building',
  42212: 'Residential block',
  42213: 'Residential block',
  42221: 'Office building',
  42222: 'Public building',
  42230: 'Farm building',
  42251: 'Industrial building',
  42252: 'Industrial building',
  42261: 'Utility building',
  42262: 'Utility building',
  42270: 'Church',
};

// Palette tuning over MML's published `backgroundmap`. Its cartography is good and maintained, so
// this patches specific paint properties rather than forking the whole stylesheet: water deepened so
// it is a colour rather than a tint, city buildings given a touch more weight, and the elevation
// contours pulled back — at building zoom they are clutter under a floor plan, not information.
const PALETTE: Record<string, Record<string, unknown>> = {
  vesisto_alue: { 'fill-color': '#92bbc3' },
  vesisto_alue_reuna: { 'line-color': '#78a4ae' },
  vesisto_viiva: { 'line-color': '#92bbc3' },
  rakennus: { 'fill-color': '#c2b9ac' },
  korkeus_viiva: { 'line-color': 'rgba(184,157,126,0.28)' },
};
// MML's backgroundmap is deliberately quiet — almost achromatic. Under a colour-coded floor plan
// that reads as plain rather than restrained, so give every painted colour a little more chroma.
// Multiplicative in HSL: greys stay grey, tints become colours, nothing shifts hue.
const SATURATION = 1.35;
function saturated(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(saturated);
  if (typeof value !== 'string') return value;
  const rgba = value.match(/^rgba?\(([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)(?:[ ,/]+([\d.]+))?\)$/);
  const hex = value.match(/^#([0-9a-f]{6})$/i);
  let [r, g, b, a] = [0, 0, 0, 1];
  if (rgba) [r, g, b, a] = [+rgba[1] / 255, +rgba[2] / 255, +rgba[3] / 255, rgba[4] === undefined ? 1 : +rgba[4]];
  else if (hex) {
    const n = parseInt(hex[1], 16);
    [r, g, b] = [(n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  } else return value;
  const max = Math.max(r, g, b),
    min = Math.min(r, g, b),
    l = (max + min) / 2;
  if (max === min) return value;
  const d = max - min;
  const s = Math.min(1, (l > 0.5 ? d / (2 - max - min) : d / (max + min)) * SATURATION);
  const h = (max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4) / 6;
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s,
    p = 2 * l - q;
  const channel = (t: number) => {
    const x = ((t % 1) + 1) % 1;
    return x < 1 / 6 ? p + (q - p) * 6 * x : x < 1 / 2 ? q : x < 2 / 3 ? p + (q - p) * (2 / 3 - x) * 6 : p;
  };
  const to255 = (v: number) => Math.round(v * 255);
  return a < 1
    ? `rgba(${to255(channel(h + 1 / 3))},${to255(channel(h))},${to255(channel(h - 1 / 3))},${a})`
    : `rgb(${to255(channel(h + 1 / 3))},${to255(channel(h))},${to255(channel(h - 1 / 3))})`;
}
function tuneStyle(style: StyleSpecification): StyleSpecification {
  for (const layer of style.layers) {
    const paint = ((layer as { paint?: Record<string, unknown> }).paint ??= {});
    for (const key of Object.keys(paint)) if (key.endsWith('-color')) paint[key] = saturated(paint[key]);
    const patch = PALETTE[layer.id];
    if (patch) Object.assign(paint, patch);
  }
  return style;
}

export function mmlBasemap(apiKey: string): BasemapConfig {
  return {
    style:
      'https://avoin-karttakuva.maanmittauslaitos.fi/vectortiles/stylejson/v20/backgroundmap.json?TileMatrixSet=WGS84_Pseudo-Mercator',
    label: 'MML · Finnish land survey',
    styleTransform: tuneStyle,
    transformRequest: url => {
      const parsed = new URL(url, window.location.href);
      if (parsed.hostname === 'avoin-karttakuva.maanmittauslaitos.fi') parsed.searchParams.set('api-key', apiKey);
      return { url: parsed.toString() };
    },
    vectorSchema: {
      footprints: {
        sourceLayer: 'rakennus',
        idField: 'mtk_id',
        storeys: p => (p.kerrosluku === 2 ? 4 : p.kerrosluku === 1 ? 2 : 1),
        name: p => KOHDE_NAMES[p.kohdeluokka as number],
        heightExpression: ['case', ['==', ['get', 'kerrosluku'], 2], 16, ['==', ['get', 'kerrosluku'], 1], 5.5, 6.5],
      },
      context: { waterLayer: 'vesisto_alue', roadLayer: 'liikenne', buildingLayer: 'rakennus' },
      cadastre: {
        tilejson:
          'https://avoin-karttakuva.maanmittauslaitos.fi/kiinteisto-avoin/v3/kiinteistojaotus/WGS84_Pseudo-Mercator/tilejson.json',
        attribution: '© Maanmittauslaitos',
        parcelLayer: 'PalstanSijaintitiedot',
        boundaryLayer: 'KiinteistorajanSijaintitiedot',
        markLayer: 'RajamerkinSijaintitiedot',
        labelLayer: 'KiinteistotunnuksenSijaintitiedot',
        labelField: 'kiinteistotunnuksenEsitysmuoto',
        font: 'Liberation Sans NLSFI',
      },
    },
  };
}
