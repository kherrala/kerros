import { readImportBrief, type ImportBrief, type SourceCalibration } from './brief';
import { readImportInstruction, type ImportInstruction } from './instructions';

/** Serializable continuation state, never a second copy of project geometry or source pixels.
 * Extraction recipes restore cached backend artifacts after a worker/container restart. */
export interface ImportCheckpoint {
  version: 1;
  projectId: string;
  brief?: ImportBrief;
  phase: 'inspect' | 'build' | 'review';
  notes: string;
  sourcePlan: string;
  calibration?: SourceCalibration;
  mutationKinds: string[];
  lastAssistantText: string;
  lastToolReport: string;
  analysis: {
    artifactId: string;
    sourceHash: string;
    request: Record<string, unknown>;
    calibration?: { input: Record<string, unknown>; revision: number };
  }[];
  decisions?: CandidateDecision[];
  steering?: ImportInstruction[];
}
export interface CandidateDecision {
  artifactId: string;
  transformId: string;
  floorId: string;
  candidateId: string;
  status: 'accepted' | 'rejected' | 'needs-review';
  modelIds: string[];
}

export function readImportCheckpoint(value: unknown): ImportCheckpoint | undefined {
  if (value === undefined) return;
  if (!value || typeof value !== 'object' || JSON.stringify(value).length > 96_000)
    throw new Error('Import checkpoint exceeds the supported size.');
  const c = value as ImportCheckpoint;
  if (c.steering && (!Array.isArray(c.steering) || c.steering.length > 20 || JSON.stringify(c.steering).length > 8000))
    throw new Error('Saved human instructions exceed the supported size.');
  c.steering?.forEach(readImportInstruction);
  const text = (v: unknown, max: number) => typeof v === 'string' && v.length <= max;
  if (
    c.version !== 1 ||
    !text(c.projectId, 200) ||
    !['inspect', 'build', 'review'].includes(c.phase) ||
    !text(c.notes, 3000) ||
    !text(c.sourcePlan, 8000) ||
    !text(c.lastAssistantText, 1200) ||
    !text(c.lastToolReport, 3000) ||
    !Array.isArray(c.mutationKinds) ||
    c.mutationKinds.length > 100 ||
    c.mutationKinds.some(k => !text(k, 100)) ||
    !Array.isArray(c.analysis) ||
    c.analysis.length > 8
  )
    throw new Error('Invalid import checkpoint.');
  for (const a of c.analysis) {
    if (
      !a ||
      !text(a.artifactId, 200) ||
      !/^[a-f0-9]{64}$/.test(a.sourceHash) ||
      !a.request ||
      typeof a.request !== 'object' ||
      Array.isArray(a.request) ||
      (a.calibration &&
        (!Number.isSafeInteger(a.calibration.revision) ||
          a.calibration.revision < 1 ||
          !a.calibration.input ||
          typeof a.calibration.input !== 'object'))
    )
      throw new Error('Invalid analysis checkpoint.');
  }
  if (
    c.calibration &&
    (!text(c.calibration.basis, 500) ||
      !Number.isFinite(c.calibration.metresPerUnit) ||
      c.calibration.metresPerUnit <= 0)
  )
    throw new Error('Invalid saved calibration.');
  if (
    c.decisions &&
    (!Array.isArray(c.decisions) ||
      JSON.stringify(c.decisions).length > 32_000 ||
      c.decisions.some(
        d =>
          !d ||
          ![d.artifactId, d.transformId, d.floorId, d.candidateId].every(s => text(s, 200)) ||
          !['accepted', 'rejected', 'needs-review'].includes(d.status) ||
          !Array.isArray(d.modelIds) ||
          d.modelIds.length > 500 ||
          d.modelIds.some(s => !text(s, 200)),
      ))
  )
    throw new Error('Invalid saved candidate decisions.');
  return { ...c, brief: readImportBrief(c.brief) };
}

export interface ImportBudget {
  inputTokens: number;
  outputTokens: number;
  /** Maximum provider turns in this run. Omitted by older hosts: 40. */
  maxTurns?: number;
}
export const DEFAULT_IMPORT_BUDGET: ImportBudget = { inputTokens: 200_000, outputTokens: 24_000, maxTurns: 40 };
export function readImportBudget(value: unknown): ImportBudget {
  if (value === undefined) return { ...DEFAULT_IMPORT_BUDGET };
  const b = value as ImportBudget;
  if (
    !b ||
    !Number.isSafeInteger(b.inputTokens) ||
    b.inputTokens < 10_000 ||
    b.inputTokens > 2_000_000 ||
    !Number.isSafeInteger(b.outputTokens) ||
    b.outputTokens < 1000 ||
    b.outputTokens > 100_000
  )
    throw new Error('Import budget must be 10,000–2,000,000 input and 1,000–100,000 output tokens.');
  const maxTurns = b.maxTurns ?? 40;
  if (!Number.isSafeInteger(maxTurns) || maxTurns < 1 || maxTurns > 100)
    throw new Error('Choose a turn limit between 1 and 100 per run. Continue can start another run.');
  return { inputTokens: b.inputTokens, outputTokens: b.outputTokens, maxTurns };
}
export interface ImportPause {
  reason: 'input-budget' | 'output-budget' | 'turn-limit' | 'refusals' | 'repeated-tools';
  message: string;
}
export function readImportPause(value: unknown): ImportPause | undefined {
  if (value === undefined) return;
  const p = value as ImportPause;
  if (
    !p ||
    !['input-budget', 'output-budget', 'turn-limit', 'refusals', 'repeated-tools'].includes(p.reason) ||
    typeof p.message !== 'string' ||
    p.message.length > 2000
  )
    throw new Error('Invalid import pause.');
  return { reason: p.reason, message: p.message };
}
