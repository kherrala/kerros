import { createHash, randomUUID } from 'node:crypto';
import { applyMutations, type Mutation } from '../model/mutations';
import { barrierEnds, distance, objectArea, segmentProjection } from '../model/geometry';
import { boundaryEdges, boundaryRegions } from '../model/boundaries';
import type { Point, ProjectDocument } from '../model/types';
import { vectorPath, type SourceAnalysis, type SourceCandidate, type SourceTransform } from './analysis';
import type { CandidateDecision } from '../import/checkpoint';

export const projectRevision = (project: ProjectDocument) =>
  createHash('sha256').update(JSON.stringify(project)).digest('hex');
export interface CandidateEdit {
  candidateId: string;
  as: 'wall' | 'boundary' | 'room' | 'door' | 'window';
  name?: string;
  thickness?: number;
  width?: number;
  hostBarrierId?: string;
}
interface Prepared {
  id: string;
  artifactId: string;
  transformId: string;
  baseRevision: string;
  project: ProjectDocument;
  decisions: CandidateDecision[];
}
const grid = (p: Point): Point => p.map(n => Math.round(n * 100) / 100) as Point;
const middle = (c: SourceCandidate, transform: SourceTransform): Point => {
  const points = vectorPath(c.path, transform.matrix).filter(p => p[0] === 'M' || p[0] === 'L');
  if (!points.length) throw new Error(`Candidate ${c.id} has no position.`);
  return [
    points.reduce((n, p) => n + Number(p[1]), 0) / points.length,
    points.reduce((n, p) => n + Number(p[2]), 0) / points.length,
  ];
};
function segments(c: SourceCandidate, transform: SourceTransform): [Point, Point][] {
  if (
    !['wall', 'path', 'outline'].includes(c.kind) ||
    c.clipIds?.length ||
    c.path.some(p => p[0] === 'C' || p[0] === 'Q')
  )
    throw new Error(
      `Candidate ${c.id}: choose an unclipped straight centreline or outline; curves/fills need interpretation first.`,
    );
  let first: Point | undefined, previous: Point | undefined;
  const result: [Point, Point][] = [];
  for (const command of vectorPath(c.path, transform.matrix)) {
    const point: Point | undefined = command[0] === 'Z' ? first : grid([Number(command[1]), Number(command[2])]);
    if (command[0] === 'M') first = point;
    else if (previous && point && distance(previous, point) > 1e-6) result.push([previous, point]);
    previous = point;
  }
  if (!result.length || result.length > 100)
    throw new Error(`Candidate ${c.id}: select 1–100 nonzero straight segments.`);
  return result;
}

/** Candidate interpretation supplies evidence/IDs; the geometry core alone constructs,
 * planarizes, binds spaces, fits openings and validates. A failed preview never reaches the host. */
export class CandidateEdits {
  private previews = new Map<string, Prepared>();
  decisions: CandidateDecision[] = [];
  constructor(private host: { current(): ProjectDocument; accept(project: ProjectDocument): void | Promise<void> }) {}

  preview(a: SourceAnalysis, transform: SourceTransform, input: Record<string, unknown>) {
    const base = this.host.current();
    const baseRevision = projectRevision(base);
    if (input.projectRevision !== undefined && input.projectRevision !== baseRevision)
      throw new Error('Project changed. Inspect the live document and preview again.');
    const floorId = input.floorId;
    if (typeof floorId !== 'string' || !base.floors.some(f => f.id === floorId))
      throw new Error('Choose an existing floor ID.');
    if (!Array.isArray(input.edits) || !input.edits.length || input.edits.length > 25)
      throw new Error('Preview 1–25 candidate interpretations at a time.');
    const edits = input.edits as CandidateEdit[];
    const ids = new Set<string>();
    for (const edit of edits) {
      if (!edit || !['wall', 'boundary', 'room', 'door', 'window'].includes(edit.as) || ids.has(edit.candidateId))
        throw new Error('Select each candidate once and give its interpretation.');
      ids.add(edit.candidateId);
      if (edit.name !== undefined && (typeof edit.name !== 'string' || edit.name.length > 100))
        throw new Error('Names must be at most 100 characters.');
      for (const key of ['thickness', 'width'] as const)
        if (edit[key] !== undefined && (!Number.isFinite(edit[key]) || edit[key]! <= 0))
          throw new Error(`${key} must be positive metres.`);
      if (
        this.decisions.some(
          d =>
            d.artifactId === a.id &&
            d.floorId === floorId &&
            d.candidateId === edit.candidateId &&
            d.status === 'accepted',
        )
      )
        throw new Error(
          `Candidate ${edit.candidateId} was already accepted on this floor. Inspect or correct its existing model IDs instead of duplicating it.`,
        );
    }
    let draft = base;
    const apply = (mutations: Mutation[], candidateId: string) => {
      const result = applyMutations(draft, mutations);
      if (!result.ok)
        throw new Error(`Candidate ${candidateId}; preview refused, live project unchanged: ${result.error}`);
      draft = result.project;
      return result.outcomes;
    };
    const decisions: CandidateDecision[] = [];
    const wallSpans = new Map<string, { spans: [Point, Point][]; edit: CandidateEdit; thickness: number }>();
    // Boundaries first, then hosted objects/rooms, irrespective of the requested order.
    let segmentCount = 0;
    for (const edit of edits.filter(e => e.as === 'wall' || e.as === 'boundary')) {
      const c = a.candidates.find(c => c.id === edit.candidateId);
      if (!c) throw new Error(`Unknown candidate ${edit.candidateId}.`);
      const spans = segments(c, transform);
      segmentCount += spans.length;
      if (segmentCount > 100) throw new Error('Preview at most 100 boundary segments per batch.');
      apply(
        spans.map(([a, b]) =>
          edit.as === 'wall' ? { kind: 'drawBarrier', floorId, a, b } : { kind: 'drawBoundary', floorId, a, b },
        ),
        c.id,
      );
      wallSpans.set(c.id, {
        spans,
        edit,
        thickness: edit.thickness ?? (c.thickness === undefined ? 0.2 : c.thickness * transform.metresPerUnit),
      });
    }
    // After core planarization, one candidate can correspond to several real edges at T/X joins.
    for (const [candidateId, { spans, edit, thickness }] of wallSpans) {
      const matching = boundaryEdges(draft).filter(
        edge =>
          edge.floorId === floorId &&
          (edit.as === 'wall' ? 'thickness' in edge : !('thickness' in edge)) &&
          spans.some(([a, b]) => barrierEnds(draft, edge).every(p => segmentProjection(p, a, b).distance <= 0.011)),
      );
      if (!matching.length) throw new Error(`Candidate ${candidateId} did not produce a boundary.`);
      if (edit.as === 'wall')
        apply(
          matching.map(edge => ({
            kind: 'patchBarrier',
            barrierId: edge.id,
            set: { thickness, ...(edit.name ? { name: edit.name } : {}) },
          })),
          candidateId,
        );
      decisions.push({
        artifactId: a.id,
        transformId: transform.id,
        floorId,
        candidateId,
        status: 'accepted',
        modelIds: matching.map(e => e.id),
      });
    }
    const openings: {
      candidateId: string;
      hostId: string;
      length: number;
      width: number;
      offset: number;
      fitInterval: [number, number];
    }[] = [];
    for (const edit of edits.filter(e => e.as !== 'wall' && e.as !== 'boundary')) {
      const c = a.candidates.find(c => c.id === edit.candidateId);
      if (!c) throw new Error(`Unknown candidate ${edit.candidateId}.`);
      const point = middle(c, transform);
      let mutation: Mutation;
      if (edit.as === 'room') {
        if (c.kind !== 'label')
          throw new Error(`Candidate ${c.id}: select an interior room label as the enclosure seed.`);
        mutation = { kind: 'encloseRoom', floorId, point, name: edit.name ?? c.text ?? 'Room' };
      } else {
        if (edit.width === undefined)
          throw new Error(
            `Candidate ${c.id}: confirm an opening width in metres. Symbol box size is not an opening width.`,
          );
        const host = draft.barriers.find(b => b.id === edit.hostBarrierId && b.floorId === floorId);
        if (!host)
          throw new Error(`Candidate ${c.id}: select its physical hostBarrierId from the preview or live document.`);
        const [a, b] = barrierEnds(draft, host),
          hit = segmentProjection(point, a, b),
          length = distance(a, b);
        const offset = hit.t * length;
        if (hit.distance > host.thickness / 2 + edit.width / 2)
          throw new Error(`Candidate ${c.id} is too far from this host wall.`);
        openings.push({
          candidateId: c.id,
          hostId: host.id,
          length,
          width: edit.width,
          offset,
          fitInterval: [edit.width / 2, length - edit.width / 2],
        });
        mutation = {
          kind: 'addObject',
          objectKind: edit.as as 'door' | 'window',
          floorId,
          position: point,
          name: edit.name ?? edit.as,
          set: { barrierId: host.id, offset, width: edit.width },
        };
      }
      const modelIds = (apply([mutation], c.id) ?? []).filter((v): v is string => typeof v === 'string');
      decisions.push({
        artifactId: a.id,
        transformId: transform.id,
        floorId,
        candidateId: c.id,
        status: 'accepted',
        modelIds,
      });
    }
    apply([{ kind: 'refreshPortals' }], 'access');
    const key = (d: CandidateDecision) => `${d.artifactId}:${d.floorId}:${d.candidateId}`;
    const replacements = new Set(decisions.map(key));
    const oldEdges = boundaryEdges(base),
      newEdges = boundaryEdges(draft);
    const previousDecisions = this.decisions
      .filter(d => !replacements.has(key(d)))
      .map(d => {
        if (d.status !== 'accepted') return d;
        const modelIds = [
          ...new Set(
            d.modelIds.flatMap(id => {
              const old = oldEdges.find(e => e.id === id);
              if (!old) return draft.objects.some(o => o.id === id) ? [id] : [];
              const [a, b] = barrierEnds(base, old);
              return newEdges
                .filter(
                  e =>
                    e.floorId === old.floorId &&
                    'thickness' in e === 'thickness' in old &&
                    barrierEnds(draft, e).every(p => segmentProjection(p, a, b).distance <= 0.011),
                )
                .map(e => e.id);
            }),
          ),
        ];
        return { ...d, modelIds, status: modelIds.length ? ('accepted' as const) : ('needs-review' as const) };
      });
    const nextDecisions = [...previousDecisions, ...decisions];
    if (JSON.stringify(nextDecisions).length > 32_000)
      throw new Error('Candidate mapping storage is full. Continue with ordinary mutations and inspect existing IDs.');
    const prepared: Prepared = {
      id: randomUUID(),
      artifactId: a.id,
      transformId: transform.id,
      baseRevision,
      project: draft,
      decisions: nextDecisions,
    };
    this.previews.set(prepared.id, prepared);
    while (this.previews.size > 3) this.previews.delete(this.previews.keys().next().value!);
    const changedObjects = draft.objects.filter(
      o => JSON.stringify(o) !== JSON.stringify(base.objects.find(b => b.id === o.id)),
    );
    const edges = boundaryEdges(draft).filter(e => e.floorId === floorId);
    const junctions = draft.junctions
      .filter(j => j.floorId === floorId)
      .map(j => {
        const degree = edges.filter(e => e.startId === j.id || e.endId === j.id).length;
        return {
          id: j.id,
          position: j.position,
          degree,
          kind: degree === 1 ? 'end' : degree === 2 ? 'L/straight' : degree === 3 ? 'T' : 'X/multiple',
        };
      });
    return {
      valid: true,
      previewId: prepared.id,
      projectRevision: baseRevision,
      transformId: transform.id,
      mappings: decisions.map(d => ({ ...d, status: 'proposed' })),
      rooms: changedObjects
        .filter(o => o.kind === 'room')
        .map(o => ({ id: o.id, name: o.name, usableAreaM2: objectArea(o), holes: (o.rings?.length ?? 1) - 1 })),
      openings,
      topology: {
        junctionCount: junctions.length,
        junctions: junctions.slice(0, 25),
        enclosedFaces: boundaryRegions(draft, floorId).length,
      },
      note: 'The preview is uncommitted. Gaps remain open unless explicitly interpreted as a boundary; no physical wall is inferred across them. Apply requires the same project and calibration revision.',
    };
  }

  async apply(a: SourceAnalysis, transform: SourceTransform, input: Record<string, unknown>) {
    const prepared = this.previews.get(String(input.previewId));
    if (!prepared || prepared.artifactId !== a.id || prepared.transformId !== transform.id)
      throw new Error('Unknown or expired preview. Preview again with the latest calibration.');
    if (
      input.projectRevision !== prepared.baseRevision ||
      projectRevision(this.host.current()) !== prepared.baseRevision
    )
      throw new Error('Project changed since preview. Preview again; no edits were applied.');
    // Exact tested IDs and geometry, never re-run mutations with newly generated IDs.
    await this.host.accept(structuredClone(prepared.project));
    this.decisions = prepared.decisions;
    this.previews.clear();
    return {
      applied: true,
      projectRevision: projectRevision(prepared.project),
      note: 'Candidate mappings are retained; query candidate IDs to inspect accepted model IDs.',
    };
  }
}
