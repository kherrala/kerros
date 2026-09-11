import type { MaterialKind } from './types';

export const EXTERIOR_PRESETS = {
  limestone: { name: 'Limestone', material: 'stone', color: '#c8c3b7' },
  brick: { name: 'Warm brick', material: 'brick', color: '#9b705b' },
  darkBrick: { name: 'Dark brick', material: 'brick', color: '#7a4636' },
  plaster: { name: 'Ivory render', material: 'plaster', color: '#e0ddd4' },
  timber: { name: 'Cedar cladding', material: 'timber', color: '#ab8b68' },
} as const satisfies Record<string, { name: string; material: MaterialKind; color: string }>;

export type ExteriorPreset = keyof typeof EXTERIOR_PRESETS;
