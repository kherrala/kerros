# `@kerros/import`

CAD drawings into Kerros documents. Pure functions over [`@kerros/schema`](./schema) — no React, no
rendering, no AI SDK — so the module runs anywhere the schema runs. The editor depends on it and
re-exports its surface; hosts can also install it alone.

PDF/DWG parsing, source analysis and the AI tool loop belong to the Node-only [`@kerros/server`](./server) package. This package accepts already extracted entity JSON and contains no PDF parser, worker, native canvas or LLM SDK.

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

## Server extraction and AI import

The AI APIs moved to [`@kerros/server`](./server). Use that entry point for `runAiPlanImport`, `AiProvider`, `PlanSource`, `AI_IMPORT_TOOLS` and `AI_IMPORT_SYSTEM`. The browser-safe `documentSvg(doc)` helper remains here. See [Import features](/guide/ai-import) for setup and the live-project workflow.

## In the editor

The import dialog's **CAD plan** tab feeds `importPlanEntities` through the editor's transactional
commit: pick the target floor, drop the entity JSON, and the walls, rooms and openings appear —
with the result toast reporting counts and skips. Repeat per floor for a multi-storey building.
