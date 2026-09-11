import type { ProjectDocument } from './types';
export interface History {
  past: ProjectDocument[];
  present: ProjectDocument;
  future: ProjectDocument[];
}
export const makeHistory = (project: ProjectDocument): History => ({ past: [], present: project, future: [] });
export function commitHistory(history: History, project: ProjectDocument): History {
  return {
    past: [...history.past.slice(-99), history.present],
    present: { ...project, updatedAt: new Date().toISOString() },
    future: [],
  };
}
export function undoHistory(history: History): History {
  if (!history.past.length) return history;
  return {
    past: history.past.slice(0, -1),
    present: { ...history.past.at(-1)!, updatedAt: new Date().toISOString() },
    future: [history.present, ...history.future],
  };
}
export function redoHistory(history: History): History {
  if (!history.future.length) return history;
  return {
    past: [...history.past, history.present],
    present: { ...history.future[0], updatedAt: new Date().toISOString() },
    future: history.future.slice(1),
  };
}
