import { expect, test } from '@playwright/test';
import { newProject } from '../src/model/testFixtures';
import { addBarrier, rectangle } from '../src/model/geometry';
import { createObject } from '../src/model/factory';
import { transact } from '../src/model/validate';

test.use({
  launchOptions:
    process.platform === 'darwin' ? { args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] } : {},
});

test('door types edit, persist and render as distinct framed mechanisms', async ({ page }, info) => {
  const p = newProject('Door mechanisms');
  const wall = addBarrier(p, [-7, 0], [7, 0], 'floor-ground', 'wall')!;
  const hall = createObject('room', [0, -3], 'floor-ground', 'Door gallery');
  Object.assign(hall, { rings: [rectangle([0, -3], 18, 16)], material: 'terrazzo' });
  p.objects.push(hall);
  for (const [i, type] of (['hinged', 'sliding', 'double'] as const).entries()) {
    const door = createObject('door', [-4 + i * 4, 0], 'floor-ground', `${type} sample`);
    Object.assign(door, {
      barrierId: wall.id,
      offset: 3 + i * 4,
      doorType: type,
      doorSwing: -1,
      width: type === 'double' ? 1.8 : 1.1,
    });
    p.objects.push(door);
  }
  const valid = transact(p, () => {});
  if (!valid.ok) throw new Error(valid.error);
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/vectortiles/stylejson/**', route =>
    route.fulfill({
      json: {
        version: 8,
        sources: {},
        layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#ecece5' } }],
      },
    }),
  );
  await page.goto('/app.html');
  await page.evaluate(p => localStorage.setItem(`kerros:project:${p.id}`, JSON.stringify(p)), valid.project);
  await page.goto(`/app.html#p=${p.id}&f=floor-ground`);
  await page.reload();
  await expect(page.locator('.map-wrap')).toHaveAttribute('data-frame', 'ready');
  await page.getByRole('button', { name: 'Plan editor', exact: true }).click();
  await page.getByRole('button', { name: '2D', exact: true }).click();
  // Choose the door from the object list, preserving a normal authoring interaction.
  await page
    .getByRole('button', { name: /^Objects/ })
    .first()
    .click();
  await page.locator('.sidebar .object-row').filter({ hasText: 'hinged sample' }).click();
  await page.getByRole('combobox', { name: 'Door type' }).selectOption('sliding');
  await expect(page.getByRole('combobox', { name: 'Slide direction' })).toBeVisible();
  await page.getByRole('combobox', { name: 'Slide direction' }).selectOption('right');
  await page.getByRole('combobox', { name: 'Door type' }).selectOption('double');
  await expect(page.getByRole('combobox', { name: 'Door hinge' })).toBeDisabled();
  await page.getByRole('combobox', { name: 'Door type' }).selectOption('hinged');
  await page.waitForTimeout(650);
  await expect(page.locator('.save-status')).toContainText('All changes saved');
  await page.reload();
  await expect(page.locator('.map-wrap')).toHaveAttribute('data-frame', 'ready');
  await page.getByRole('button', { name: 'Plan editor', exact: true }).click();
  await page
    .getByRole('button', { name: /^Objects/ })
    .first()
    .click();
  await page.locator('.sidebar .object-row').filter({ hasText: 'hinged sample' }).click();
  await expect(page.getByRole('combobox', { name: 'Door hinge' })).toHaveValue('right');
  await expect(page.getByRole('combobox', { name: 'Door type' })).toHaveValue('hinged');
  await page.getByRole('button', { name: 'Plan viewer', exact: true }).click();
  await page.getByRole('button', { name: 'Walk', exact: true }).click();
  await page.evaluate(() => {
    const w = (window as any).__kerrosWalk;
    w.pitch = 86;
    w.place([0, -6], 0);
  });
  await page.waitForTimeout(600);
  const types = await page.evaluate(() => {
    const l = (window as any).__kerrosMap.getLayer('kerros-3d').implementation;
    const types: string[] = [];
    l.scene.traverse((o: any) => {
      if (o.userData.doorType) types.push(o.userData.doorType);
    });
    return types;
  });
  expect(types.sort()).toEqual(['double', 'double', 'hinged', 'sliding']);
  await page.screenshot({ path: info.outputPath('door-mechanisms.png') });
  expect(errors).toEqual([]);
});
