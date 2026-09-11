import { describe, expect, it } from 'vitest';
import { commitHistory, makeHistory, redoHistory, undoHistory } from './history';
import { newProject } from './testFixtures';

describe('undo / redo', () => {
  it('walks back and forward through committed states', () => {
    const base = newProject('First');
    let h = makeHistory(base);
    h = commitHistory(h, { ...base, name: 'Second' });
    h = commitHistory(h, { ...base, name: 'Third' });
    h = undoHistory(h);
    expect(h.present.name).toBe('Second');
    h = undoHistory(h);
    expect(h.present.name).toBe('First');
    expect(undoHistory(h).present.name).toBe('First');
    h = redoHistory(h);
    expect(h.present.name).toBe('Second');
  });
  it('clears the redo branch on a new commit', () => {
    const base = newProject('First');
    let h = commitHistory(makeHistory(base), { ...base, name: 'Second' });
    h = undoHistory(h);
    h = commitHistory(h, { ...base, name: 'Fork' });
    expect(h.future).toHaveLength(0);
    expect(redoHistory(h).present.name).toBe('Fork');
  });
});
