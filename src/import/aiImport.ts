// AI-assisted plan import, provider-agnostic. This module owns everything that makes the import an
// *import* — the tool catalog, the Kerros briefing, the conversation loop, and the document state
// behind an atomic applyMutations gate. What it deliberately does NOT own is the AI itself: the
// host supplies an `AiProvider` (one model turn: messages in, content blocks out) with its own SDK
// and credentials, a `PlanSource` for reading the drawing (DWG parsing is native tooling), and a
// `rasterize` function (SVG → PNG needs a browser or headless renderer). The reference app and the
// script runner are both such hosts; see scripts/plan-import/agent.ts for a complete one.
//
// The safety property the split preserves: every write the model proposes goes through
// applyMutations, so a hallucinated script is refused with the reason and the document stays valid
// at every point of the run — no provider can break that from outside.
import { applyMutations, emptyProject, geoOrigin } from '../schema';
import type { Mutation, ProjectDocument } from '../schema';
import { documentSvg } from './documentSvg';

// ——— The neutral conversation shapes a host maps to its SDK. Kept minimal on purpose.
export type AiContent =
  | { type: 'text'; text: string }
  | { type: 'image_png'; base64: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; toolUseId: string; content: AiContent[]; isError?: boolean }
  /** Provider-private blocks (e.g. thinking) that must survive the round trip untouched. The loop
   *  never reads them; the provider maps `raw` back verbatim when resending history. */
  | { type: 'opaque'; raw: unknown };
export interface AiMessage {
  role: 'user' | 'assistant';
  content: AiContent[];
}
export interface AiToolSpec {
  name: string;
  description: string;
  /** JSON Schema for the tool input. */
  inputSchema: Record<string, unknown>;
}
/** One model turn. Return the assistant's content; the loop ends when it contains no tool_use. */
export interface AiProvider {
  turn(request: { system: string; tools: AiToolSpec[]; messages: AiMessage[] }): Promise<AiContent[]>;
}
/** Read access to the drawing, in the extract.mjs vocabulary: per-layer stats, filtered entity
 *  JSON (metres), and a rendered view. All host-side — DWG parsing needs native tooling. */
export interface PlanSource {
  stats(): Promise<string>;
  extract(query: { layers?: string; types?: string; bbox?: string }): Promise<string>;
  render(query: { layers?: string; bbox?: string; width?: number }): Promise<{ pngBase64: string; note: string }>;
}

export interface AiPlanImportOptions {
  /** Geo anchor for the created project: [lng, lat, bearing?]. Default: Helsinki. */
  origin?: [number, number, number?];
  /** Continue from an existing document instead of an empty single-floor project. */
  base?: ProjectDocument;
  /** SVG → PNG, for showing the model its own output. */
  rasterize: (svg: string, width: number, height: number) => Promise<string>;
  maxTurns?: number;
  /** Progress: assistant text and tool activity as they happen. */
  onEvent?: (event: { type: 'text' | 'tool'; detail: string }) => void;
  /** Called with the working document after every accepted change — hosts persist here. */
  onDocument?: (document: ProjectDocument) => void;
}
export interface AiPlanImportResult {
  document: ProjectDocument;
  turns: number;
  /** The model's closing summary, when it wrote one. */
  summary: string;
}

export const AI_IMPORT_TOOLS: AiToolSpec[] = [
  {
    name: 'list_layers',
    description:
      'Per-layer entity counts and bounding boxes for the drawing, in metres. Call this first to see what semantic layers exist (walls, doors, windows, room labels, stairs...).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false, required: [] },
  },
  {
    name: 'extract',
    description:
      'Extract normalized entities from the drawing as JSON, coordinates in metres. Filter with a layer-name regex, entity types and/or a bounding box — narrow queries; the full drawing is megabytes. Entity shapes: LINE{a,b}, POLYLINE{points,closed}, ARC{center,r,start,end}, CIRCLE{center,r}, TEXT{at,text,h}, INSERT{block,at,rotation}.',
    inputSchema: {
      type: 'object',
      properties: {
        layers: { type: 'string', description: "Layer name regex, e.g. '^(12_|27_)'" },
        types: { type: 'string', description: "Comma-separated entity types, e.g. 'TEXT' or 'LINE,ARC'" },
        bbox: { type: 'string', description: "Crop 'x0,y0,x1,y1' in metres" },
      },
      additionalProperties: false,
      required: [],
    },
  },
  {
    name: 'render',
    description:
      'Render drawing entities to an image so you can SEE them — colour per layer. Use to understand geometry before extracting, and to zoom into confusing regions with bbox.',
    inputSchema: {
      type: 'object',
      properties: {
        layers: { type: 'string', description: 'Layer name regex' },
        bbox: { type: 'string', description: "Crop 'x0,y0,x1,y1' in metres" },
        width: { type: 'integer', description: 'Image width in px, default 1400' },
      },
      additionalProperties: false,
      required: [],
    },
  },
  {
    name: 'apply_mutations',
    description:
      'Apply a Kerros Mutation[] to the working document, atomically: every mutation applies and the whole result passes validation, or NOTHING changes and you get the refusal reason back. Outcomes report what each step created (ids). The document persists between calls.',
    inputSchema: {
      type: 'object',
      properties: {
        mutations: {
          type: 'array',
          description: 'The Mutation array, as documented in the system prompt.',
          items: { type: 'object' },
        },
        reset: { type: 'boolean', description: 'True to discard the working document and start over first.' },
      },
      additionalProperties: false,
      required: ['mutations'],
    },
  },
  {
    name: 'render_document',
    description:
      'Render the CURRENT working Kerros document to an image — spaces with names, walls, openings. Compare it against render() of the source drawing to verify your conversion visually.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false, required: [] },
  },
];

export const AI_IMPORT_SYSTEM = `You are converting an architectural CAD drawing (already parsed for you) into a Kerros indoor-map document. Work in metres; the extraction tools already output metres in a shared coordinate frame. The y axis points up in the data and in every rendering.

The Kerros document model, briefly:
- barriers: wall/fence segments between junctions. Create with {kind:'addBarrier', a:[x,y], b:[x,y], floorId:'floor-ground', barrierKind:'wall'}. Walls must be >= 0.5 m; a wall carrying an opening must be >= 1 m.
- spaces: rooms and other areas. Create with {kind:'addObject', objectKind:'room', name, position:[x,y], floorId:'floor-ground', set:{rings:[[[x,y],...closed ring...]], width, depth}}. Rings are closed (first point repeated last), non-self-intersecting. Other kinds: 'zone' (drawn area), 'stairs', 'elevator', 'door', 'window', 'poi', 'parcel' (outdoor ground, floorId null).
- openings: doors/windows placed with addObject (objectKind 'door'/'window'), either free-standing (position+rotation) or bound to a wall via set:{barrierId, offset} where offset is metres along the wall from its start. Bound openings must fit their wall.
- After geometry, {kind:'refreshPortals'} reads doorways and open boundaries off the plan automatically, and {kind:'addZone', name, spaceIds:[...]} groups spaces.
- patchObject/removeObjects/splitRoom/mergeSpaces exist for corrections.

Method that works:
1. list_layers, then render the wall + door + window + label layers to SEE the plan.
2. Extract room-label TEXT (they give you names and areas in m²) and the wall LINE work per layer.
3. Build the exterior walls and interior partitions as barriers from wall centrelines or face pairs (pick ONE face consistently; walls in these drawings are drawn as parallel line pairs).
4. Build one room space per label, tracing its boundary from the wall lines around it. Cross-check each room's ring area against the label's m² figure — they should agree within ~15%.
5. Place doors and windows (door/window layers or blocks); bind them to their walls when clearly on one.
6. refreshPortals, then render_document and compare against render() of the source. Iterate until the plans match.
Every apply is atomic and validated — if refused, read the reason and fix the script rather than retrying blindly. Keep individual apply batches reviewable (tens of mutations, not hundreds), and build incrementally: exterior shell first, verify, then partitions, then rooms, then openings.
When you are satisfied, summarize what was produced, room by room, with any known gaps.`;

/** Drive an AI provider through the plan-import tool loop until it stops calling tools. The
 *  returned document is valid — every accepted change passed the full schema rule set. */
export async function runAiPlanImport(
  provider: AiProvider,
  source: PlanSource,
  options: AiPlanImportOptions,
): Promise<AiPlanImportResult> {
  const origin = options.origin ?? [24.938, 60.169];
  let current = options.base ?? emptyProject(geoOrigin([origin[0], origin[1]], origin[2]), 'Imported plan');
  const docStats = () =>
    `${current.objects.length} objects, ${current.barriers.length} barriers, ${current.zones?.length ?? 0} zones, ${current.portals?.length ?? 0} portals`;

  async function runTool(name: string, input: Record<string, unknown>): Promise<AiContent[]> {
    switch (name) {
      case 'list_layers':
        return [{ type: 'text', text: await source.stats() }];
      case 'extract': {
        const json = await source.extract(input as { layers?: string });
        if (json.length > 60_000)
          return [
            {
              type: 'text',
              text: `Result is ${json.length} chars — too large to read whole. Narrow with layers/types/bbox. Preview:\n${json.slice(0, 4000)}`,
            },
          ];
        return [{ type: 'text', text: json }];
      }
      case 'render': {
        const { pngBase64, note } = await source.render(input as { layers?: string });
        return [
          { type: 'text', text: note },
          { type: 'image_png', base64: pngBase64 },
        ];
      }
      case 'apply_mutations': {
        if (input.reset) current = emptyProject(geoOrigin([origin[0], origin[1]], origin[2]), 'Imported plan');
        const result = applyMutations(current, input.mutations as Mutation[]);
        if (!result.ok) return [{ type: 'text', text: `REFUSED (document unchanged): ${result.error}` }];
        current = result.project;
        options.onDocument?.(current);
        const outcomes = (result.outcomes ?? [])
          .map((o, i) =>
            o === undefined
              ? null
              : `#${i}: ${typeof o === 'object' ? ((o as { id?: string }).id ?? JSON.stringify(o)) : o}`,
          )
          .filter(Boolean)
          .join('\n');
        return [{ type: 'text', text: `ok — document now has ${docStats()}.\n${outcomes}` }];
      }
      case 'render_document': {
        const svg = documentSvg(current, 1400);
        const height = Number(/height="(\d+)"/.exec(svg)?.[1] ?? 900);
        const png = await options.rasterize(svg, 1400, height);
        return [
          { type: 'text', text: docStats() },
          { type: 'image_png', base64: png },
        ];
      }
      default:
        return [{ type: 'text', text: `Unknown tool ${name}` }];
    }
  }

  const messages: AiMessage[] = [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'Convert the drawing into a Kerros document. Ground floor only (floor-ground).' },
      ],
    },
  ];
  let summary = '';
  const maxTurns = options.maxTurns ?? 40;
  let turn = 0;
  for (; turn < maxTurns; turn++) {
    const content = await provider.turn({ system: AI_IMPORT_SYSTEM, tools: AI_IMPORT_TOOLS, messages });
    messages.push({ role: 'assistant', content });
    const text = content
      .filter(c => c.type === 'text')
      .map(c => (c as { text: string }).text)
      .join('\n');
    if (text) {
      summary = text;
      options.onEvent?.({ type: 'text', detail: text });
    }
    const toolUses = content.filter((c): c is Extract<AiContent, { type: 'tool_use' }> => c.type === 'tool_use');
    if (!toolUses.length) break;
    const results: AiContent[] = [];
    for (const use of toolUses) {
      options.onEvent?.({ type: 'tool', detail: `${use.name} ${JSON.stringify(use.input).slice(0, 200)}` });
      try {
        results.push({ type: 'tool_result', toolUseId: use.id, content: await runTool(use.name, use.input) });
      } catch (error) {
        results.push({
          type: 'tool_result',
          toolUseId: use.id,
          content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
          isError: true,
        });
      }
    }
    messages.push({ role: 'user', content: results });
  }
  return { document: current, turns: turn, summary };
}
