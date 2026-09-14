# AI import engine and integration

Developer reference for the server-owned import loop, editor adapters and saved continuations. For choosing sources and using the sidebar, see [Import features](../guide/ai-import). Exported source-analysis APIs and native prerequisites are documented in [`@kerros/server`](./server).

## Configure Claude

Sign in to [Claude Console → API keys](https://platform.claude.com/settings/keys), create a key for your workspace and copy the secret when it is shown. Anthropic's [API key guide](https://platform.claude.com/docs/en/get-api-key) explains personal and service-account keys and their scope.

Set the key in `.env.local`, using `.env.example` as the template:

```dotenv
ANTHROPIC_API_KEY=your_claude_key
# Optional: choose a compatible model available to your workspace.
# ANTHROPIC_MODEL=claude-opus-4-8
```

Run `make up` from the repository root. Restart it after changing these settings. The secret belongs to the backend and CLI; it is never a `VITE_` setting. The SDK reads `ANTHROPIC_API_KEY`, as described in [Anthropic's quickstart](https://platform.claude.com/docs/en/get-started). Imports use your API account and incur API usage.

The current default is `claude-opus-4-8`, with vision, tool use and adaptive thinking at medium effort and a 4096-token output limit per turn (clamped to the remaining run output budget). `ANTHROPIC_MODEL` can override it; the selected model must support the request settings in `src/server/claudeRequest.ts`.

## Architecture and model tools

![Import engine with server extraction, OpenCV, OCR, pattern recognition, Claude tools, validation and live editor persistence.](/diagrams/import-engine.svg)

[Open the full-size diagram](/diagrams/import-engine.svg).

Pattern recognition currently matches a selected exemplar at tested rotations, mirrors and scales;
it is not a trained architectural-symbol classifier. Native extraction and raster analysis produce
evidence. Claude interprets it; the geometry core validates edits. The browser's source overlay
is a separate channel and does not automatically add an image to the model's context.

| Step | Component | Action |
| --- | --- | --- |
| Start | Editor | Send the drawing, current project and instructions to the backend |
| Interpret | Backend and Claude | Provide source tools and selected mutation schemas; stream assistant text and tool activity to the sidebar |
| Validate | Backend and geometry core | Apply proposed edits to the working copy; return diagnostics on refusal |
| Accept | Backend | Return tool results and generated IDs to Claude; stream an accepted document snapshot to the editor |
| Save | Editor | Update the main map and persist the project and session |

Interpretation, validation and saving repeat during the run. After pausing, the user can review or edit the live project before continuing.

During import, the backend is authoritative for an isolated working document. `runAiPlanImport` from `@kerros/server` owns the provider-neutral conversation and executes model changes using `applyMutations` from `@kerros/schema`. A refused batch—including a refused reset—leaves the preceding document intact. The browser validates accepted snapshots, commits them to the live project's history and immediately saves through the host's project repository. It retains the current project ID and preserves the active floor when possible. It does not execute Claude tool calls a second time. Manual mutations and undo are suspended while the backend owns the current run; stopping returns control to the user.

The Node-only [`@kerros/server`](../reference/server) package owns extraction, analysis and the AI runner. Its tools include `analyse_source`, `find_similar_symbols`, `calibrate_source`, `query_candidates`, `inspect_candidate` and `render_analysis_overlay` for source evidence as JSON/SVG text. The tool set also includes source inspection (`list_layers`, `extract`, `render`), working notes and phase control (`set_import_notes`), document inspection (`inspect_document`, `render_document`) and atomic edits (`apply_mutations`). The mutation parameter schema is generated from the core TypeScript union and its nested model types. `select_mutation_tools` loads only the operations needed for the next task, together with their exact nested definitions; it replaces the active selection on the following turn. This avoids resending every object, lighting and navigation field while drawing walls. It includes buildings and floors; shared walls, junctions, boundaries and holes; room enclosure, splitting, merging and boundary connections; every object kind and its door/transport/material/light settings; zones, portals, origin and authored navigation. Ordinary routes remain derived from the plan.

Run `npm run generate:ai-tools` after changing model or mutation types. `npm run check:ai-tools` verifies the checked-in schema against the current core, and `make check` includes it. Generated IDs are returned by mutations and can be read through `inspect_document`; the model does not have to guess them.

The endpoint accepts multipart `file` and JSON `options` fields, including the current project as `base` and optional template values as `brief`. The brief contributes task-specific system instructions. It returns streamed NDJSON: `session`, `status`, `text`, `tool`, `usage`, `analysis`, `checkpoint`, `document`, `done` and `error` events. The client awaits each event callback, including saving accepted geometry, before consuming the next event. A failed save interrupts the import and reports the error.

The host's `AssetRepository` retains the source file and a session record keyed by project ID. In the reference app this is IndexedDB; it is separate from the portable geometry document. The session contains instructions, template, transcript, follow-up draft, accepted-edit count and usage, without another copy of the geometry. The normal `ProjectRepository` remains the single saved plan. Browser storage is local to this browser/profile; exporting a portable project does not export the AI conversation.

Reloading or leaving the project disconnects the stream and cancels its backend worker. Hiding the sidebar keeps it running. Restoring the session does not call Claude. **Continue import** starts a new conversation from the current live document and saved source, with optional follow-up instructions. Backend restarts do not remove the browser's saved project or session.

For another host, provide `PlannerAdapters.aiImport` with an `AiImportAdapter`. That enables the optional editor tab. The reference client is `app/aiImport.ts`; the local endpoint and worker lifecycle are in `server/`. See [development setup](../guide/development) for proxying and key isolation.

## Command line

With `make up` running, use the API container's installed tools. Copy the drawing into it, run the CLI, then copy the portable document back:

```sh
docker compose --env-file .env.local cp ./floor.pdf api:/tmp/floor.pdf
docker compose --env-file .env.local exec api npx vite-node scripts/plan-import/agent.ts -- /tmp/floor.pdf --out /tmp/imported.json --origin 24.938,60.169,0 --instructions "Import page 1. Exterior width is 18.4 m."
docker compose --env-file .env.local cp api:/tmp/imported.json ./imported.json
```

For a native setup, install the prerequisites in [development setup](../guide/development#native-development), then run:

```sh
npx vite-node scripts/plan-import/agent.ts -- ./floor.dwg --out ./imported.json --origin 24.938,60.169,0 --max-turns 40
```

Replace the input with an image or PDF as needed. `--instructions` accepts a short instruction; `--instructions-file ./instructions.txt` reads up to 8000 characters from a file. `--base ./existing.json` continues from a validated existing document. `--events` emits the same NDJSON event protocol used by the backend. The output JSON is saved after each accepted change, so the last successful checkpoint survives an interrupted CLI run. Open the JSON with **Reference drawings → Import reference drawing → Project**.

The backend defaults to 40 model turns (adjustable from 1–100 in Setup) and limits each run to 15 minutes, runs one job at a time, and removes temporary uploads/results after the request ends. The native CLI accepts `--max-turns` from 1 to 100. DWG entity dumps are cached beside the input file by the extractor; the backend's cache is therefore removed with its temporary job directory.

Template flags are `--building-type apartment|house|office|retail|other`, `--floor-count`, `--width-metres`, `--depth-metres` and `--footprint-m2`. For example, add `--width-metres 20 --building-type house --floor-count 1` for a single-floor house drawing with known exterior width. `--brief-file` accepts the equivalent JSON using `buildingType`, `floorCount`, `widthMetres`, `depthMetres` and `footprintAreaM2`.

## Context and usage limits

Routine history targets **12,000 estimated input tokens**, with a default ceiling of **24,000** when selected schemas and the saved checkpoint need more space. The estimate includes system instructions, the currently selected tool schemas, images and retained messages. This is a local size estimate, not the provider's tokenizer or a billing guarantee. When history exceeds the limit or 13 messages, the importer replaces older exchanges with current document counts, recent IDs, calibration, source plan, working notes, recent human instructions and the last tool result. It retains at most three recent complete exchanges, dropping more if needed. The full project remains in memory and saved storage; `inspect_document` retrieves bounded pages and selected fields when exact details are needed.

The provider uses automatic conversation caching plus a stable system-prefix cache breakpoint, following [Anthropic's prompt caching protocol](https://platform.claude.com/docs/en/build-with-claude/prompt-caching). Cache hits reduce repeated processing costs, but cached tokens are still reported in usage. Compaction and entering the image-free build phase can invalidate part of the cached conversation.

Before each further request, the importer checks cumulative per-run limits of **200,000 input tokens including cache reads/writes** and **24,000 output tokens**. These are checked between turns, so the last response can exceed a threshold; they are not strict spending caps. Three consecutive refused edit/preview batches also pause the run. Budget, refusal and turn limits produce a normal **Paused** result, with the reason shown in the sidebar. Under **Budget per run**, you can set the turn limit (1–100) and input/output token limits before starting or continuing. Defaults remain unchanged; Continue explicitly starts a new paid run while the sidebar retains session totals.

The native CLI can override the defaults with `--max-context-tokens`, `--max-input-tokens` and `--max-output-tokens`, each a positive integer. The provider's separate per-response output limit is 4096 tokens, clamped to the remaining output allowance.

## Image inspection and early geometry

Sources start with `analyse_source` and paginated candidate queries. Native PDF/DWG extraction uses supported paths and text. Raster analysis runs OpenCV and OCR locally; the LLM receives counts and selected vector candidates, not another image. It estimates wall thickness and orientation, preserves gaps and returns uncertain outline proposals. `calibrate_source` computes scale from selected extracted references; subsequent queries use its transform ID for metre coordinates. SVG queries return text and never invoke an image renderer. The original source remains available for ambiguous or unsupported regions.

On sheets containing tables, legends or separate details, the model should analyse the floor-plan region. Table rules and stair treads can resemble walls. Repeated symbols can be located from one confirmed example with `find_similar_symbols`; matches remain visual hypotheses until their meaning and host walls are checked. `preview_candidate_edits` tests an interpretation through the core; `apply_candidate_edits` commits it atomically. Closed room topology, opening hosts and a footprint interrupted by exterior doors still need interpretation.

PNG/JPEG/WebP and scanned PDF imports use three explicit phases:

1. **Inspect:** read source metadata and one overview, calibrate using the template or a printed linear dimension, and transcribe a compact geometric source plan. The calibration tool computes a uniform scale from source width/depth or footprint polygon area. Conflicting references are rejected. Without scale evidence the model should ask for a known dimension and stop.
2. **Build:** save calibration and the source plan with `set_import_notes`, then create the exterior and partitions using text. All image blocks are removed from requests and both render tools are disabled. The source plan is a model transcription, not automatic vector extraction. Every mutation remains available through the compact `select_mutation_tools` catalog.
3. **Review:** explicitly return to images only for a specific unresolved label, opening or junction. The model can then return to text-only building.

The visual-source tools allow at most three new source renders between accepted non-empty mutation batches and reuse already-seen views. A render only crops/resizes existing pixels; it is not a precision measuring tool. Analysis coordinates are mapped back to the original drawing before calibration. OCR may misread dimensions or units, and detection scores are heuristics, not probabilities. See [source analysis and calibration](../guide/ai-import-analysis) for the implemented tools, coordinate model, adoption pipeline and current limitations.

Working notes, calibration and the geometric source plan survive context compaction and reload in the saved checkpoint. Continuation starts a fresh conversation from that state and the current live project, reusing extracted artifacts from the backend cache. These controls are tested with a scripted provider, without contacting Claude.

The routine context target can grow up to the configured hard ceiling to retain the complete latest tool exchange, including parallel wall, label and document queries. Older exchanges are removed first. If three identical inspection batches return unchanged results, the run pauses with its accepted edits saved. Review the source or send a specific next instruction before continuing.

## Resuming without repeating analysis

Checkpoints save the calibrated scale, source plan, phase, notes, recent tool result, selected mutation schemas and bounded recipes for cached analysis artifacts. A continuation combines that state with the **current live project**, including manual corrections. A build-phase continuation stays text-only. Changing the import template invalidates its old scale and geometric transcription; accepted geometry remains for review. Existing sessions created before checkpoint support retain their project and chat, but their unsaved analysis cannot be recovered retroactively.

The CLI writes `<output>.checkpoint.json` after each tool operation. Resume with both `--base <output>` and `--checkpoint-file <output>.checkpoint.json`, supplying the same source and template. Browser hosts forward `checkpoint` stream events to the asset repository. No source pixels or complete candidate arrays are included in checkpoints. Analysis recipes verify the drawing hash when restoring; pending previews expire across worker restarts. A new extractor version refreshes candidates and returns to inspection for calibration and source-plan review, preserving accepted geometry. Historical candidate mappings remain evidence of earlier edits, but changed candidate IDs must be checked against the current project before adoption.

## Previewing measured candidates

`preview_candidate_edits` converts up to 25 selected candidates (100 boundary segments) through the same core used by the editor. Interpret straight centrelines as walls, explicit gaps as unwalled boundaries, interior labels as room seeds, and confirmed opening symbols as doors/windows with an explicit width and host wall ID. It reports shared junctions, exact usable room areas, courtyard holes and opening-fit intervals. It does not silently close gaps or classify every stroke as a wall.

`apply_candidate_edits` commits that exact tested project and its generated IDs. It refuses stale project/calibration revisions. Accepted candidate-to-model mappings persist and prevent duplicate adoption after a continuation; `inspect_candidate` reads those mappings. The normal mutation catalog remains available for corrections. The sidebar provides source overlays, layers, opacity and fullscreen review. Interactive candidate selection/acceptance and automatic gap/swing interpretation remain unavailable.

## Tests do not spend API tokens

`npm test`, `npm run test:server`, `make check` and the AI browser regression use scripted providers or simulated streams. They never need a Claude key. Test processes clear `ANTHROPIC_API_KEY`; the Playwright development server routes any unmocked AI request to an unavailable local test address instead of your backend. Image/PDF rendering tests run only local converters. No paid integration test runs automatically.

A real provider call starts through **Start AI import**, **Continue import**, **Send & continue**, or by launching `scripts/plan-import/agent.ts`. Starting containers and reading `/api/ai-import` status checks configuration locally and does not contact Claude.

## Operation logs and usage accounting

The **Usage** tab shows provider-reported **input**, **output**, **cache read**, and **cache write** tokens. Input excludes cache reads/writes; output includes any billed thinking tokens. Counters update whenever Claude reports usage, and remain visible after stopping or completing an import. **Continue import** adds to the current sidebar session; **Replace source drawing** starts a new session and resets the counters when started. Closing the sidebar and reloading preserve the totals. An interrupted stream may not report all consumed tokens; the display is not a billing statement.

Claude's [streaming usage counters](https://platform.claude.com/docs/en/build-with-claude/streaming) are cumulative per response. The importer replaces each turn's latest snapshot instead of adding each stream event, then sums separate turns. Custom providers can supply final usage or call `onUsage` while streaming; custom editor adapters forward per-run totals through `onUsage`.

Follow structured backend operations with:

```sh
docker compose --env-file .env.local logs -f api
```

Each JSON record has a timestamp and event; server imports also have a shared `jobId`. Events cover import start/completion/cancellation, turn and tool durations, refused mutation batches, accepted document counts, usage, and failures. `context_complete` reports the estimated request size, configured context limit and whether history was compacted. A `turn_start` without a corresponding completion indicates Claude is still responding. Logs omit prompts, chat, tool arguments, source content and credentials. Provider failures include an HTTP status when available, without serializing SDK errors. CLI runs emit the same operation metadata to stderr.
