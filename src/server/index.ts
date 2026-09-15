/** Node-only package. Browser hosts use @kerros/editor and its map-free /host entry point. */
export * from '../import';
export { AI_IMPORT_SYSTEM, AI_IMPORT_TOOLS, runAiPlanImport } from './aiImport';
export type {
  AiContent,
  AiImportOperation,
  AiMessage,
  AiPlanImportOptions,
  AiPlanImportResult,
  AiProvider,
  AiToolSpec,
  PlanSource,
} from './aiImport';
export { openVisualSource } from './visualSource';
export { openDwgSource } from './dwgSource';
export { renderPdfDrawing } from './pdfDrawing';
export { analyseRaster } from './rasterAnalysis';
export type { SourceAnalysisQuery, RasterAnalysisOptions, RasterEvidence } from './rasterAnalysis';
export { AnalysisStore, ANALYSIS_VERSION, sourceHash } from './analysisStore';
export { analysisSummary, analysisSvg, calibrateSource, queryCandidates, validateSourceAnalysis } from './analysis';
export type {
  SourceAnalysis,
  SourceCandidate,
  SourceTransform,
  CandidateQuery,
  VectorCommand,
  VectorPoint,
  VectorBounds,
} from './analysis';
export { claudeImportRequest, fromSdkContent } from './claudeRequest';
export { createClaudeProvider } from './claude';

export { mutationTool, MUTATION_KINDS, DEFAULT_MUTATION_KINDS } from './mutationTools';
export type { ImportCheckpoint, ImportBudget, ImportPause } from '../import/checkpoint';

export { CandidateEdits, projectRevision } from './candidateEdits';
export type { CandidateEdit } from './candidateEdits';

export { sourceAnalysisPreview } from './analysisPreview';
export type { ImportAnalysisPreview } from '../import/analysisPreview';
