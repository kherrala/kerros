import { expect, it, vi } from 'vitest';
import type { ProjectDocument, ProjectRepository } from '../../src/model/types';
import { newProject } from './blank';
import { migrateStockmann } from './migrate';

function fixture(id: string, updatedAt = '2026-10-01T00:00:00Z') {
  return { ...newProject(id), id, updatedAt };
}
function repository(...documents: ProjectDocument[]) {
  const saved = new Map(documents.map(p => [p.id, p]));
  const projects: ProjectRepository = {
    list: vi.fn(async () => [...saved.values()]),
    load: vi.fn(async id => saved.get(id) ?? null),
    save: vi.fn(async p => {
      saved.set(p.id, p);
    }),
    delete: vi.fn(async id => {
      saved.delete(id);
    }),
  };
  return { projects, saved };
}

it('migrates the latest edited Stockmann copy without changing its contents or unrelated saves', async () => {
  const latest = fixture('demo-campus-14', '2026-10-02T00:00:00Z');
  latest.name = 'My edited Stockmann';
  const custom = fixture('demo-campus-custom');
  const { projects, saved } = repository(fixture('demo-campus-15'), latest, custom);
  await Promise.all([migrateStockmann(projects), migrateStockmann(projects)]);
  expect(saved.get('stockmann')).toEqual({ ...latest, id: 'stockmann' });
  expect([...saved.keys()].sort()).toEqual(['demo-campus-custom', 'stockmann']);
  expect(saved.get(custom.id)).toBe(custom);
  expect(projects.save).toHaveBeenCalledTimes(1);
});

it('keeps an existing canonical Stockmann save', async () => {
  const canonical = fixture('stockmann');
  const { projects, saved } = repository(canonical, fixture('demo-campus-15', '2026-10-03T00:00:00Z'));
  await migrateStockmann(projects);
  expect(saved.get('stockmann')).toBe(canonical);
  expect(saved.size).toBe(1);
  expect(projects.save).not.toHaveBeenCalled();
});

it('retains the legacy copy when saving fails and allows retry', async () => {
  const previous = fixture('demo-campus-15');
  const { projects, saved } = repository(previous);
  vi.mocked(projects.save).mockRejectedValueOnce(new Error('Storage full'));
  await expect(migrateStockmann(projects)).rejects.toThrow('Storage full');
  expect(projects.delete).not.toHaveBeenCalled();
  expect(saved.get(previous.id)).toBe(previous);
  await migrateStockmann(projects);
  expect(saved.get('stockmann')).toEqual({ ...previous, id: 'stockmann' });
});

it('does nothing when there are no legacy Stockmann saves', async () => {
  const { projects } = repository(fixture('my-building'));
  await migrateStockmann(projects);
  expect(projects.load).not.toHaveBeenCalled();
  expect(projects.save).not.toHaveBeenCalled();
  expect(projects.delete).not.toHaveBeenCalled();
});
