import { expect, test } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { STOCKMANN_ID } from '../app/demo/ids';
import type { ProjectDocument } from '../src/model/types';

test.use({
  launchOptions:
    process.platform === 'darwin' ? { args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] } : {},
});

// Run against a production build for comparable startup measurements:
// KERROS_E2E_PRODUCTION=1 KERROS_PROFILE_STARTUP=1 npm run test:e2e -- tests/stockmann-loading.spec.ts
test('opens Stockmann and reuses its saved layout in both viewer hosts', async ({ page }, info) => {
  test.setTimeout(120_000);
  const errors: string[] = [],
    requested: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => requested.push(request.url()));
  await page.route('**/vectortiles/stylejson/**', route =>
    route.fulfill({
      json: {
        version: 8,
        sources: {},
        layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#e6e8e4' } }],
      },
    }),
  );
  await page.addInitScript(() => {
    (window as any).__loadTasks = [];
    new PerformanceObserver(list =>
      (window as any).__loadTasks.push(...list.getEntries().map(e => ({ start: e.startTime, duration: e.duration }))),
    ).observe({ type: 'longtask', buffered: true });
  });
  const cdp = process.env.KERROS_PROFILE_STARTUP ? await page.context().newCDPSession(page) : undefined;
  await cdp?.send('Profiler.enable');
  const timings: Record<string, unknown> = {};
  async function measure(label: string, open: () => Promise<unknown>) {
    await cdp?.send('Profiler.start');
    const start = await page.evaluate(() => performance.now());
    await open();
    await expect(page.locator('.map-wrap')).toHaveAttribute('data-frame', 'ready');
    // Include the 550 ms scene entrance animation. Production builds have no debug map globals.
    await Promise.all([
      expect(page.locator('.map-wrap')).toHaveAttribute('data-scene', 'ready'),
      page.waitForTimeout(650),
    ]);
    timings[label] = await page.evaluate(
      start => ({
        duration: performance.now() - start,
        tasks: (window as any).__loadTasks.filter((t: { start: number }) => t.start >= start),
      }),
      start,
    );
    if (cdp) {
      const { profile } = await cdp.send('Profiler.stop');
      await writeFile(info.outputPath(`${label}.cpuprofile`), JSON.stringify(profile));
    }
  }
  await page.goto('/app.html');
  await measure('fresh', () => page.getByRole('button', { name: /Stockmann Helsinki.*Open/ }).click());
  await expect(page.getByText('All changes saved', { exact: true })).toBeVisible();
  // Keep a visible user edit in the real browser store. A generated replacement must not win.
  const name = 'Stockmann Helsinki · saved layout';
  const counts = await page.evaluate(
    ({ id, name }) =>
      new Promise<number[]>((resolve, reject) => {
        const open = indexedDB.open('kerros-projects', 1);
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result,
            tx = db.transaction('projects', 'readwrite'),
            store = tx.objectStore('projects');
          let counts: number[];
          const read = store.get(id);
          read.onsuccess = () => {
            const p = read.result as ProjectDocument;
            counts = [p.floors.length, p.objects.length, p.navNodes!.length, p.navEdges!.length];
            p.name = name;
            store.put(p, id);
          };
          tx.oncomplete = () => {
            db.close();
            resolve(counts);
          };
          tx.onabort = tx.onerror = () => {
            db.close();
            reject(tx.error);
          };
        };
      }),
    { id: STOCKMANN_ID, name },
  );
  expect(counts).toEqual([17, 4695, 6962, 32182]);

  await page.goto('/app.html');
  requested.length = 0;
  // Click the built-in sample card, not the saved-project row: this used to regenerate the sample.
  await measure('savedCard', () => page.getByRole('button', { name: /Stockmann Helsinki.*Open/ }).click());
  await expect(page.locator('.app-shell').getByText(name, { exact: true }).first()).toBeVisible();
  expect(requested.filter(url => /\/app\/demo\/(?:demo|stockmann\w*)\.ts|\/assets\/demo-[^/]+\.js/.test(url))).toEqual(
    [],
  );
  await expect(page.getByText('All changes saved', { exact: true })).toBeVisible();

  await page.goto('/viewer.html');
  await measure('savedViewer', () => page.getByRole('button', { name, exact: false }).click());
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Active floor', exact: true })).toHaveAttribute(
    'data-value',
    'floor-08',
  );
  await page.screenshot({ path: info.outputPath('stockmann-viewer.png') });
  expect(errors).toEqual([]);
  await writeFile(info.outputPath('timings.json'), JSON.stringify(timings, null, 2));
  console.log(JSON.stringify(timings));
});
