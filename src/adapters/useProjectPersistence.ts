import { useCallback, useEffect, useRef, useState } from 'react';
import type { ProjectDocument, ProjectRepository } from '../model/types';

/** Orders writes even when a future server repository responds slowly. */
export class ProjectWriter {
  private queue: Promise<void> = Promise.resolve();
  constructor(private readonly repository: ProjectRepository) {}
  save(project: ProjectDocument): Promise<void> {
    const snapshot = structuredClone(project);
    this.queue = this.queue.catch(() => {}).then(() => this.repository.save(snapshot));
    return this.queue;
  }
}

export function useProjectPersistence(
  project: ProjectDocument,
  repository: ProjectRepository,
  enabled: boolean,
  onError: (message: string) => void,
) {
  const writer = useRef(new ProjectWriter(repository));
  const latest = useRef(project),
    saved = useRef<ProjectDocument | null>(null),
    timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const mounted = useRef(true);
  latest.current = project;
  const [state, setState] = useState<'saving' | 'saved' | 'error'>('saved');
  const flush = useCallback(async () => {
    clearTimeout(timer.current);
    if (!enabled) return;
    // The debounce effect optimistically shows 'saving'; converge back to 'saved' even when the
    // snapshot turns out to be identical, so the indicator can never stick on "Saving changes…".
    if (saved.current === latest.current) {
      if (mounted.current) setState('saved');
      return;
    }
    const snapshot = latest.current;
    if (mounted.current) setState('saving');
    try {
      await writer.current.save(snapshot);
      saved.current = snapshot;
      if (mounted.current && latest.current === snapshot) setState('saved');
    } catch (error) {
      if (mounted.current) {
        setState('error');
        onError('Could not save to this browser. Your work is still open; export a backup before leaving.');
      }
      throw error;
    }
  }, [enabled, onError]);
  useEffect(() => {
    if (!enabled) return;
    setState('saving');
    timer.current = setTimeout(() => {
      void flush().catch(() => {});
    }, 450);
    return () => clearTimeout(timer.current);
  }, [project, enabled, flush]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      clearTimeout(timer.current);
      void flush().catch(() => {});
    };
  }, [flush]);
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (enabled && saved.current !== latest.current) e.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [enabled]);
  return { state, flush };
}
