// The half of the editor facade that draws no plan: persistence, theming, the document schema and
// the structure browser.
//
// A host needs these before it has a project to show — to list what is saved, to honour the dark
// mode toggle, to read a dropped export. Reaching them through the main facade meant reaching past
// FloorEditor, and because maplibre-gl ships as a side-effectful UMD bundle no bundler will shake it
// back out again: the picker screen paid for maplibre and three (1.7 MB between them) before anyone
// had opened anything. Importing from here instead leaves the rendering surface behind a dynamic
// `import('@kerros/editor')`, which is where it belongs. `@kerros/editor` re-exports every name
// below, so this module adds an entry point and changes nothing about the existing one.
export type { ProjectRepository, AssetRepository, Tool } from '../model/types';
export type { StatusFeed, StatusReading, StatusMetrics, StatusTone } from '../model/live';
export type {
  SitePlannerProps,
  ElevatorControls,
  PlannerAdapters,
  BasemapConfig,
  BasemapVectorSchema,
  PlannerMode,
  StatusPanelContext,
  ImportProjection,
  ViewState,
  CameraState,
} from '../model/host';
export { LocalProjectRepository, IndexedProjectRepository, IndexedAssetRepository } from '../adapters/persistence';
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
