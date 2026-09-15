# CAD conversion and SVG

Browser-safe helpers convert extracted CAD entities into Kerros documents and render document SVGs.
The editor and server export the same implementation; there is no separate import package.

| Environment | Entry point |
| --- | --- |
| Browser application | `@kerros/editor` |
| Browser host utilities without the map renderer | `@kerros/editor/host` |
| Node.js tools and backends | `@kerros/server` |

```ts
import { importPlanEntities, detectLayers, documentSvg } from '@kerros/editor/host';
```

On Node.js, import those same names from `@kerros/server`. The conversion functions operate on
already extracted entity JSON. PDF/DWG parsing, native source analysis and the AI tool loop remain
in the [server module](./server); browser entry points contain no PDF parser or LLM SDK.

## Deterministic import

- `importPlanEntities(draft, entities, { floorId, layers? })` — build walls, rooms, doors, windows
  and names on a floor from normalized plan entities (metres). Call inside a transaction; a drawing
  the importer cannot digest refuses cleanly. Returns a `PlanImportReport` — counts plus a
  `skipped` list explaining everything it declined rather than guessed at.
- `PlanEntity` — the entity contract (`LINE`/`POLYLINE`/`ARC`/`TEXT`/…, coordinates in metres);
  `scripts/plan-import/extract.mjs --expand --units m` produces it from a DWG.
- `VERTEX_LAYERS` / `PlanLayerMap` — which layers carry walls, openings and labels. The default is
  the numbered taxonomy of Finnish prefab CAD; override per source.

What it understands: axis-aligned drawings whose walls are parallel face-line pairs on semantic
layers. Walls are paired from face runs with measured thickness. Rooms follow the closed faces of
the [shared boundary network](/guide/geometry), with `geometry.loops` referencing the actual walls.
Doorless passages receive virtual boundaries between their jambs, so adjacent rooms remain distinct
and connected without sealing the passage. Usable room polygons are generated after subtracting wall
bodies and holes; wall edits update both adjoining rooms. Regions below 1 m², or with disconnected
usable pieces, remain unlabelled and are reported in `skipped`.

Envelope openings come from door/window symbol clusters projected onto their wall; partition
openings come from paired face gaps. Labels name the room they stand in. Opening *kinds* are
approximate where symbols crowd together; the report identifies unresolved openings for review.
Short wall returns remain valid down to the schema's `MIN_SEGMENT` (1 cm).

For several sheets, use `sheetOffset(reference, sheet)` to measure registration and
`shiftEntities(entities, dx, dy)` to translate every coordinate, including arc centres. Import and
manual corrections must run through `transact`; export only a successful result. To move an imported
plan afterwards, translate its junctions and independent objects in a transaction. Connected rooms'
polygons and dimensions are regenerated from the junctions. Call `refreshBoundarySpaces` before
`refreshPortals` if portal inference runs inside that same transaction.

## Layer detection, registration and SVG

- `detectLayers(entities)` proposes layer roles; `layerPattern` and `LAYER_ROLES` support custom mappings.
- `landmarks`, `sheetOffset` and `shiftEntities` register related sheets in a common coordinate frame.
- `documentSvg(project, width?)` returns an SVG string for reviewing the current document without a map.
- `PlanEntity`, `PlanImportOptions`, `PlanImportReport`, `PlanLayerMap`, `LayerDetection`, `LayerReport`,
  `LayerRole` and `Landmark` describe conversion inputs and reports.
- `ImportBrief`, `SourceCalibration`, `AiTokenUsage` and `ImportInstruction` are shared integration types.

## Server extraction and AI import

Use [`@kerros/server`](./server) for `runAiPlanImport`, `AiProvider`, `PlanSource`, `AI_IMPORT_TOOLS` and `AI_IMPORT_SYSTEM`. See [Import features](/guide/ai-import) for the live-project workflow.

## In the editor

The import dialog's **CAD plan** tab feeds `importPlanEntities` through the editor's transactional
commit: pick the target floor, drop the entity JSON, and the walls, rooms and openings appear —
with the result toast reporting counts and skips. Repeat per floor for a multi-storey building.

## Migration

Replace imports from the former `@kerros/import` package with `@kerros/editor/host` in browser hosts
or `@kerros/server` in Node.js. Function names and argument contracts are unchanged.
