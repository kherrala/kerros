import type { AssetRepository } from '../model/types';
import {
  readImportCheckpoint,
  readImportPause,
  readImportBudget,
  type ImportCheckpoint,
  type ImportBudget,
  type ImportPause,
} from './checkpoint';
import { readTokenUsage, type AiTokenUsage } from './usage';
import { mergeImportInstructions } from './instructions';

export interface AiImportSession {
  version: 1;
  projectId: string;
  sourceId: string;
  sourceName: string;
  sourceType: string;
  instructions: string;
  brief?: import('./brief').ImportBrief;
  followUp: string;
  tab?: 'setup' | 'analysis' | 'activity' | 'usage';
  pendingInstructions?: import('./instructions').ImportInstruction[];
  checkpoint?: ImportCheckpoint;
  budget?: ImportBudget;
  pause?: ImportPause;
  messages: { type: 'text' | 'tool' | 'user'; detail: string; instructionId?: string }[];
  phase: 'running' | 'done' | 'paused' | 'failed';
  activity: string;
  edits: number;
  usage: AiTokenUsage;
  hasUsage: boolean;
  error: string;
}

const key = (projectId: string) => `ai-import:${projectId}:session`;

/** Import state belongs to the host's asset store, alongside the original drawing. It is not
 * another plan: all geometry lives in the normal project repository. */
export async function loadAiImportSession(assets: AssetRepository, projectId: string): Promise<AiImportSession | null> {
  const blob = await assets.get(key(projectId));
  if (!blob) return null;
  const value = JSON.parse(await blob.text()) as AiImportSession;
  if (value.version !== 1 || value.projectId !== projectId || !value.sourceId || !Array.isArray(value.messages))
    throw new Error('The saved import session could not be read.');
  if (value.tab && !['setup', 'analysis', 'activity', 'usage'].includes(value.tab)) value.tab = undefined;
  value.usage = readTokenUsage(value.usage);
  value.checkpoint = readImportCheckpoint(value.checkpoint);
  const received = new Set(value.checkpoint?.steering?.map(m => m.id));
  value.pendingInstructions = mergeImportInstructions(value.pendingInstructions ?? []).filter(m => !received.has(m.id));
  value.budget = readImportBudget(value.budget);
  value.pause = readImportPause(value.pause);
  // A reload disconnects/cancels the backend request. Resuming is an explicit paid action.
  return { ...value, phase: value.phase === 'running' ? 'paused' : value.phase };
}

export async function saveAiImportSession(assets: AssetRepository, session: AiImportSession): Promise<void> {
  await assets.put(key(session.projectId), new Blob([JSON.stringify(session)], { type: 'application/json' }));
}
