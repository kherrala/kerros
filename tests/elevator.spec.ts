import { expect, test } from '@playwright/test';

test.use({
  launchOptions:
    process.platform === 'darwin' ? { args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] } : {},
});

test('calls, boards, rides and exits the Backrooms elevator with cabin music', async ({ page }, info) => {
  test.setTimeout(100_000);
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
  await page.locator('.place-option').filter({ hasText: 'The endless baths' }).click();
  await page.evaluate(() => {
    const walk = (window as any).__kerrosWalk;
    walk.pitch = 85;
    walk.place([-3, 2.2], 180);
  });
  await page.getByRole('button', { name: 'Elevator controls' }).click();
  const panel = page.getByRole('complementary', { name: 'Elevator controls' });
  await expect(panel.getByRole('button', { name: 'Enter elevator', exact: true })).toBeDisabled();
  await page.keyboard.down('w');
  await page.waitForTimeout(550);
  await page.keyboard.up('w');
  expect(await page.evaluate(() => (window as any).__kerrosWalk.position[1])).toBeGreaterThan(1.4);
  await panel.getByRole('button', { name: 'Call to this floor' }).click();
  await expect(panel.getByRole('status')).toContainText('Travelling to The endless baths');
  await expect(page).toHaveURL(/f=backrooms-pool-0/);
  await expect(panel.getByRole('button', { name: 'Enter elevator', exact: true })).toBeEnabled({ timeout: 20_000 });
  await page.screenshot({ path: info.outputPath('elevator-arrival.png') });
  await panel.getByRole('button', { name: 'Enter elevator', exact: true }).click();
  await expect(panel.getByText('You are inside the elevator.')).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as any).__kerrosSound.playing?.key)).toBe('elevator@0.5');
  await panel.getByRole('button', { name: 'Look in mirror' }).click();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const scene = (window as any).__kerrosMap.getLayer('kerros-3d').implementation.scene;
        let frames = 0;
        scene.traverse((o: any) => {
          frames = Math.max(frames, o.userData.reflectionFrames ?? 0);
        });
        return frames;
      }),
    )
    .toBeGreaterThan(1);
  await page.waitForTimeout(1000);
  await page.screenshot({ path: info.outputPath('passenger-mirror.png') });
  await panel.getByRole('button', { name: 'Wave', exact: true }).click();
  await page.waitForTimeout(600);
  await page.screenshot({ path: info.outputPath('passenger-wave.png') });
  await page.getByRole('button', { name: 'Switch to dark mode' }).click();
  await page.screenshot({ path: info.outputPath('elevator-dark-mode.png') });
  const contrasts = await panel.evaluate(el => {
    const luminance = (color: string) => {
      const rgb = color
        .match(/[\d.]+/g)!
        .slice(0, 3)
        .map(v => {
          const c = Number(v) / 255;
          return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
        });
      return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
    };
    return [el, ...el.querySelectorAll('small, button:not(:disabled)')].map(node => {
      const style = getComputedStyle(node);
      const fg = luminance(style.color),
        bg = luminance(node.tagName === 'SMALL' ? getComputedStyle(el).backgroundColor : style.backgroundColor);
      return (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
    });
  });
  for (const contrast of contrasts) expect(contrast).toBeGreaterThanOrEqual(4.5);
  await panel.getByRole('button', { name: /Cabin music on/ }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__kerrosSound.isMuted)).toBe(true);
  await panel.getByRole('button', { name: /Cabin music muted/ }).click();
  await page.evaluate(() => {
    const w = (window as any).__kerrosWalk;
    w.place(w.position, 0);
  });
  await panel.getByRole('button', { name: 'B2 · Deep bath chambers' }).click();
  await expect(panel.getByRole('button', { name: 'Exit elevator', exact: true })).toBeDisabled();
  await expect(panel.getByRole('status')).toContainText('Travelling to Deep bath chambers');
  await page.screenshot({ path: info.outputPath('inside-elevator.png') });
  await expect
    .poll(() => page.evaluate(() => (window as any).__kerrosMap.transform.getCameraAltitude()))
    .toBeCloseTo(2.03, 2);
  await expect(page).toHaveURL(/f=backrooms-pool-1/, { timeout: 20_000 });
  await expect(panel.getByRole('button', { name: 'Exit elevator', exact: true })).toBeEnabled();
  await page.screenshot({ path: info.outputPath('elevator-destination.png') });
  await panel.getByRole('button', { name: 'Exit elevator', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__kerrosSound.playing?.key)).toBe('baths@0.55');
  await expect(panel.getByText('You are inside the elevator.')).not.toBeVisible();
  expect(errors).toEqual([]);
});
