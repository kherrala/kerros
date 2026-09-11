# `@kerros/import`

CAD drawings into Kerros documents. Pure functions over [`@kerros/schema`](./schema) — no React, no
rendering, no AI SDK — so the module runs anywhere the schema runs. The editor depends on it and
re-exports its surface; hosts can also install it alone.

The split of responsibilities is deliberate: **the module owns the conversion, hosts own the
host-shaped parts** — DWG parsing (native tooling; see `scripts/plan-import/extract.mjs`),
rasterization (a browser), and for the AI path the provider and its credentials.

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
layers. Walls are paired from face runs with measured thickness; ONE interior plate is traced from
the envelope's inner face and divided along each partition with the editor's own `divideSpaces`
path; envelope openings come from door/window symbol clusters projected onto their wall, partition openings from the paired face gaps (and a symbol-less partition gap becomes a doorless passage — the barrier splits around it);
labels name the room they stand in. Positions are exact; opening *kinds* are approximate where
symbols crowd together — the report says which, and the editor is the place to correct them.

## AI-assisted import

- `runAiPlanImport(provider, source, options)` — drive an AI provider through the import tool loop
  (inspect layers → see renders → extract → propose `Mutation[]` → verify visually) until it stops.
  Every proposed change passes through `applyMutations`, so an invalid script is refused with the
  reason and the returned document is valid at every point of the run — no provider can break that.
- `AiProvider` — what the host implements: one model turn (`{system, tools, messages} → content`).
  Neutral content blocks (`text`, `image_png`, `tool_use`, `tool_result`, `opaque` for
  provider-private blocks that must round-trip untouched) map 1:1 onto any tool-use API.
- `PlanSource` — drawing access: `stats()`, `extract(query)`, `render(query)`.
- `AI_IMPORT_TOOLS` / `AI_IMPORT_SYSTEM` — the tool catalog and briefing, exported for hosts that
  want to present or extend them.
- `documentSvg(doc)` — the plan-view SVG both sides of the visual diff use.

`scripts/plan-import/agent.ts` is a complete host: Anthropic SDK provider (credentials from
`.env.local`), LibreDWG `PlanSource`, Playwright rasterizer.

## In the editor

The import dialog's **CAD plan** tab feeds `importPlanEntities` through the editor's transactional
commit: pick the target floor, drop the entity JSON, and the walls, rooms and openings appear —
with the result toast reporting counts and skips. Repeat per floor for a multi-storey building.
