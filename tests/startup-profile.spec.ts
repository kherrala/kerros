import { test, expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';

test.use({
  launchOptions:
    process.platform === 'darwin' ? { args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] } : {},
});

test('profile Backrooms startup and reopen without generating unrelated samples', async ({ page }, info) => {
  const requested: string[] = [];
  page.on('request', request => requested.push(request.url()));
  await page.goto('/app.html');
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.start');
  const start = Date.now();
  await page.getByRole('button', { name: 'Open offices', exact: true }).click();
  await expect(page.locator('.map-wrap')).toHaveAttribute('data-frame', 'ready');
  await page.waitForFunction(
    () => ((window as any).__kerrosMap?.getLayer('kerros-3d')?.implementation.diagnostics.drawCalls ?? 0) > 0,
  );
  const elapsed = Date.now() - start;
  const { profile } = await cdp.send('Profiler.stop');
  await writeFile(info.outputPath('startup.cpuprofile'), JSON.stringify(profile));
  const times = new Map<number, number>();
  for (let i = 0; i < (profile.samples?.length ?? 0); i++)
    times.set(profile.samples![i], (times.get(profile.samples![i]) ?? 0) + profile.timeDeltas![i]);
  console.log(
    JSON.stringify(
      {
        elapsed,
        top: profile.nodes
          .map(n => ({
            ms: Math.round((times.get(n.id) ?? 0) / 1000),
            name: n.callFrame.functionName,
            url: n.callFrame.url.split('/').at(-1),
            line: n.callFrame.lineNumber,
          }))
          .sort((a, b) => b.ms - a.ms)
          .slice(0, 12),
      },
      null,
      2,
    ),
  );
  await expect(page.getByText('All changes saved', { exact: true })).toBeVisible();
  requested.length = 0;
  const reload = Date.now();
  await page.reload();
  await expect(page.locator('.map-wrap')).toHaveAttribute('data-frame', 'ready');
  await page.waitForFunction(
    () => ((window as any).__kerrosMap?.getLayer('kerros-3d')?.implementation.diagnostics.drawCalls ?? 0) > 0,
  );
  expect(requested.filter(url => /\/app\/demo\/(?:demo|silo|backrooms)\.ts/.test(url))).toEqual([]);
  await info.attach('startup-times', {
    body: JSON.stringify({ openMs: elapsed, savedReloadMs: Date.now() - reload }),
    contentType: 'application/json',
  });
});
