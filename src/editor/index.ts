// Public editor facade: full authoring product; persistence arrives via PlannerAdapters.
export { SitePlanner as FloorEditor, SiteViewer } from '../SitePlanner';
// Everything that renders no plan lives one module over, so that a host wanting only persistence or
// theming can import it without dragging the renderer in behind it. The surface of this facade is
// unchanged: `@kerros/editor` still exports all of it.
export * from './host';
