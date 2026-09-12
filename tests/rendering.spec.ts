import { expect, test } from '@playwright/test';

test.use({
  launchOptions:
    process.platform === 'darwin' ? { args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] } : {},
});

test('architectural materials render through daylight, dusk, and cutaway views', async ({ page }, testInfo) => {
  test.setTimeout(120_000);
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
  const floor = async (name: string) => {
    await page.getByRole('button', { name: 'Active floor' }).click();
    await page.locator('.place-option').filter({ hasText: name }).first().click();
  };
  const settled = async () => {
    await page.waitForFunction(() => {
      const map = (
        window as unknown as {
          __kerrosMap?: {
            isMoving(): boolean;
            getLayer(id: string): { implementation: { diagnostics?: { drawCalls: number } } };
          };
        }
      ).__kerrosMap;
      return map && !map.isMoving() && (map.getLayer('kerros-3d')?.implementation.diagnostics?.drawCalls ?? 0) > 0;
    });
    await page.waitForTimeout(800); // Complete the building entrance and lighting transitions.
  };
  await floor('Outdoor site');
  await settled();
  await page.screenshot({ path: testInfo.outputPath('daylight.png') });
  const calls = await page.evaluate(
    () =>
      (
        window as unknown as {
          __kerrosMap: { getLayer(id: string): { implementation: { diagnostics: { drawCalls: number } } } };
        }
      ).__kerrosMap.getLayer('kerros-3d').implementation.diagnostics.drawCalls,
  );
  expect(calls).toBeLessThan(180); // Roof seams and repeated furniture must stay batched.
  await page.getByRole('button', { name: 'Map settings', exact: true }).click();
  // Sunlight is a three-way choice now (Auto follows the site's own clock), not a toggle: pin it to
  // Dusk so the shot is of dusk rather than of whatever hour the suite happens to run at.
  await page.getByRole('radio', { name: 'Dusk', exact: true }).click();
  await page.getByRole('button', { name: 'Close map settings' }).click();
  await settled();
  await page.screenshot({ path: testInfo.outputPath('evening.png') });
  await floor('Offices · management');
  await settled();
  await page.screenshot({ path: testInfo.outputPath('cutaway.png') });
  expect(errors).toEqual([]);
});
