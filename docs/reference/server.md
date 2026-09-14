# `@kerros/server`

Node-only PDF/DWG extraction, source analysis and AI import execution. The package is a local workspace package prepared for release; publishing it is a separate step. It requires Node.js 22 or newer. Its export map provides a Node entry point and intentionally has no browser entry point.

The editor uses `PlannerAdapters.aiImport` for streamed project changes and `PlannerAdapters.pdfDrawing` for PDF reference pages. It receives JSON and PNG responses; PDF.js, its worker, native canvas, the Claude SDK, the AI tool schema and source-analysis implementations stay on the server. Browser builds fail if these dependencies enter any eager or lazy chunk. `@kerros/import` remains the browser-safe converter for already extracted entity JSON.

## Build and package

```sh
npm run build --workspace @kerros/server
npm pack --workspace @kerros/server --pack-destination /tmp
```

The tarball contains the ESM server bundle, TypeScript declarations, DWG helper scripts and the OpenCV Python worker. PDF support uses PDF.js and native canvas dependencies. DWG additionally needs LibreDWG's `dwgread` on `PATH`. Raster analysis needs Python 3, OpenCV/numpy and Tesseract with `fin`, `eng` and `swe` data. `make up` supplies these native prerequisites in the API image. No package import, build, test or local analysis contacts Claude.

## Extract without an LLM

```ts
import { openVisualSource, analysisSvg, queryCandidates } from '@kerros/server';

const source = await openVisualSource('/data/floor.pdf', {
  cacheDirectory: '/data/analysis-cache',
});
try {
  const artifact = await source.analyse!({ page: 1 });
  const page = queryCandidates(artifact, { kind: 'path', limit: 25 });
  const svg = analysisSvg(artifact);
  // Persist/export svg; return the bounded page to the model.
} finally {
  await source.close();
}
```

From the repository, the equivalent offline CLI is:

```sh
npx vite-node scripts/plan-import/analyse.ts -- ./floor.pdf --out ./analysis.json --svg ./analysis.svg --page 1
```

`openDwgSource(path, { rasterize, cacheDirectory? })` exposes the same source interface. It includes the packaged extraction helpers; a custom `toolsDirectory` can override their location. The rasterizer is a host function used only by an explicit rendered-view request. Native DWG entities are normalized using the existing extractor's unit/plot-scale assumptions; check a known dimension before adopting them.

PDF analysis preserves supported paths, cubic/quadratic curves, text anchors, page rotation, graphics transforms and clipping references. It reports omitted transparency groups, annotations, masks and patterns. These native strokes and fills are **not classified walls**. Auto mode also analyses PDFs containing raster images; native and raster evidence may overlap. An empty candidate set does not mean an empty building.

## OpenCV and OCR

`analyse({ page?, mode?, profile?, bbox?, ocr? })` accepts `auto` (default), `native` or `raster`; profiles are `clean` (Otsu threshold) and `scan` (adaptive threshold plus dark-ink preservation). Images use raster analysis automatically. Force `raster` for unsupported PDF regions. `bbox` uses original image pixels or rotated PDF viewport points; use `query_candidates.bbox` to filter native vectors instead.

The backend normalizes the analysis image to at most 2400 pixels per side, upsampling small images up to 3× for OCR. An explicit affine transform maps every result back to original source coordinates. Upsampling adds no measurement precision. Dominant axes are observations in the original y-down frame; negate the angle when passing it to the y-up calibration rotation.

The local worker reads Finnish/English/Swedish word boxes, masks recognized text, finds stroke faces with OpenCV's line-segment detector, tests cross-sectional ink occupancy and proposes filled/double-line wall centrelines with thickness estimates. It keeps door gaps open. Exterior ink contours retain concavities and distinguish obvious page frames. This does **not** reconstruct room topology, courtyards, interrupted exterior boundaries or opening hosts. Tables, stair treads and furniture can resemble walls; crop the floor-plan region on sheets containing schedules/details. A contour can include a porch or terrace and needs review before area calibration.

Queries support `kind: 'wall' | 'outline' | 'label' | 'symbol'` as well as the native evidence kinds. `minScore` filters heuristic support and excludes unscored records; scores are **not probabilities**. Each wall carries `thickness` in the query's units and `evidenceIds` for its supporting faces. SVG groups identify `data-kind` and `data-layer`; JSON and SVG come from the same artifact.

`find_similar_symbols` takes an artifact, `exemplarBounds` in original source coordinates and a short `label`. It searches for a confirmed example with quarter-turn rotations, mirrors and scales 0.9/1/1.1, suppresses overlapping matches and excludes the example itself. Query the new artifact with `kind: 'symbol'`. These are visual hypotheses with example references; the tool does not create doors, portals or model objects. Differing conventions, oblique symbols and clutter can cause missed/false matches. This is [template matching](https://docs.opencv.org/4.x/de/da9/tutorial_template_matching.html), not a trained Viola–Jones classifier; [cascade training](https://docs.opencv.org/4.11.0/dc/d88/tutorial_traincascade.html) would require a labelled positive/negative dataset.

Host configuration can set `openVisualSource(path, { raster: { python, workerPath } })` or `KERROS_OPENCV_PYTHON`; these executable paths are never model tool inputs. OCR defaults on and reports missing language dependencies explicitly; `ocr: false` enables geometry-only analysis. Each worker has a 45-second deadline and cleans up its temporary inputs. Full artifacts remain bounded by the store limits below.

```sh
# No key and no LLM calls. Docker also supplies the native dependencies.
make test-raster
# On a host that already has OpenCV/Tesseract installed:
npm run test:raster
npx vite-node scripts/plan-import/analyse.ts -- ./floor.jpg --out ./analysis.json --profile scan
# Analyse a specific region; coordinates are original source units:
npx vite-node scripts/plan-import/analyse.ts -- ./floor.pdf --mode raster --bbox 50,300,1160,1070 --out ./region.json
```

`make test-raster` builds an isolated analysis image, then runs deterministic fixtures with networking disabled. It never starts a provider, reads the API key or restarts the development services. Ordinary tests skip the native suite; use this target for native analysis changes.

## Calibration and text tools

| Tool | Result |
| --- | --- |
| `analyse_source` | Artifact ID, frame/units, counts and extraction warnings |
| `find_similar_symbols` | New cached artifact with visual matches to a selected example |
| `calibrate_source` | Versioned uniform transform computed from extracted reference IDs and user dimensions/area |
| `query_candidates` | Up to 25 records as JSON or an SVG text fragment, bounded to 12,000 serialized characters |
| `inspect_candidate` | One candidate with evidence and clipping references |
| `render_analysis_overlay` | Bounded SVG text; no automatic image rendering |
| `preview_candidate_edits` | Disposable core-validated project, exact areas, opening fit and proposed model IDs |
| `apply_candidate_edits` | Atomic adoption of the prepared project after project/transform revision checks |

Queries use original source units unless `transformId` selects a calibration. Calibrated output uses metres and a y-up frame. Width/depth follow the selected reference geometry after main-axis rotation. Footprint-area calibration requires one closed straight exterior outline with no holes or multiple subpaths. Curved/clipped paths cannot establish scale from their bounds. Without template dimensions, printed-length calibration requires a single extracted straight segment and its real length.

Recalibration invalidates previous transform IDs and cursors. The source artifact remains unchanged. Calibration never rescales or mutates the live project. Atomic candidate preview/apply tools use the geometry core to adopt interpreted evidence. Automatic raster endpoint repair and opening-host classification remain limitations. See [source analysis and calibration](../guide/ai-import-analysis) for the implemented pipeline and its boundaries. Existing core mutation tools remain available.

`SourceAnalysis`, `SourceCandidate`, `SourceTransform`, `SourceAnalysisQuery` and `CandidateQuery` are exported contracts. Candidate IDs are scoped to an artifact and stable for the same source bytes, page, analysis options and extractor version. Crops, profiles, OCR settings and symbol exemplars have separate cache entries. Full artifacts stay outside the LLM conversation. `AnalysisStore` optionally caches private JSON/SVG files by source hash; its limits are 20,000 candidates, 200,000 path commands and 8 MiB of serialized JSON. Changing the extractor version invalidates older cache entries; bump it when changing algorithms or supported native runtime behavior.

## AI execution

`runAiPlanImport(provider, source, options)` owns the provider-neutral tool loop and applies every proposed mutation atomically through the core. `createClaudeProvider({ apiKey, model?, onText? })` supplies the reference Claude provider; custom providers implement `AiProvider.turn`. The API key belongs to the host backend. `AI_IMPORT_TOOLS` and `AI_IMPORT_SYSTEM` expose the complete schema and prompt.

Options include `base`, `brief`, `instructions`, `rasterize`, `checkpoint`, token/turn limits, and `onDocument`, `onCheckpoint`, `onEvent`, `onUsage` and `onOperation` callbacks. Results include a serializable `checkpoint` and optional `pause` (`input-budget`, `output-budget`, `turn-limit` or `refusals`). Limits return the accepted document normally; provider failures still throw. `AiProvider.turn` receives `maxOutputTokens` so a provider can honor the remaining allowance. Keep accepted documents in the host's repository and forward progress to the browser. See [AI import](../guide/ai-import) for the live-project lifecycle, context compaction and continuation behavior.

`renderPdfDrawing(bytes, page)` converts a reference PDF page to PNG without a model. The reference endpoint is `POST /api/ai-import/preview` with multipart `file` and `page`, plus the same-origin `X-Kerros-Import: 1` header. It works without a Claude key and does not start the import worker.

The runtime uses a compact `select_mutation_tools` catalog and supplies only the selected generated mutation definitions to each request. `AI_IMPORT_TOOLS` still exports the complete catalog for inspection; `mutationTool(kinds)` returns the exact reachable subset. All core mutations remain available.

`CandidateEdits` supports disposable `preview` and atomic `apply` through a host providing `current()` and `accept(project)`. Preview geometry, areas, shared boundaries and navigation use core mutations. The SHA-256 `projectRevision` binds a preview to the entire current document; the latest transform ID binds its calibration. Apply reuses the tested IDs and refuses stale/consumed previews. Keep its candidate `decisions` in `ImportCheckpoint`; pending previews intentionally do not survive reload. The LLM uses `preview_candidate_edits` and `apply_candidate_edits` through `SourceAnalysisTools`.

The editor HTTP adapter accepts optional `checkpoint`, `budget`, `onCheckpoint` and `onPause`. The reference endpoint validates metadata, passes checkpoints privately to the isolated worker, and streams checkpoint events before later provider requests. Budgets are per run; total provider usage remains cumulative in the sidebar. No automatic retry starts another paid run.

## Live instructions and source preview

`AiPlanImportOptions.takeInstructions` drains a host queue of `{ id, text }` messages between turns. IDs deduplicate retries; text is limited to 2,000 characters. Recent human instructions persist separately from model-written notes in `checkpoint.steering` (up to 20 messages / 8,000 serialized characters). They survive context compaction and continuation. Receiving a command does not increase run budgets.

The development endpoint emits a `session` event with `jobId`. The editor can POST `{ id, text }` to `/api/ai-import/:jobId/instructions` with `X-Kerros-Import: 1`. Same-origin checks apply. A 202 response means queued; checkpoints acknowledge receipt into the saved model context. The browser retains unacknowledged messages for Continue if the worker exits. Custom `AiImportAdapter` hosts expose `sendInstruction` and call `onSession` to enable live sending. Imports and ordinary continuations also work without this optional capability.

`onAnalysis` supplies a bounded `ImportAnalysisPreview` containing a restricted SVG, calibration and candidate counts. For image/PDF sources it can include a bounded PNG background with the original bounds and a matrix mapping it into SVG display coordinates. The server renders this background once per source page/frame per run, independently of model render budgets; it never enters model context. This is a human-only side channel, separate from provider messages and checkpoints. The reference UI persists it as a source asset and renders it as an inert image in the Analysis tab. Full artifacts remain on the server; the preview prioritizes recent selections and architectural candidates, capped at 500 candidates and 200,000 SVG characters.

## Migration

Import `runAiPlanImport`, `AI_IMPORT_TOOLS`, `AI_IMPORT_SYSTEM`, `AiProvider` and `PlanSource` from `@kerros/server` on the backend. They are no longer exported from `@kerros/import`.

Hosts that support PDF tracing backgrounds must supply `PlannerAdapters.pdfDrawing.render(file, page): Promise<Blob>`. The reference client in `app/aiImport.ts` implements the HTTP request. Hosts without that adapter can still import image backgrounds and already extracted CAD entity JSON; choosing a PDF explains the missing backend. Credentials and parsing libraries never need to be supplied to the editor.
