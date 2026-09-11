import { beforeEach, describe, expect, it } from 'vitest';
import { LocalProjectRepository } from './persistence';
import { newProject } from '../model/testFixtures';

// node has no localStorage; a minimal Map-backed shim is enough for LocalProjectRepository.
function installLocalStorage() {
  const m = new Map<string, string>();
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    key: (i: number) => [...m.keys()][i] ?? null,
  } as Storage;
}

describe('LocalProjectRepository', () => {
  beforeEach(installLocalStorage);
  it('saves, lists (newest first), loads and deletes projects, ignoring foreign keys', async () => {
    const repo = new LocalProjectRepository();
    const a = { ...newProject('Alpha'), id: 'p-a', updatedAt: '2026-01-01T00:00:00.000Z' };
    const b = { ...newProject('Beta'), id: 'p-b', updatedAt: '2026-02-01T00:00:00.000Z' };
    await repo.save(a);
    await repo.save(b);
    localStorage.setItem('unrelated:key', 'x'); // must not appear in the listing
    const list = await repo.list();
    expect(list.map(s => s.id)).toEqual(['p-b', 'p-a']); // sorted by updatedAt desc
    expect((await repo.load('p-a'))?.name).toBe('Alpha');
    expect(await repo.load('missing')).toBeNull();
    await repo.delete('p-a');
    expect((await repo.list()).map(s => s.id)).toEqual(['p-b']);
  });
  it('excludes a corrupt stored record from the listing without throwing', async () => {
    const repo = new LocalProjectRepository();
    await repo.save({ ...newProject('Good'), id: 'p-good' });
    localStorage.setItem('kerros:project:p-bad', '{ not valid json');
    const list = await repo.list();
    expect(list.map(s => s.id)).toEqual(['p-good']);
  });
});
