# plan-import — drawing → Kerros tooling, human- and agent-operable

Convert architectural CAD drawings into Kerros documents. Every command works standalone for a
person; together they are the tool surface for an AI import agent (`agent.ts`).

Requires [LibreDWG](https://www.gnu.org/software/libredwg/) for DWG parsing: `brew install libredwg`.

## The pipeline

```sh
# 1. What's in the drawing? Per-layer census, bounding boxes.
node scripts/plan-import/extract.mjs plan.dwg --expand --units m --stats

# 2. Pull a slice as normalized JSON (coordinates in metres, INSERTs flattened).
node scripts/plan-import/extract.mjs plan.dwg --expand --units m \
  --layers '^(12_|27_|55_)' --out slice.json

# 3. Look at it (SVG, or PNG via the repo's Playwright).
node scripts/plan-import/render.mjs slice.json --legend --png slice.png

# 4. Author the Kerros document as a Mutation[] script — atomic, validated, rendered.
npx vite-node scripts/plan-import/apply.ts -- script.json --out doc.json --svg doc.svg
```

`extract.mjs` understands the Vertex BD structure common to Finnish prefab drawings: the plan lives
in blocks of real-millimetre geometry INSERTed at plot scale, on semantically named layers
(`12_ULKOPINTA` exterior faces, `27_OVET` doors, `55_HUONETUNNUKSET` room labels, …). `--expand`
flattens the INSERT tree into one frame; `--units m` converts via `--plot-scale` (default 1:50).

## Where the logic lives

The browser-safe `@kerros/import` module converts extracted entity JSON into geometry.
The Node-only `@kerros/server` package owns PDF/DWG extraction, vector analysis and
`runAiPlanImport`. These scripts provide command-line orchestration and environment configuration.
The backend streams accepted changes to the editor; native parsers and the AI schema stay on the server.
The reference app offers deterministic entity JSON import in **CAD plan**, and live backend-assisted
image/PDF/DWG import in **AI import**. Run the full stack with `make up`.

## The agent

Follow the [AI import setup guide](../../docs/guide/ai-import.md) to create a key in Claude Console,
configure `.env.local`, install the rendering prerequisites and open the output in the editor.
The repository's environment template is [`.env.example`](../../.env.example).

```sh
# Put ANTHROPIC_API_KEY=... in .env.local (gitignored), then:
npx vite-node scripts/plan-import/agent.ts -- plan.dwg --out imported.json
```

Claude (`ANTHROPIC_MODEL`, default `claude-opus-4-8`) drives the module's tool loop. DWG exposes
entity JSON directly. Image/PDF import first inspects the drawing, records calibration and a compact
source plan with `set_import_notes`, then enters a text-only build phase. Images are removed from
requests during building; explicit review enables a focused visual check.

- **Every write is a transaction.** Scripts go through `applyMutations`, so a hallucinated or
  geometrically invalid script is refused with the reason and the document is untouched — the agent
  reads the refusal and revises. The saved document is valid at every point in the run.
- **Geometry validity and source accuracy are separate.** The agent can compare a focused source
  view with the output during review. A valid model still needs human review of architectural accuracy.

`--origin lng,lat,bearing` sets the geo anchor (default Helsinki); `--max-turns` caps the loop.

The optional template accepts `--building-type`, `--floor-count`, `--width-metres`, `--depth-metres`
and `--footprint-m2` (exterior footprint per floor, including walls). One known width or footprint
establishes scale; additional references cross-check it. Building type must not supply invented dimensions.
For example, add `--width-metres 20 --building-type house --floor-count 1`.

Context is compacted to a local estimate of 24,000 input tokens, including tools. Per-run input
(including cache) and output thresholds default to 200,000 and 24,000 tokens, checked between turns.
Override with `--max-context-tokens`, `--max-input-tokens` and `--max-output-tokens`.
Three consecutive refused mutation batches pause the run. The provider uses medium effort, an
8192-token response limit and prompt caching. Normal tests use scripted providers and never spend API tokens.

The agent also accepts PNG, JPEG, WebP and PDF files. `--instructions` / `--instructions-file`
supply known scale and page/floor selection. `--events` emits the backend's NDJSON protocol,
including streamed text and complete document snapshots after each accepted transaction.

The model receives a schema generated from the complete core `Mutation` union, including nested
object/floor properties. Run `npm run generate:ai-tools` after editing those types and
`npm run check:ai-tools` to verify it. `inspect_document` exposes generated IDs and paginated state.

## Vector analysis without Claude

```sh
npx vite-node scripts/plan-import/analyse.ts -- floor.pdf --out analysis.json --svg analysis.svg --page 1
```

This extracts supported PDF paths/text or DWG entities into stable source candidates and generates SVG.
It does not load the API key or call a model. Raster images/scanned PDFs use the packaged OpenCV
worker and Finnish/English/Swedish OCR. Install the native dependencies or run in the API Docker
environment. `--mode raster --profile scan --bbox x0,y0,x1,y1` selects a source region in original
pixels/PDF points; `--no-ocr` enables geometry-only analysis. Wall/outline/symbol results are
proposals, not automatically connected model geometry. Cached artifacts live in `.cache/plan-analysis`.
Use `make test-raster` for isolated native tests with networking disabled and no LLM calls.
See the [server reference](../../docs/reference/server.md) for tools, setup and limitations.


The CLI writes `imported-plan.json.checkpoint.json` (or `<--out>.checkpoint.json`) alongside accepted geometry. To resume without redoing source analysis, pass the same source/template plus `--base imported-plan.json --checkpoint-file imported-plan.json.checkpoint.json`. The checkpoint includes scale, phase, source plan, notes, analysis-cache recipes and candidate mappings. It does not contain images or duplicate project geometry.

The full mutation catalog remains available through `select_mutation_tools`, which loads the exact schemas needed for the next task. `preview_candidate_edits` and `apply_candidate_edits` adopt calibrated candidates using core validation and stale-preview checks. Default per-run limits stay at 200,000 input tokens (including cache) and 24,000 output; responses are capped at 4096 or the remaining output allowance. Budget/turn/refusal pauses save a checkpoint and return a normal paused result. Continue is explicit, never an automatic paid retry.

In backend `--events` mode, stdin accepts newline-delimited `{ "id": "message-id", "text": "Further instructions" }` commands. They enter Claude’s context between turns and persist in the semantic checkpoint. The backend exposes these through the active job’s `/instructions` endpoint; it does not start a second worker or raise budgets. The editor’s Activity tab saves drafts and queues messages before sending. After a run, Send & continue explicitly starts the next paid run. Source SVG previews travel in `analysis` events for the human UI only.

See the [source-analysis guide](../../docs/guide/ai-import-analysis.md) for coordinate frames, calibration formulas, candidate adoption, preview overlays and offline verification.
