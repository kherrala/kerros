import type { AiToolSpec, PlanSource } from './aiImport';
import type { ImportBrief } from '../import/brief';
import {
  analysisSummary,
  CANDIDATE_KINDS,
  calibrateSource,
  queryCandidates,
  validateSourceAnalysis,
  type CandidateQuery,
  type SourceAnalysis,
  type SourceTransform,
} from './analysis';
import { analysisRequest } from './rasterAnalysis';
import type { ImportCheckpoint } from '../import/checkpoint';
import { CandidateEdits } from './candidateEdits';
import type { ProjectDocument } from '../model/types';
import { sourceAnalysisPreview } from './analysisPreview';

const artifact = { type: 'string', description: 'Artifact ID returned by analyse_source.' };
const ids = { type: 'array', items: { type: 'string' }, maxItems: 100 };
const query = {
  artifactId: artifact,
  transformId: { type: 'string', description: 'Latest calibrated transform ID; omit for original source coordinates.' },
  ids,
  kind: { type: 'string', enum: CANDIDATE_KINDS },
  minScore: {
    type: 'number',
    minimum: 0,
    maximum: 1,
    description: 'Filter heuristic detection support. Unscored native paths are excluded when set.',
  },
  bbox: {
    type: 'array',
    items: { type: 'number' },
    minItems: 4,
    maxItems: 4,
    description: 'x0,y0,x1,y1 in the requested coordinate frame.',
  },
  cursor: { type: 'string' },
  limit: { type: 'integer', minimum: 1, maximum: 25 },
  format: { type: 'string', enum: ['json', 'svg'] },
};
const tool = (name: string, description: string, properties: object, required: string[]): AiToolSpec => ({
  name,
  description,
  inputSchema: { type: 'object', properties, required, additionalProperties: false },
});
export const ANALYSIS_TOOLS: AiToolSpec[] = [
  tool(
    'preview_candidate_edits',
    'Preview 1–25 calibrated candidates as walls, unwalled boundaries, label-seeded rooms, or hosted doors/windows through the real geometry core. Returns exact usable areas, shared-junction counts and candidate-to-model IDs without changing the live project. Rooms follow the completed boundary graph including holes. Do not adopt wall faces/furniture as centrelines. Door/window widths require explicit metre measurements and a real hostBarrierId. Gaps remain open.',
    {
      artifactId: artifact,
      transformId: query.transformId,
      floorId: { type: 'string' },
      projectRevision: { type: 'string' },
      edits: {
        type: 'array',
        minItems: 1,
        maxItems: 25,
        items: {
          type: 'object',
          properties: {
            candidateId: { type: 'string' },
            as: { type: 'string', enum: ['wall', 'boundary', 'room', 'door', 'window'] },
            name: { type: 'string', maxLength: 100 },
            thickness: { type: 'number', exclusiveMinimum: 0 },
            width: { type: 'number', exclusiveMinimum: 0 },
            hostBarrierId: { type: 'string' },
          },
          required: ['candidateId', 'as'],
          additionalProperties: false,
        },
      },
    },
    ['artifactId', 'transformId', 'floorId', 'edits'],
  ),
  tool(
    'apply_candidate_edits',
    'Commit the exact tested preview atomically, preserving generated IDs. Refuses stale project or calibration revisions. Candidate mappings persist across continuations. Re-preview after manual edits or a reload.',
    {
      artifactId: artifact,
      transformId: query.transformId,
      previewId: { type: 'string' },
      projectRevision: { type: 'string' },
    },
    ['artifactId', 'transformId', 'previewId', 'projectRevision'],
  ),
  tool(
    'analyse_source',
    'Extract/cache native PDF/DWG vectors or local OpenCV wall/outline candidates and OCR for images/scanned PDFs. Returns counts, axes, units and warnings; no image payload. Start with auto; use raster for unsupported PDF regions. Reuse the artifact instead of reanalysing.',
    {
      page: { type: 'integer', minimum: 1, maximum: 20 },
      bbox: {
        ...query.bbox,
        description:
          'Optional analysis crop in ORIGINAL image pixels or PDF viewport points. A crop can truncate the exterior outline.',
      },
      mode: { type: 'string', enum: ['auto', 'native', 'raster'] },
      profile: {
        type: 'string',
        enum: ['clean', 'scan'],
        description: 'Clean drawings (default) or uneven/compressed scans.',
      },
      ocr: { type: 'boolean', description: 'Read English/Finnish/Swedish labels and mask text, default true.' },
    },
    [],
  ),
  tool(
    'find_similar_symbols',
    'Find visual repetitions of a CONFIRMED example box (door, stair, fixture etc.) using local OpenCV template matching at quarter-turn rotations, mirrored and nearby scales. Box uses ORIGINAL source coordinates. Returns a new cached artifact summary; query kind:symbol. Matches are hypotheses, not doors/portals or validated objects. Prefer a tight symbol crop without surrounding text. Native DWG uses its entity tools instead.',
    { artifactId: artifact, exemplarBounds: query.bbox, label: { type: 'string', maxLength: 60 } },
    ['artifactId', 'exemplarBounds', 'label'],
  ),
  tool(
    'calibrate_source',
    'Compute a uniform metre transform from extracted reference candidates and the user template. Select the exterior outline for width/depth/area; a single straight dimension line for a printed length. No geometry is committed.',
    {
      artifactId: artifact,
      referenceIds: ids,
      origin: {
        type: 'array',
        items: { type: 'number' },
        minItems: 2,
        maxItems: 2,
        description: 'Optional local origin in original source coordinates.',
      },
      rotationDegrees: {
        type: 'number',
        description: 'Main-axis angle counterclockwise after converting source to y-up.',
      },
      realLengthMetres: {
        type: 'number',
        exclusiveMinimum: 0,
        description: 'Printed real length; only used when the user template has no scale reference.',
      },
    },
    ['artifactId', 'referenceIds'],
  ),
  tool(
    'query_candidates',
    'Read at most 25 candidates as compact JSON or SVG text. Query wall/outline/label first for raster sources. Walls have estimated thickness, heuristic score and supporting face IDs; endpoints are not yet connected junctions. Native paths are source strokes/fills. Use stable IDs and paginate.',
    query,
    ['artifactId'],
  ),
  tool(
    'inspect_candidate',
    'Inspect one candidate and its clipping/evidence references as text. Source path coordinates can extend outside a clipping region; never adopt them without interpreting that evidence.',
    { artifactId: artifact, transformId: query.transformId, candidateId: { type: 'string' } },
    ['artifactId', 'candidateId'],
  ),
  tool(
    'render_analysis_overlay',
    'Return a bounded SVG TEXT fragment from the same candidates. Does not rasterize or send an image. Filter IDs/region and follow nextCursor for additional candidates.',
    query,
    ['artifactId'],
  ),
];

export class SourceAnalysisTools {
  private artifacts = new Map<string, SourceAnalysis>();
  private transforms = new Map<string, SourceTransform>();
  private revision = 0;
  private recipes = new Map<string, ImportCheckpoint['analysis'][number]>();
  readonly adoption?: CandidateEdits;
  constructor(
    private source: PlanSource,
    private brief?: ImportBrief,
    private onCalibration?: (transform: SourceTransform) => void,
    host?: { current(): ProjectDocument; accept(project: ProjectDocument): void | Promise<void> },
  ) {
    if (host) this.adoption = new CandidateEdits(host);
  }
  checkpoint() {
    return [...this.artifacts.values()]
      .slice(-4)
      .map(a => ({ ...analysisSummary(a), transform: this.transforms.get(a.id) }));
  }
  save(): ImportCheckpoint['analysis'] {
    const recipes = [...this.recipes.values()].slice(-8);
    while (recipes.length && JSON.stringify(recipes).length > 16_000) recipes.shift();
    return structuredClone(recipes);
  }
  private previewImages = new Map<string, string | undefined>();
  async preview(artifactId?: string, selectedIds: string[] = []) {
    const a = artifactId ? this.artifacts.get(artifactId) : [...this.artifacts.values()].at(-1);
    if (!a) return;
    const key = JSON.stringify([a.page, a.bounds]);
    if ((this.source.kind === 'image' || this.source.kind === 'pdf') && !this.previewImages.has(key)) {
      let png: string | undefined;
      try {
        const rendered = await this.source.render({ page: a.page, bbox: a.bounds.join(','), width: 1400 });
        if (rendered.pngBase64.length <= 6_000_000 && rendered.pngBase64.startsWith('iVBORw0KGgo'))
          png = rendered.pngBase64;
      } catch {
        /* An unavailable background must not refuse otherwise valid analysis. */
      }
      this.previewImages.set(key, png);
      if (this.previewImages.size > 8) this.previewImages.delete(this.previewImages.keys().next().value!);
    }
    return sourceAnalysisPreview(a, this.transforms.get(a.id), selectedIds, this.previewImages.get(key));
  }
  async restore(recipes: ImportCheckpoint['analysis'], recalibrate = true) {
    for (const recipe of recipes) {
      if (!this.source.analyse) throw new Error('This host cannot restore source analysis.');
      const request = analysisRequest(recipe.request);
      const a = validateSourceAnalysis(await this.source.analyse(request));
      if (a.id !== recipe.artifactId || a.sourceHash !== recipe.sourceHash)
        throw new Error('The drawing or analysis version changed. Start a new source analysis.');
      this.artifacts.set(a.id, a);
      this.recipes.set(a.id, { ...recipe, ...(recalibrate ? {} : { calibration: undefined }) });
      if (recalibrate && recipe.calibration) {
        const { input, revision } = recipe.calibration;
        const transform = calibrateSource(
          a,
          this.brief,
          input as unknown as Parameters<typeof calibrateSource>[2],
          revision,
        );
        this.transforms.set(a.id, transform);
        this.revision = Math.max(this.revision, revision);
      }
    }
  }
  async execute(name: string, input: Record<string, unknown>): Promise<string | undefined> {
    if (!ANALYSIS_TOOLS.some(t => t.name === name)) return;
    if (name === 'analyse_source') {
      if (!this.source.analyse)
        throw new Error('This host does not provide source vector analysis. Use extract or one source overview.');
      const request = analysisRequest(input);
      const a = validateSourceAnalysis(await this.source.analyse(request));
      this.artifacts.set(a.id, a);
      this.recipes.set(
        a.id,
        this.recipes.get(a.id) ?? { artifactId: a.id, sourceHash: a.sourceHash, request: { ...request } },
      );
      return JSON.stringify(analysisSummary(a));
    }
    const a = this.artifacts.get(String(input.artifactId));
    if (!a) throw new Error('Unknown source artifact. Call analyse_source for this page first.');
    if (name === 'find_similar_symbols') {
      if (!this.source.analyse) throw new Error('This host does not provide symbol analysis.');
      const request = analysisRequest({
        page: a.page,
        mode: 'raster',
        profile: a.raster?.profile,
        ocr: a.raster?.ocr,
        ...(a.raster ? { bbox: a.raster.region } : {}),
        symbol: { bounds: input.exemplarBounds as [number, number, number, number], label: input.label as string },
      });
      const result = validateSourceAnalysis(await this.source.analyse(request));
      this.artifacts.set(result.id, result);
      this.recipes.set(result.id, { artifactId: result.id, sourceHash: result.sourceHash, request: { ...request } });
      return JSON.stringify(analysisSummary(result));
    }
    if (name === 'calibrate_source') {
      const transform = calibrateSource(
        a,
        this.brief,
        input as unknown as Parameters<typeof calibrateSource>[2],
        ++this.revision,
      );
      this.transforms.set(a.id, transform);
      this.recipes.get(a.id)!.calibration = { input: structuredClone(input), revision: this.revision };
      this.onCalibration?.(transform);
      return JSON.stringify(transform);
    }
    const transform = input.transformId === undefined ? undefined : this.transforms.get(a.id);
    if (input.transformId !== undefined && (!transform || transform.id !== input.transformId))
      throw new Error('Unknown or stale transform. Query with the latest calibration ID.');
    if (name === 'preview_candidate_edits' || name === 'apply_candidate_edits') {
      if (!transform) throw new Error('Calibrate this artifact before adopting its candidates.');
      if (!this.adoption) throw new Error('This host does not support candidate adoption.');
      return JSON.stringify(
        name === 'preview_candidate_edits'
          ? this.adoption.preview(a, transform, input)
          : await this.adoption.apply(a, transform, input),
      );
    }
    if (name === 'inspect_candidate') {
      const c = a.candidates.find(c => c.id === input.candidateId);
      if (!c) throw new Error('Unknown candidate ID.');
      const result = queryCandidates(a, { ids: [c.id] }, transform);
      return JSON.stringify({
        ...result,
        relatedClipIds: c.clipIds ?? [],
        evidenceIds: c.evidenceIds ?? [],
        decisions: this.adoption?.decisions.filter(d => d.artifactId === a.id && d.candidateId === c.id) ?? [],
        note: 'Query evidence/clip IDs for supporting geometry. Scores are heuristic; candidates do not modify the project.',
      });
    }
    return JSON.stringify(
      queryCandidates(
        a,
        { ...input, ...(name === 'render_analysis_overlay' ? { format: 'svg' } : {}) } as CandidateQuery,
        transform,
      ),
    );
  }
}
