import { expect, test } from '@playwright/test';

test('IndexedDB keeps legacy saves readable and stores the largest generated office sample', async ({ page }) => {
  await page.goto('/app.html');
  const result = await page.evaluate(async () => {
    const persistencePath = '/src/adapters/persistence.ts',
      factoryPath = '/src/model/factory.ts',
      demoPath = '/app/demo/backrooms.ts';
    const { LocalProjectRepository, IndexedProjectRepository } = await import(persistencePath);
    const { emptyProject } = await import(factoryPath);
    const { createBackrooms } = await import(demoPath);
    const previous = new LocalProjectRepository(),
      projects = new IndexedProjectRepository(previous);
    const old = emptyProject([0, 0], 'Legacy project');
    await previous.save(old);
    const legacyName = (await projects.load(old.id)).name;
    await projects.save({ ...old, name: 'Updated project' });
    const names = (await projects.list())
      .filter((p: { id: string }) => p.id === old.id)
      .map((p: { name: string }) => p.name);
    const large = createBackrooms({ size: 36, seed: 'large-save-test' });
    // A full localStorage must not prevent IndexedDB autosaves.
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = () => {
      throw new DOMException('Quota exceeded', 'QuotaExceededError');
    };
    try {
      await projects.save(large);
    } finally {
      Storage.prototype.setItem = setItem;
    }
    const loaded = await new IndexedProjectRepository(previous).load(large.id);
    await projects.delete(old.id);
    return {
      legacyName,
      names,
      deleted: await projects.load(old.id),
      legacyDeleted: await previous.load(old.id),
      rooms: loaded.objects.filter((o: { kind: string }) => o.kind === 'room').length,
      identical: JSON.stringify(loaded) === JSON.stringify(large),
    };
  });
  expect(result.legacyName).toBe('Legacy project');
  expect(result.names).toEqual(['Updated project']);
  expect(result.deleted).toBeNull();
  expect(result.legacyDeleted).toBeNull();
  expect(result.rooms).toBeGreaterThan(1500);
  expect(result.identical).toBe(true);
});
