# Import features

Bring an existing plan into Kerros as editable geometry or as a drawing to trace. Choose the import that matches your source and how much interpretation it needs.

| Import | Use it for | Result |
| --- | --- | --- |
| AI import | PNG, JPEG, WebP, PDF or DWG architectural drawings | Claude proposes walls, rooms and objects in the live project |
| CAD plan | Previously extracted CAD entity JSON | Geometry converted without an AI provider |
| Project | A saved Kerros project JSON | Restore its editable building model |
| Reference drawing | An image or PDF page for manual tracing | A background aligned to a floor, without creating walls or rooms |

AI and CAD plan imports use the **Import plan** sidebar. Reference drawings use the separate one-time drawing dialog. For the full editor controls, see [The editor](./editor).

## Before using AI import

The application needs a configured import backend. In the reference app, `make up` starts it alongside the editor. Its operator sets the Claude API key on the server; do not paste a secret into the import chat. See [Claude configuration](../reference/ai-import#configure-claude) and [development setup](./development).

Starting or continuing AI import uses your configured API account. Opening the sidebar, reviewing a saved SVG or reloading a saved session does not itself start a paid request.

## Import with AI

1. Open or create a project in **Plan editor** and choose **Import plan → AI import**.
2. In the sidebar’s **Setup** tab, choose the source drawing (up to 25 MB). PDFs may contain up to 20 pages; split larger documents before uploading.
3. Fill in any known **Import template** values: building type, floor count, exterior width/depth and footprint area. For a drawing about 20 m wide, enter `20` as exterior width and describe its approximate accuracy in the instructions. Footprint area is the area inside the exterior outline **per floor, including walls**, not total area across floors or the sum of usable room areas. One known dimension or footprint area can establish scale; additional values cross-check it. Add page selection, naming conventions and omissions in the instructions. Leave unknown values empty.
4. Choose **Start AI import**. The sidebar switches to **Activity** and accepted changes appear on the main map, using the ordinary floor selector and 2D/3D controls. Claude's text, tool calls and geometry refusals appear in the sidebar, newest first.
5. Use **Stop import** to pause. Accepted edits remain in the current project; there is no separate preview or “Use imported plan” step. Manual editing is available after stopping, so an incoming AI snapshot cannot overwrite an edit made at the same time. Accepted batches participate in the editor's undo history.
6. Use the sticky **Message to AI** field in **Activity** to refine the plan. During a run, **Send** queues instructions for Claude’s next turn. After a pause or completion, **Send & continue** starts another run with those instructions. **Continue import** also resumes without a new message. This sends the saved source and the current live project, including any manual corrections. **Replace source drawing** starts a new import session on the same project.
7. Hiding or switching away from the sidebar keeps the active import running. Reloading the page disconnects it. The project, source, template, transcript, follow-up draft and reported token totals are retained in this browser. The sidebar reopens with the saved session on reload. A running import becomes **Paused**; **Continue import** explicitly starts the next paid request. You can correct the template before continuing; this supplies new instructions and does not itself resize existing geometry.

The shared header keeps the source, status and Start/Stop/Continue control visible across all tabs. **Analysis** shows a saved source SVG with layer toggles, zoom and download. **Original drawing** overlays detected vectors on a cached image/PDF rendering, with an **SVG opacity** slider for comparison. Calibration, rotation and source-page offsets use the same transform for both layers. The source background is available for image/PDF analysis and is retained on reload. Its expand icon opens a fullscreen preview; Escape or Close returns to the sidebar and preserves your layer choices without stopping the import. Blue lines mark wall candidates, amber outlines and purple symbols; these are evidence, not accepted geometry. The preview is sent only to the browser, so displaying the preview or toggling its background does not add images or the full SVG to Claude’s context.

Activity keeps the newest messages at the top and its chat composer at the bottom. Drafts and queued instructions are saved with the session before sending. A message remains queued until a backend checkpoint acknowledges it; if a run ends first, Continue delivers it with the saved state. Messages take effect between model turns, so an in-flight response or tool batch can finish first. Chat does not raise the run’s turn/token limits. Each message supports up to 2,000 characters; recent human instructions have a separate bounded checkpoint history.

Review dimensions, connections and the model's reported uncertainties on the main map. A valid plan can still misinterpret the source drawing.

## Review scale and source evidence

Supply a known exterior width/depth or footprint area before starting. Footprint area includes walls inside the exterior outline and applies to one floor; it is not the sum of room labels. For a plan roughly 20 metres wide, enter `20` and explain that it is approximate. Leave unknown dimensions empty. Building type and floor count describe the task but do not establish scale.

The importer first inspects source evidence, then builds from a compact calibrated plan, returning to focused images for unresolved details. OpenCV proposes wall strokes and outlines, OCR proposes text, and pattern matching can find repetitions of a confirmed symbol. Each can make mistakes. Review the SVG over the original drawing, especially exterior bounds, door gaps and room labels. Blue wall candidates are not yet accepted walls.

If many rooms are below 1 m² or normal doors do not fit their wall segments, check the scale and wall locations. Ask for a correction to the specific feature; enlarging the building merely to pass validation would change its meaning. Changing the template on continuation asks the AI to recheck scale; it does not automatically resize existing geometry.

## Pausing, continuing and token usage

The **Usage** tab shows reported input, output, cache-read and cache-write tokens. Session totals include continuations and remain saved with the project. An interrupted response may not report all usage, so this display is not a billing statement.

In **Setup → Budget per run**, choose the turn limit (1–100) and input/output token limits before starting or continuing. Runs pause at their limits, after repeated refused edits, or when unchanged inspection calls repeat. Accepted changes remain saved. Review the reason, correct scale or add a specific next instruction, then choose **Continue import**. Continue starts another paid run; it does not clear earlier token totals.

Use **Stop import** before making manual corrections. Your changes become the starting project for the next continuation. Reload restores the source, chat, template, usage and saved work as a paused session; you decide when to resume. Storage belongs to this browser/profile. Exporting a project preserves the geometry, not the AI conversation.

## When an import needs attention

- **AI import unavailable:** the host needs its import backend configured. See the [developer setup](./development).
- **Unclear OCR or missing walls:** compare the source overlay and point out the affected rooms or partitions in chat. Source detections are evidence, not a complete reconstruction.
- **Repeated inspection or refusal:** review the latest diagnostic and give a concrete next action. A refreshed extractor may require another calibration review while keeping accepted edits.
- **Incorrect dimensions:** correct the template and ask the AI to inspect existing geometry before adding more rooms.
- **Backend restarted:** wait for it to become available, then continue from the saved session.

A model can pass geometry validation while still misreading the drawing. Check room connections, openings and dimensions before relying on an imported plan.

For the architecture diagram, tool catalog, streaming API, CLI and checkpoints, see [AI import engine and integration](../reference/ai-import). Source extraction details are in the [server reference](../reference/server#opencv-and-ocr); proofs and limits are kept in [Mathematical foundations](./geometry-mathematics).
