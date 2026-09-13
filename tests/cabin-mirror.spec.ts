import { expect, test } from '@playwright/test';

test.use({
  launchOptions:
    process.platform === 'darwin' ? { args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] } : {},
});

test('the cabin mirror reflects the actual passenger and releases its render target', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => {
    if (m.type() === 'error' && /THREE|WebGL|shader/i.test(m.text())) errors.push(m.text());
  });
  await page.goto('/app.html');
  await page.getByRole('button', { name: 'Open offices', exact: true }).click();
  await expect(page.locator('.map-wrap')).toHaveAttribute('data-frame', 'ready');
  await page.getByRole('button', { name: 'Walk', exact: true }).click();
  await page.getByRole('button', { name: 'Active floor' }).click();
  await page.locator('.place-option').filter({ hasText: 'Deep bath chambers' }).click();
  await page.evaluate(() => {
    const w = (window as any).__kerrosWalk;
    w.pitch = 83;
    w.place([-3, 2.2], 180);
  });
  await page.getByRole('button', { name: 'Elevator controls' }).click();
  const panel = page.getByRole('complementary', { name: 'Elevator controls' });
  await panel.getByRole('button', { name: 'Call to this floor' }).click();
  await expect(panel.getByRole('button', { name: 'Enter elevator', exact: true })).toBeEnabled();
  await panel.getByRole('button', { name: 'Enter elevator', exact: true }).click();
  await panel.getByRole('button', { name: 'Close doors', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Open doors', exact: true })).toBeEnabled();
  await panel.getByRole('button', { name: 'Look in mirror' }).click();
  await page.waitForTimeout(1400);
  await page.screenshot({ path: info.outputPath('mirror-passenger.png') });
  const result = await page.evaluate(async () => {
    const map = (window as any).__kerrosMap,
      layer = map.getLayer('kerros-3d').implementation;
    const mirrors: any[] = [];
    layer.scene.traverse((o: any) => {
      if (o.userData.cabinMirror) mirrors.push(o);
    });
    const mirror = mirrors.find(m => (m.userData.reflectionFrames ?? 0) > 0),
      target = mirror.getRenderTarget();
    const frame = () =>
      new Promise<void>(resolve => {
        map.once('render', () => resolve());
        map.triggerRepaint();
      });
    const pixels = () => {
      const values = new Float32Array(target.width * target.height * 4);
      // Three's reflector target is half-float. Read raw words and compare, avoiding lossy PNG/tonemap thresholds.
      const words = new Uint16Array(values.length);
      layer.renderer.readRenderTargetPixels(target, 0, 0, target.width, target.height, words);
      return words;
    };
    const before = pixels();
    layer.passenger.visible = false;
    await frame();
    const without = pixels();
    layer.passenger.visible = true;
    await frame();
    let changed = 0;
    for (let i = 0; i < before.length; i += 4)
      if (before[i] !== without[i] || before[i + 1] !== without[i + 1] || before[i + 2] !== without[i + 2]) changed++;
    target.addEventListener('dispose', () => ((window as any).__mirrorDisposed = true));
    return {
      changed,
      projection: mirror.view.projectionMatrix.elements,
      camera: mirror.camera.matrixWorld.elements,
      plane: mirror.matrixWorld.elements,
      frames: mirror.userData.reflectionFrames,
    };
  });
  await info.attach('reflection-check', { body: JSON.stringify(result, null, 2), contentType: 'application/json' });
  expect(result.changed).toBeGreaterThan(1500);
  await panel.getByRole('button', { name: 'Wave', exact: true }).click();
  await page.waitForTimeout(600);
  await page.screenshot({ path: info.outputPath('mirror-wave.png') });
  await page.getByRole('button', { name: '2D', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__mirrorDisposed)).toBe(true);
  expect(errors).toEqual([]);
});
