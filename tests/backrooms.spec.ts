import { expect, test } from '@playwright/test';

test.use({
  launchOptions:
    process.platform === 'darwin' ? { args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] } : {},
});

test('generates, renders, walks, and restores the office sample', async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => {
    if (/Context Lost/i.test(m.text()) || (m.type() === 'error' && /THREE|WebGL|shader|geometry/i.test(m.text())))
      errors.push(m.text());
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
  const preview = page.getByRole('img', { name: /Generated office plan/ });
  const original = await preview.getAttribute('aria-label');
  await page.getByRole('textbox', { name: 'Office layout seed' }).fill('playwright-offices');
  await expect(preview).not.toHaveAttribute('aria-label', original!);
  await page.screenshot({ path: testInfo.outputPath('office-generator.png') });
  await page.getByRole('button', { name: 'Open offices', exact: true }).click();
  await expect(page.locator('.map-wrap')).toHaveAttribute('data-frame', 'ready');
  await page.waitForFunction(() => {
    const map = (window as any).__kerrosMap;
    return map && !map.isMoving() && (map.getLayer('kerros-3d')?.implementation.diagnostics?.drawCalls ?? 0) > 0;
  });
  await page.waitForTimeout(800);
  const calls = await page.evaluate(
    () => (window as any).__kerrosMap.getLayer('kerros-3d').implementation.diagnostics.drawCalls,
  );
  expect(calls).toBeLessThan(100);
  await page.screenshot({ path: testInfo.outputPath('office-cutaway.png') });
  await page.getByRole('button', { name: '2D', exact: true }).click();
  await expect(page).toHaveURL(/v=2d/);
  await page.waitForTimeout(800);
  const order = await page.evaluate(
    () => (window as any).__kerrosMap.getStyle().layers.map((l: { id: string }) => l.id) as string[],
  );
  expect(order.indexOf('kerros-underground')).toBeLessThan(order.indexOf('kerros-areas'));
  expect(order.indexOf('kerros-dim')).toBeLessThan(order.indexOf('kerros-areas'));
  await page.screenshot({ path: testInfo.outputPath('office-2d.png') });
  await page.getByRole('button', { name: '3D', exact: true }).click();
  const revision = await page.evaluate(
    () => (window as any).__kerrosMap.getLayer('kerros-3d').implementation.diagnostics.revision,
  );
  await page.getByRole('button', { name: /^Walk/ }).click();
  await expect(page).toHaveURL(/v=walk/);
  await page.waitForFunction(
    previous => (window as any).__kerrosMap.getLayer('kerros-3d').implementation.diagnostics.revision > previous,
    revision,
  );
  await page.waitForTimeout(800);
  await expect(page.locator('.space-label')).toHaveCount(0);
  await expect(page.locator('.mini-marker[data-kind="room"], .mini-marker[data-kind="zone"]')).toHaveCount(0);
  const lamps = await page.evaluate(() => {
    const layer = (window as any).__kerrosMap.getLayer('kerros-3d').implementation;
    return {
      active: layer.scene.children.filter((o: any) => o.isPointLight && o.intensity > 0).length,
      panels: layer.scene.children.filter((o: any) => o.isInstancedMesh).map((o: any) => o.count),
    };
  });
  expect(lamps.active).toBeGreaterThan(0);
  expect(lamps.active).toBeLessThanOrEqual(4);
  expect(lamps.panels).toContain(28 * 28);
  await page.screenshot({ path: testInfo.outputPath('office-walk.png') });
  await expect(page.getByText('All changes saved', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.locator('.map-wrap')).toHaveAttribute('data-frame', 'ready');
  await expect(page).toHaveURL(/v=walk/);
  await page.getByRole('link', { name: 'kerros Spaces' }).click();
  await expect(page.getByRole('button', { name: 'Open offices', exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});
