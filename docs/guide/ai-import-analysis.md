# AI source analysis and calibration

Kerros separates source evidence from editable building geometry. Local extraction finds paths, labels and possible walls; calibrated text tools let the model interpret that evidence. Candidate edits then pass through the same geometry core as manual editing. An SVG visualizes the evidence, while rooms, shared boundaries and navigation belong to the project model.

For the editor workflow, sidebar controls and API-key setup, see [Import features](./ai-import). For exported types, tool parameters and host integration, see [`@kerros/server`](../reference/server).

## From drawing to live project

1. Extract and cache paths, labels and candidate geometry locally from the image, PDF or DWG.
2. Calibrate selected source references against known real dimensions or footprint area.
3. Give the model bounded candidate JSON or SVG text to interpret.
4. Preview its proposed edits through the geometry core. Refusals return diagnostics for correction.
5. Apply a valid batch to the live project and save it.

The human SVG/source-image preview reads the same evidence and calibration through a separate browser channel.

The import template supplies building type, requested floors, exterior dimensions and footprint area. Building type helps define scope and naming; it does not supply missing measurements. Footprint area applies to one floor's exterior outline, including walls. Different floor measurements currently need instructions and selected references; the template has one set of scale values.

Source extraction runs in the Node-only server package. PDF.js, LibreDWG, OpenCV, OCR and the Claude SDK stay outside the editor bundle. An import uses an isolated backend working document. Accepted snapshots update and save the live project; manual editing resumes after stopping the run.

## Source evidence and coordinate frames

`SourceAnalysis` is the canonical source artifact. It records a source hash, page, bounds, coordinate units/axis, warnings and candidates. SVG is generated from this JSON rather than maintained as another geometry model.

| Record | Current contents |
| --- | --- |
| Source candidate | Artifact-scoped ID, kind, path and source bounds; optional text, layer, stroke/fill and clipping references |
| Raster proposal | Wall thickness, supporting evidence IDs, heuristic score and uncertainty where available |
| Calibration | Versioned transform ID, affine matrix, uniform metres-per-unit scale, selected reference IDs and basis |
| Adoption decision | Artifact, transform, floor and candidate IDs, status and generated model IDs, stored separately from source evidence |

Candidate kinds are `path`, `label`, `clip`, `image-region`, `wall`, `outline` and `symbol`. A detected centreline does not yet carry shared endpoint IDs or an opening host. Those relationships are established when an interpretation is adopted through the core. Scores indicate heuristic support, not calibrated probabilities.

Raster candidates use original image pixels; PDF candidates use the rotated page viewport's points. Both have a y-down frame. Native DWG extraction normalizes coordinates to metres using its unit/plot-scale assumptions; verify them against a known dimension. Cropped/resized analysis images retain an explicit affine map back to original source coordinates, so preview pixels cannot accidentally become metres.

`SourceTransform.matrix` stores `[a, b, c, d, e, f]` with:

$$
\begin{pmatrix}x'\\y'\\1\end{pmatrix}
=
\begin{pmatrix}a&c&e\\b&d&f\\0&0&1\end{pmatrix}
\begin{pmatrix}x\\y\\1\end{pmatrix}.
$$

Calibrated candidate queries use metres and a y-up frame. The transform combines uniform scale, the selected main-axis rotation, source-axis conversion and local origin. It changes the query's representation without altering the source artifact or resizing the live project.

## Local extraction

**Native vectors.** PDF extraction preserves supported paths, curves, text anchors, graphics transforms, page rotation and clipping references. Unsupported operators are reported. DWG extraction exposes normalized entity paths, layers and labels. A source stroke or fill is evidence; it is not automatically a physical wall.

**Raster preparation and text.** Images use OpenCV analysis. PDF auto mode also analyses raster-image content, and a region can explicitly request raster mode. The `clean` profile uses Otsu thresholding; `scan` uses adaptive thresholding with dark-ink preservation. Analysis is bounded to 2400 pixels per side and may upsample small sources up to 3× for OCR. Finnish, English and Swedish OCR returns word boxes and masks recognized text before wall detection. Upsampling does not add measurement precision.

**Walls and outlines.** A line-segment detector finds stroke faces; parallel-face pairing and cross-sectional ink tests propose centrelines and thicknesses for filled or double-line walls. Ink contours preserve concavities and identify obvious page frames. The worker preserves gaps and reports orientation evidence instead of rotating the image onto a guessed axis. Tables, furniture, stair treads and interrupted exterior outlines still require interpretation. Crop the floor-plan region on sheets containing schedules or details.

**Repeated symbols.** `find_similar_symbols` searches for a confirmed example using template correlation, quarter turns, mirrored variants and scales 0.9/1/1.1. Overlap suppression removes repeated matches and the exemplar itself. Results retain the example reference and a score. This supports repeated conventions within a drawing; it does not classify arbitrary architectural symbols, assign door handedness or choose opening hosts.

Artifacts are cached by source hash, page, extraction options and analysis version. Crops, profiles, OCR settings and exemplars have distinct cache entries. Full candidate arrays, masks and source pixels stay outside the model's routine conversation.

## Calibration

`calibrate_source` measures selected extracted references. Width/depth use their extents after main-axis rotation. For a source length $d$ and real length $D$, the uniform scale is:

$$s=\frac{D}{d}.$$

For selected source footprint area $a$ and real footprint area $A$:

$$s=\sqrt{\frac{A}{a}}.$$

Area is calculated from the selected polygon, including concavities, rather than from its bounding rectangle or summed room labels. Current area calibration requires one closed straight exterior outline without holes or multiple subpaths. Curved or clipped extents cannot establish scale from their bounds. When no template scale is supplied, a printed length requires a selected straight segment and its real length.

Additional reference values cross-check the scale. Conflicting measurements are refused rather than independently stretching the axes. Recalibration changes the transform ID and invalidates older query cursors and edit previews. Changing the template on continuation invalidates the previous scale and geometric transcription; accepted project geometry remains available for review.

## Bounded tools and atomic adoption

| Tool | Result and effect |
| --- | --- |
| `analyse_source` | Cached artifact ID, frame, counts, orientation evidence and warnings |
| `find_similar_symbols` | New source artifact containing visual-match hypotheses |
| `calibrate_source` | Versioned scale/coordinate transform from selected references |
| `query_candidates` | Relevant candidates as JSON or SVG text; filter by kind, region, IDs or minimum score and paginate |
| `inspect_candidate` | One candidate with evidence, clipping references and saved adoption decisions |
| `render_analysis_overlay` | Bounded SVG text, without rasterizing it for the model |
| `preview_candidate_edits` | Exact geometry-core result and diagnostics, without changing the live document |
| `apply_candidate_edits` | Commit the prepared project and generated IDs if project and calibration revisions still match |

Candidate queries return at most 25 records and 12,000 serialized characters. They can return fewer records to fit the text limit. A single oversized candidate produces a request to narrow the source region or inspect it visually. JSON retains explicit units and evidence; SVG groups carry candidate IDs, kinds and layers. Neither form requires resending the full drawing.

An adoption preview accepts up to 25 interpretations and 100 boundary segments. Straight candidates can become physical walls or unwalled boundaries; interior labels can seed room enclosure. A door/window interpretation requires an explicit width in metres and an existing host barrier ID. The core planarizes supplied segments into shared junctions, encloses regions with holes and validates the whole batch. It preserves explicit gaps rather than inventing missing source geometry.

Preview diagnostics include exact usable room areas, shared junctions, opening fit and candidate-to-model IDs. The 1 m² usable-space minimum still applies. An opening of width $w$, centred at offset $o$ on a host segment of length $L$, fits when:

$$\frac{w}{2}\leq o\leq L-\frac{w}{2}.$$

Short hosts and undersized spaces together can indicate a scale error or mistaken wall-face pairing. Refused previews leave the project unchanged, allowing a targeted correction. Apply reuses the tested IDs and rejects stale or consumed previews. Accepted mappings survive continuation and prevent duplicate adoption. All core mutation operations remain available through `select_mutation_tools` for corrections beyond candidate adoption.

## Human review and continuation

The editor's **Analysis** tab displays a restricted SVG with layer controls, zoom, fullscreen and download. For image/PDF sources, the **Original drawing** background and **SVG opacity** slider expose alignment and detection errors. The raster and vectors share the same calibrated transform. The preview is a separate browser asset, capped at 500 candidates and 200,000 SVG characters; it is not added to Claude's context. Interactive candidate acceptance/rejection and measured-endpoint selection are not yet available in this view.

The model works through inspect, build and review phases. Build requests remove images and use calibrated evidence, a compact source plan, working notes and selected mutation schemas. A focused image can be requested after explicitly returning to review. Context compaction retains a semantic checkpoint; the full document remains accessible through bounded inspection tools.

Checkpoints retain calibration, phase, source plan, notes, selected schemas, analysis-cache recipes, adoption mappings and recent human instructions. They contain neither source pixels nor a second project document. Continuation combines the checkpoint with the current live project, preserving manual corrections. Artifact restoration verifies the source hash. A new extraction version refreshes evidence and requires calibration review while preserving accepted geometry; pending edit previews must be regenerated. Turn/token limits pause normally and require an explicit continuation, while session token totals remain cumulative.

The sticky **Activity** composer sends instructions between model turns. Drafts and queued messages are saved before transmission; unacknowledged messages remain available for continuation if the run ends. Hiding the sidebar keeps the import running. Reloading disconnects it and restores the saved session as paused. See the [import guide](./ai-import) for controls and the [server reference](../reference/server#live-instructions-and-source-preview) for the streaming protocol.

## Verification

Ordinary model-loop and protocol tests use scripted providers and consume no LLM tokens. They cover bounded queries, stable IDs, cache restoration, transform invalidation, stale previews, atomic refusal, exact usable areas, T/X junctions, courtyard holes, opening fit, unwalled navigation and image-free build/continuation requests. Browser tests cover live edits, token/turn pauses, saved chat and queued instructions, SVG overlays, fullscreen, sidebar hiding and reload recovery with manual corrections.

Run `make test-raster` for the explicit native OpenCV/OCR fixtures in an isolated Docker container with networking disabled. Fixtures cover wall centreline/thickness accuracy, preserved gaps and close parallels, 15° geometry, L-shaped contours, page frames, OCR, cropped/resized transforms, cache reuse, mixed PDFs and rotated/mirrored exemplars with hard negatives.

Core validity and source accuracy are different properties: a valid plan can still misinterpret the drawing. Detector counts from a user drawing do not measure accuracy. Paid provider benchmarks require an explicit run; the implementation does not claim a measured token- or cost-saving percentage.

For the related proofs and error bounds, see [Image analysis and calibration](/academic/image-analysis) and [Geometry and topology validation](/academic/validation).
