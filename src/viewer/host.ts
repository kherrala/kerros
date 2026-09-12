// The half of the viewer facade that draws no plan: persistence, theming, status helpers, the
// document schema and the structure browser.
//
// Same reason as the editor's `host` module (see src/editor/host.ts): FloorViewer reaches
// maplibre-gl, maplibre-gl ships as a side-effectful UMD bundle that no bundler will shake back out,
// and so a host that only wanted `useDarkMode` to render its picker screen was paying for the whole
// renderer up front. `@kerros/viewer` re-exports every name below; this is an added entry point, not
// a changed one.
export type { BasemapConfig, BasemapVectorSchema } from '../model/host';
export type { StatusReading, StatusMetrics, StatusTone, StatusFeed } from '../model/live';
export { neutralBasemap } from '../adapters/basemap';
export { statusTone, statusLabel, unknownStatus } from '../adapters/status';
// Browser-generic persistence: a read-only viewer host still needs to load projects the editor saved.
export { LocalProjectRepository, IndexedProjectRepository, IndexedAssetRepository } from '../adapters/persistence';
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
