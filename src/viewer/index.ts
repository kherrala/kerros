// Public viewer facade: read-only floor viewer + the helpers a host needs to wire it. The adapters/
// re-exports below are the one documented boundary exception (pure/static values only; the physical
// status/basemap helpers ship inside the @kerros/viewer package — see docs/SCHEMA.md § Packaging).
export { FloorViewer, type FloorViewerProps } from './FloorViewer';
export type { BasemapConfig, BasemapVectorSchema } from '../model/host';
export type { StatusReading, StatusMetrics, StatusTone, StatusFeed } from '../model/live';
export { neutralBasemap } from '../adapters/basemap';
export { statusTone, statusLabel, unknownStatus } from '../adapters/status';
// Browser-generic persistence: a read-only viewer host still needs to load projects the editor saved.
export { LocalProjectRepository, IndexedAssetRepository } from '../adapters/persistence';
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
