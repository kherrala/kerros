import { expect, test } from '@playwright/test';

test.use({
  launchOptions:
    process.platform === 'darwin' ? { args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] } : {},
});

test('the varied Stockmann fit-out renders in plan and in the building viewer', async ({ page }, info) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
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
  await page.getByRole('button', { name: '2D', exact: true }).click();
  for (const [label, file] of [
    ['Beauty & cosmetics', 'ground'],
    ['Books, toys & café', 'books'],
    ['Offices · marketing', 'office'],
    ['Accessories & café', 'mezzanine'],
    ['Parking P1', 'garage'],
  ]) {
    await page.getByRole('button', { name: 'Active floor' }).click();
    await page.locator('.place-option').filter({ hasText: label }).first().click();
    await page.waitForFunction(() => !(window as any).__kerrosMap?.isMoving());
    await page.waitForTimeout(500); // Let floor transitions and labels settle before the review image.
    await page.screenshot({ path: info.outputPath(`${file}-plan.png`) });
  }
  await page.getByRole('button', { name: 'Active floor' }).click();
  await page.locator('.place-option').filter({ hasText: 'Offices · marketing' }).first().click();
  await page.getByRole('button', { name: '3D', exact: true }).click();
  await page.waitForFunction(() => {
    const map = (window as any).__kerrosMap;
    return map && !map.isMoving() && map.getLayer('kerros-3d')?.implementation.diagnostics?.drawCalls > 0;
  });
  await page.waitForTimeout(700);
  await page.screenshot({ path: info.outputPath('office-3d.png') });
  expect(errors).toEqual([]);
});
