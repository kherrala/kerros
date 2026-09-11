// Public editor facade: full authoring product; persistence arrives via PlannerAdapters.
export { SitePlanner as FloorEditor, SiteViewer } from '../SitePlanner';
export type { ProjectRepository, AssetRepository, Tool } from '../model/types';
export type { StatusFeed, StatusReading, StatusMetrics, StatusTone } from '../model/live';
export type {
  SitePlannerProps,
  PlannerAdapters,
  BasemapConfig,
  BasemapVectorSchema,
  PlannerMode,
  StatusPanelContext,
  ImportProjection,
  ViewState,
  CameraState,
} from '../model/host';
export { LocalProjectRepository, IndexedAssetRepository } from '../adapters/persistence';
export { neutralBasemap } from '../adapters/basemap';
export {
  KerrosThemeProvider,
  useKerrosTheme,
  useDarkMode,
  useStrings,
  type KerrosTheme,
  type MapStyleOptions,
  type ConfirmOptions,
} from '../theme';
export * from '../schema';
// The ontology browsed as a structure rather than a plan — zones, their spaces, and the portals
// that bound them. Reads the same document as the map; needs no map.
export { StructureView, type StructureViewProps } from '../components/StructureView';

// The editor depends on the plan-import tooling and re-exports it, so an editor host has the
// deterministic CAD importer without adding @kerros/import separately.
export { importPlanEntities, VERTEX_LAYERS } from '../import';
export type { PlanEntity, PlanImportOptions, PlanImportReport, PlanLayerMap } from '../import';
