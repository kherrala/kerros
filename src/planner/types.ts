import type { ProjectDocument } from '../model/types';

/** The single validated, undoable mutation path shared by planner features. */
export type CommitProject = (change: (draft: ProjectDocument) => void) => boolean;
