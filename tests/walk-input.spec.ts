import { expect, test } from '@playwright/test';
import { addSpace, newProject } from '../src/model/testFixtures';

test.use({
  launchOptions:
    process.platform === 'darwin' ? { args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] } : {},
});

for (const host of ['app', 'viewer']) {
  test(`${host} Walk uses drag-to-look without locking the cursor`, async ({ page }) => {
    const project = newProject('Walk input');
    addSpace(project, 'Room', 'floor-ground', [0, 0]);
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/vectortiles/stylejson/**', route =>
      route.fulfill({ json: { version: 8, sources: {}, layers: [] } }),
    );
    await page.addInitScript(p => {
      localStorage.setItem(`kerros:project:${p.id}`, JSON.stringify(p));
      (window as any).__lockRequests = 0;
      Element.prototype.requestPointerLock = () => {
        (window as any).__lockRequests++;
        return Promise.resolve();
      };
    }, project);
    await page.goto(`/${host}.html`);
    await page.getByRole('button', { name: /^Walk input/ }).click();
    await expect(page.locator('.map-wrap')).toHaveAttribute('data-frame', 'ready');
    await page.getByRole('button', { name: 'Walk', exact: true }).click();
    await page.waitForFunction(() => !!(window as any).__kerrosWalk);
    await expect(page.getByText('Drag to look around', { exact: true })).toBeVisible();
    const pose = () => page.evaluate(() => (window as any).__kerrosWalk.pose);
    const canvas = page.getByTestId('map-canvas');
    const box = (await canvas.boundingBox())!;
    const x = box.x + box.width / 2,
      y = box.y + box.height / 2;
    const before = await pose();
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 100, y + 40, { steps: 6 });
    const dragging = await pose();
    expect(dragging.looking).toBe(true);
    expect(dragging.heading).not.toBeCloseTo(before.heading, 3);
    expect(dragging.pitch).toBeLessThan(before.pitch);
    expect(dragging.position).toEqual(before.position);
    await page.mouse.up();
    const released = await pose();
    expect(released.looking).toBe(false);
    await page.mouse.move(x - 80, y - 60, { steps: 4 });
    expect(await pose()).toEqual(released);

    // Controls can be operated immediately, with no Escape or unlock prompt in between.
    await page.getByRole('slider', { name: 'POV field of view' }).fill('110');
    await expect(page.getByRole('slider', { name: 'POV field of view' })).toHaveValue('110');
    await page.mouse.click(x, y);
    await page.keyboard.down('w');
    await expect.poll(async () => (await pose()).position).not.toEqual(released.position);
    await page.keyboard.up('w');

    // Losing focus must not leave the camera following the next unpressed mouse movement.
    await page.mouse.down();
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    expect((await pose()).looking).toBe(false);
    await page.mouse.up();
    expect(await page.evaluate(() => (window as any).__lockRequests)).toBe(0);
    expect(await page.evaluate(() => document.pointerLockElement === null)).toBe(true);
    await page.keyboard.press('Escape');
    await expect(page.locator('.walk-hud')).toHaveCount(0);
    expect(errors).toEqual([]);
  });
}
