// Public plan-import facade: CAD drawings into Kerros documents, deterministically where the
// drawing allows it and AI-assisted where it does not. Depends only on @kerros/schema's public
// surface — no schema internals, no React, no rendering, no AI SDK — so it runs anywhere the
// schema runs. Hosts supply what is host-shaped: DWG extraction (native tooling), rasterization
// (a browser), and for the AI path the provider and its credentials.
export { importPlanEntities } from './planImport';
export { VERTEX_LAYERS } from './types';
export { detectLayers, layerPattern, LAYER_ROLES } from './detect';
export type { LayerDetection, LayerReport, LayerRole } from './detect';
export type { PlanEntity, PlanImportOptions, PlanImportReport, PlanLayerMap } from './types';
export { AI_IMPORT_SYSTEM, AI_IMPORT_TOOLS, runAiPlanImport } from './aiImport';
export type {
  AiContent,
  AiMessage,
  AiPlanImportOptions,
  AiPlanImportResult,
  AiProvider,
  AiToolSpec,
  PlanSource,
} from './aiImport';
export { documentSvg } from './documentSvg';
