import type { ProjectRepository } from '../../src/model/types';
import { currentDemoId, STOCKMANN_ID } from './ids';

const migrations = new WeakMap<ProjectRepository, Promise<void>>();

/** Rename old Stockmann saves before opening a sample or pruning obsolete demo IDs. */
export function migrateStockmann(projects: ProjectRepository): Promise<void> {
  let migration = migrations.get(projects);
  if (!migration) {
    migration = (async () => {
      const legacy = (await projects.list())
        .filter(p => p.id !== STOCKMANN_ID && currentDemoId(p.id) === STOCKMANN_ID)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
      if (!legacy.length) return;
      // An existing canonical save wins. Otherwise retain the most recently edited old copy,
      // including its floor/object IDs, timestamps and drawing references.
      let canonical = await projects.load(STOCKMANN_ID);
      if (!canonical) {
        for (const summary of legacy) {
          const previous = await projects.load(summary.id);
          if (!previous) continue;
          canonical = { ...previous, id: STOCKMANN_ID };
          await projects.save(canonical);
          break;
        }
      }
      // Never remove the source if reading or saving its replacement failed.
      if (canonical) for (const summary of legacy) await projects.delete(summary.id);
    })().catch(error => {
      migrations.delete(projects);
      throw error;
    });
    migrations.set(projects, migration);
  }
  return migration;
}
