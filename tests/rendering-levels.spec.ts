import { expect, test } from '@playwright/test';

test.use({
  launchOptions:
    process.platform === 'darwin' ? { args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] } : {},
});

test('underground and entresol floors render in cutaway and Walk', async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', message => {
    if (message.type() === 'error' && /THREE|WebGL|shader|geometry/i.test(message.text())) errors.push(message.text());
  });
  await page.route('**/vectortiles/stylejson/**', route =>
    route.fulfill({
      json: {
        version: 8,
        sources: {},
        layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#e6e8e4' } }],
      },
    }),
  );
  await page.goto('/app.html');
  await page.getByRole('button', { name: /Stockmann Helsinki.*Open/ }).click();
  await expect(page.locator('.map-wrap')).toHaveAttribute('data-frame', 'ready');
  await page.getByRole('button', { name: '3D', exact: true }).click();
  for (const [label, name] of [
    ['entresol', 'Accessories & café'],
    ['ground', 'Cosmetics'],
    ['herkku', 'Herkku food'],
    ['p1', 'P1'],
    ['p2', 'P2'],
  ]) {
    await page.getByRole('button', { name: 'Active floor' }).click();
    await page.locator('.place-option').filter({ hasText: name }).first().click();
    await page.waitForFunction(() => {
      const map = (
        window as unknown as {
          __kerrosMap: {
            isMoving(): boolean;
            getLayer(id: string): { implementation: { diagnostics?: { drawCalls: number } } };
          };
        }
      ).__kerrosMap;
      return map && !map.isMoving() && (map.getLayer('kerros-3d')?.implementation.diagnostics?.drawCalls ?? 0) > 0;
    });
    await page.waitForTimeout(800);
    await page.screenshot({ path: testInfo.outputPath(`${label}-cutaway.png`) });
    if (['entresol', 'herkku', 'p1'].includes(label)) {
      await page.getByRole('button', { name: 'Walk', exact: true }).click();
      await expect(page.getByRole('slider', { name: 'POV field of view' })).toHaveValue('100');
      await page.waitForTimeout(800);
      await page.screenshot({ path: testInfo.outputPath(`${label}-walk.png`) });
      await page.getByRole('button', { name: '3D', exact: true }).click();
    }
  }
  expect(errors).toEqual([]);
});
