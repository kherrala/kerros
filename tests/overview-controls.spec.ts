import { expect, test } from '@playwright/test';

test.use({
  launchOptions:
    process.platform === 'darwin' ? { args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] } : {},
});
test.beforeEach(async ({ page }) => {
  await page.route('**/vectortiles/stylejson/**', r =>
    r.fulfill({
      json: {
        version: 8,
        sources: {},
        layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#ddd' } }],
      },
    }),
  );
  await page.goto('/app.html');
  await page.getByRole('button', { name: 'Open offices', exact: true }).click();
  await expect(page.locator('.map-wrap')).toHaveAttribute('data-frame', 'ready');
});

test('WASD pans in 2D, respects typing and preserves active drawing tools', async ({ page }) => {
  await page.getByRole('button', { name: '2D', exact: true }).click();
  await page.waitForFunction(() => !(window as any).__kerrosMap.isMoving());
  const centre = () => page.evaluate(() => (window as any).__kerrosMap.getCenter().toArray() as number[]);
  const start = await centre();
  for (const [key, axis, sign] of [
    ['w', 1, 1],
    ['s', 1, -1],
    ['a', 0, -1],
    ['d', 0, 1],
  ] as const) {
    const before = await centre();
    await page.keyboard.press(key);
    await page.waitForTimeout(350);
    expect(((await centre())[axis] - before[axis]) * sign).toBeGreaterThan(0);
  }
  const end = await centre();
  expect(end[0]).toBeCloseTo(start[0], 5);
  expect(end[1]).toBeCloseTo(start[1], 5);
  await page.getByRole('button', { name: 'Show navigation panel' }).click();
  const input = page.getByRole('textbox', { name: 'To', exact: true });
  await input.pressSequentially('wasd');
  await expect(input).toHaveValue('wasd');
  expect(await centre()).toEqual(end);
  await page.getByRole('button', { name: 'Close navigation' }).click();
  await page.getByRole('button', { name: 'Plan editor', exact: true }).click();
  await page.getByRole('button', { name: 'Wall tool', exact: true }).click();
  const drawingCentre = await centre();
  await page.keyboard.press('w');
  await page.waitForTimeout(350);
  expect(await centre()).toEqual(drawingCentre);
  await page.getByRole('button', { name: 'Pan tool', exact: true }).click();
  await page.keyboard.press('a');
  await page.waitForTimeout(350);
  expect((await centre())[0]).not.toBe(drawingCentre[0]);
});

test('pool overview omits animated water and fixture passes, restoring them in POV', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.getByRole('button', { name: '3D', exact: true }).click();
  await page.getByRole('button', { name: 'Active floor' }).click();
  await page.locator('.place-option').filter({ hasText: 'The endless baths' }).click();
  await page.waitForFunction(() => {
    const l = (window as any).__kerrosMap.getLayer('kerros-3d')?.implementation;
    return l?.activeFloor === 'backrooms-pool-0' && !l.walking && l.diagnostics.drawCalls > 0;
  });
  const stats = () =>
    page.evaluate(() => {
      const l = (window as any).__kerrosMap.getLayer('kerros-3d').implementation;
      const materials: any[] = [];
      l.scene.traverse((o: any) => {
        if (o.userData.water) materials.push(o.material);
      });
      return {
        water: materials.length,
        detailed: materials.filter(m => m.transmission > 0).length,
        animated: l.diagnostics.animatedWater,
        fixtures: !!l.fixtureLights,
        calls: l.diagnostics.drawCalls,
      };
    });
  const overview = await stats();
  expect(overview.water).toBeGreaterThan(0);
  expect(overview.detailed).toBe(0);
  expect(overview.animated).toBe(false);
  expect(overview.fixtures).toBe(false);
  await page.waitForTimeout(1000);
  await page.screenshot({ path: info.outputPath('bath-overview.png') });
  await page.getByRole('button', { name: 'Walk', exact: true }).click();
  await expect.poll(async () => (await stats()).animated).toBe(true);
  const pov = await stats();
  expect(pov.detailed).toBe(pov.water);
  expect(pov.fixtures).toBe(true);
  await page.waitForTimeout(1000);
  await page.screenshot({ path: info.outputPath('bath-pov.png') });
  await page.getByRole('button', { name: '3D', exact: true }).click();
  await expect.poll(async () => (await stats()).animated).toBe(false);
  expect((await stats()).fixtures).toBe(false);
  expect(errors).toEqual([]);
});
