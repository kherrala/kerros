import type { StyleSpecification } from 'maplibre-gl';
import type { BasemapConfig } from '../model/host';

/** Fetch the external style without replacing the working, locally rendered plan. */
export async function loadBasemap(config: BasemapConfig, signal: AbortSignal): Promise<StyleSpecification> {
  const tune = (style: StyleSpecification) => config.styleTransform?.(style) ?? style;
  if (typeof config.style !== 'string') return tune(config.style);
  const request = (await config.transformRequest?.(
    config.style,
    'Style' as Parameters<NonNullable<BasemapConfig['transformRequest']>>[1],
  )) ?? { url: config.style };
  const response = await fetch(request.url, { signal, headers: request.headers, credentials: request.credentials });
  if (!response.ok) throw new Error(`Basemap style returned ${response.status}`);
  const style = (await response.json()) as StyleSpecification;
  if (style.version !== 8 || !style.sources || !Array.isArray(style.layers))
    throw new Error('Invalid MapLibre basemap style');
  const absolute = (url: string) =>
    new URL(url, response.url || request.url).toString().replaceAll('%7B', '{').replaceAll('%7D', '}');
  if (style.glyphs) style.glyphs = absolute(style.glyphs);
  if (typeof style.sprite === 'string') style.sprite = absolute(style.sprite);
  else if (Array.isArray(style.sprite))
    style.sprite = style.sprite.map(sprite => ({ ...sprite, url: absolute(sprite.url) }));
  for (const source of Object.values(style.sources)) {
    if ('url' in source && typeof source.url === 'string') source.url = absolute(source.url);
    if ('tiles' in source && source.tiles) source.tiles = source.tiles.map(absolute);
  }
  return tune(style);
}
