import {
  importPlanEntities, VERTEX_LAYERS, detectLayers, layerPattern, LAYER_ROLES,
  documentSvg, landmarks, sheetOffset, shiftEntities,
} from '@kerros/editor';

// Importing drawing helpers through the full editor facade must not load a renderer or parser.
export const probe = [
  importPlanEntities, VERTEX_LAYERS, detectLayers, layerPattern, LAYER_ROLES,
  documentSvg, landmarks, sheetOffset, shiftEntities,
];
