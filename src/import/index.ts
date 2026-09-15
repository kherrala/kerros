// Shared browser-safe helpers, exported by @kerros/editor (/host too) and @kerros/server.
// Native PDF/DWG extraction, source analysis and AI execution live in @kerros/server.
export { importPlanEntities } from './planImport';
export { VERTEX_LAYERS } from './types';
export { detectLayers, layerPattern, LAYER_ROLES } from './detect';
export type { LayerDetection, LayerReport, LayerRole } from './detect';
export type { PlanEntity, PlanImportOptions, PlanImportReport, PlanLayerMap } from './types';
export type { AiTokenUsage } from './usage';
export type { ImportBrief, SourceCalibration } from './brief';
export { documentSvg } from './documentSvg';
export { landmarks, sheetOffset, shiftEntities, type Landmark } from './register';

export type { ImportInstruction } from './instructions';
