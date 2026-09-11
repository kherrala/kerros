import type { BasemapConfig } from '../model/host';
export const neutralBasemap: BasemapConfig = {
  style: {
    version: 8,
    sources: {},
    layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#e6e8e4' } }],
  },
};
