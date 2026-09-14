// Public viewer facade: read-only floor viewer + the helpers a host needs to wire it. The adapters/
// re-exports below are the one documented boundary exception (pure/static values only; the physical
// status/basemap helpers ship inside the @kerros/viewer package — see docs/SCHEMA.md § Packaging).
export { FloorViewer, type FloorViewerProps, type ViewerMode, type ViewerDisplayOptions } from './FloorViewer';
// Everything that renders no plan lives one module over, so that a host wanting only persistence or
// theming can import it without dragging the renderer in behind it. The surface of this facade is
// unchanged: `@kerros/viewer` still exports all of it.
export * from './host';
