import { expect, test } from '@playwright/test';
import { newProject } from '../src/model/testFixtures';
import { createObject } from '../src/model/factory';
import { rectangle } from '../src/model/geometry';
import { addNavNode, addNavEdge } from '../src/model/navigation';

test.use({
  launchOptions:
    process.platform === 'darwin' ? { args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] } : {},
});
test('Backrooms playback calls, boards and exits the elevator before walking the bath route', async ({
  page,
}, info) => {
  test.setTimeout(90000);
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('/app.html');
  await page.getByRole('button', { name: 'Open offices', exact: true }).click();
  await expect(page.locator('.map-wrap')).toHaveAttribute('data-frame', 'ready');
  await page.getByRole('button', { name: 'Walk', exact: true }).click();
  await page.waitForFunction(() => !!(window as any).__kerrosWalk);
  await page.evaluate(() => {
    const w = (window as any).__kerrosWalk;
    w.place([2, 0], 90);
  });
  await page.waitForTimeout(500);
  await page.getByRole('button', { name: 'Show navigation panel' }).click();
  await page.getByRole('textbox', { name: 'To', exact: true }).fill('Tall pool chamber 1');
  await page.locator('.place-option').filter({ hasText: 'The endless baths' }).first().click();
  await page.getByRole('button', { name: 'Play route', exact: true }).click();
  await expect(page.locator('.walk-status')).toContainText('Calling');
  await expect(page.getByRole('button', { name: 'Active floor' })).toContainText('Yellow offices');
  await expect(page.getByText('You are inside the elevator.', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).__kerrosWalk.position[1])).toBeLessThan(0.8);
  await page.screenshot({ path: info.outputPath('route-in-elevator.png') });
  await expect(page.getByRole('button', { name: 'Active floor' })).toContainText('The endless baths');
  await expect(page.getByText('You are inside the elevator.', { exact: true })).not.toBeVisible();
  await expect(page.getByRole('button', { name: 'Play route', exact: true })).toBeVisible({ timeout: 45000 });
  await expect(page.locator('.walk-status')).toContainText('Arrived');
  await page.screenshot({ path: info.outputPath('route-arrived-at-pool.png') });
  expect(errors).toEqual([]);
});

for (const model of ['straight', 'escalator'] as const)
  test(`POV route physically traverses ${model} steps`, async ({ page }, info) => {
    test.setTimeout(60000);
    const project = newProject(`Route via ${model}`);
    project.floors.push({ ...project.floors[0], id: 'upper', elevation: 3.2 });
    for (const f of project.floors) {
      const room = createObject('room', [0, 0], f.id, 'Hall');
      Object.assign(room, { rings: [rectangle([0, 0], 24, 24)], width: 24, depth: 24 });
      project.objects.push(room);
    }
    const stair = createObject(
      'stairs',
      [0, 0],
      'floor-ground',
      model === 'escalator' ? 'Up escalator' : 'Main stairs',
    );
    Object.assign(stair, {
      stairModel: model,
      width: 4,
      depth: 9,
      travel: 'up',
      servedFloorIds: ['floor-ground', 'upper'],
    });
    project.objects.push(stair);
    const goal = createObject('poi', [0, 8], 'upper', 'Journey destination');
    project.objects.push(goal);
    const start = addNavNode(project, 'floor-ground', [0, -8]);
    const lower = addNavNode(project, 'floor-ground', [0, 0], stair.id),
      upper = addNavNode(project, 'upper', [0, 0], stair.id);
    const end = addNavNode(project, 'upper', [0, 8], goal.id);
    addNavEdge(project, 'walk', start, lower);
    addNavEdge(project, 'stairs', lower, upper, stair.id);
    addNavEdge(project, 'walk', upper, end);
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
    await page.evaluate(p => localStorage.setItem(`kerros:project:${p.id}`, JSON.stringify(p)), project);
    await page.goto(`/app.html#p=${project.id}&f=floor-ground`);
    await page.reload();
    await expect(page.locator('.map-wrap')).toHaveAttribute('data-frame', 'ready');
    await page.getByRole('button', { name: 'Walk', exact: true }).click();
    await page.evaluate(() => {
      const w = (window as any).__kerrosWalk;
      w.place([0, -8], 0);
    });
    await page.waitForTimeout(500);
    await page.getByRole('button', { name: 'Show navigation panel' }).click();
    await page.getByRole('textbox', { name: 'To', exact: true }).fill('Journey destination');
    await page.locator('.place-option').filter({ hasText: 'Journey destination' }).click();
    await page.getByRole('button', { name: 'Play route', exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as any).__kerrosWalk.stairs.height)).toBeGreaterThan(0.5);
    expect(await page.evaluate(() => (window as any).__kerrosWalk.stairs.height)).toBeLessThan(3.2);
    await page.screenshot({ path: info.outputPath(`${model}-mid-flight.png`) });
    await expect(page.getByRole('button', { name: 'Play route', exact: true })).toBeVisible({ timeout: 40000 });
    await expect(page.locator('.walk-status')).toContainText('Arrived');
    expect(await page.evaluate(() => (window as any).__kerrosWalk.terrain.floorId)).toBe('upper');
  });
