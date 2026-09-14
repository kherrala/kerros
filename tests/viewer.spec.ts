import { expect, test } from '@playwright/test';
import { createDemo } from '../app/demo/demo';
import { createBackrooms } from '../app/demo/backrooms';
import { addFloor, addSpace, newProject } from '../src/model/testFixtures';
import { connectSpace } from '../src/model/boundaries';
import { validateProject } from '../src/model/validate';

test.use({
  launchOptions:
    process.platform === 'darwin' ? { args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] } : {},
});

test.beforeEach(async ({ page }) => {
  await page.route('**/vectortiles/stylejson/**', route =>
    route.fulfill({
      json: {
        version: 8,
        sources: {},
        layers: [{ id: 'test-background', type: 'background', paint: { 'background-color': '#e6e8e4' } }],
      },
    }),
  );
});

test('the viewer opens a browser-saved project, switches floors and enters 3D without runtime errors', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  // The viewer picker only lists browser-persisted projects, so seed the demo the way the editor saves it.
  await page.addInitScript(p => localStorage.setItem(`kerros:project:${p.id}`, JSON.stringify(p)), createDemo());
  await page.goto('/viewer.html');
  await page.getByRole('button', { name: /Stockmann Helsinki/ }).click();
  await expect(page.locator('.map-loading')).toHaveCount(0);
  await expect(page.locator('.map-wrap')).toHaveAttribute('data-frame', 'ready');
  // Scoped to the sidebar because zone overlays on the map expose buttons with the same names.
  const floor = (name: RegExp) => page.locator('.sidebar').getByRole('button', { name });
  await expect(floor(/Herkku food market/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Active floor', exact: true })).toHaveAttribute(
    'data-value',
    'floor-08',
  );
  await floor(/Herkku food market/).click();
  await expect(floor(/Herkku food market/)).toHaveClass(/active/);
  await page.getByRole('button', { name: '3D', exact: true }).click();
  await expect(page.locator('.map-wrap')).toHaveClass(/perspective/);
  await expect(page.getByTestId('map-canvas')).toBeVisible();
  expect(errors).toEqual([]);
});

test('viewer library browses structure, balances the graph and plays a derived route without editing the plan', async ({
  page,
}, info) => {
  const p = newProject('Read-only connected rooms');
  addSpace(p, 'Lobby', 'floor-ground', [-2, 0]);
  addSpace(p, 'Closet', 'floor-ground', [2, 0]);
  for (const room of p.objects) connectSpace(p, room.id);
  addFloor(p, 'upper', 3);
  addSpace(p, 'Upper room', 'upper', [0, 0]);
  validateProject(p);
  const errors: string[] = [];
  const editorRequests: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    if (/SitePlanner|ImportDialog|AiImportPanel/.test(request.url())) editorRequests.push(request.url());
  });
  await page.addInitScript(project => localStorage.setItem(`kerros:project:${project.id}`, JSON.stringify(project)), p);
  await page.goto('/viewer.html');
  await page.getByRole('button', { name: p.name, exact: false }).click();
  await expect(page.locator('.map-wrap')).toHaveAttribute('data-frame', 'ready');
  await page.getByRole('button', { name: '2D', exact: true }).click();
  await page.getByLabel('View options', { exact: true }).click();
  await page.getByRole('checkbox', { name: 'Object labels', exact: true }).uncheck();
  await page.getByRole('checkbox', { name: 'Object labels', exact: true }).check();
  await page.getByLabel('View options', { exact: true }).click();
  await page.getByRole('button', { name: 'Show structure panel' }).click();
  const structure = page.locator('.structure-panel');
  // A document without authored zones or portals still exposes its complete structure.
  await expect(structure.getByRole('tab', { name: 'Spaces', exact: true })).toBeVisible();
  await structure.getByRole('tab', { name: 'Portals', exact: true }).click();
  await expect(structure.locator('.structure-record')).toHaveCount(1);
  await structure.getByRole('tab', { name: 'Zones', exact: true }).click();
  await expect(structure.getByRole('button', { name: /New zone|Re-read portals/ })).toHaveCount(0);
  await structure.getByRole('tab', { name: 'Topology', exact: true }).click();
  await structure.getByRole('button', { name: 'Open graph view' }).click();
  const graph = page.getByRole('region', { name: 'Navigation graph view' });
  await expect(graph.getByRole('img', { name: /Navigation graph with/ })).toHaveAttribute(
    'aria-label',
    'Navigation graph with 3 nodes and 1 edges',
  );
  await expect(page.getByTestId('map-canvas')).toHaveCount(0);
  await graph.getByLabel('Search graph nodes').fill('Upper room');
  await graph.getByLabel('Graph node', { exact: true }).selectOption('space:Upper room');
  await graph.getByRole('button', { name: 'Find node on map' }).click();
  await expect(page.getByRole('button', { name: 'Active floor', exact: true })).toHaveAttribute('data-value', 'upper');
  await expect(page.getByTestId('map-canvas')).toBeVisible();
  await page.getByRole('button', { name: 'Show properties panel' }).click();
  await expect(page.locator('.inspector')).toContainText('Upper room');
  await expect(page.locator('.inspector').getByRole('button', { name: /Delete|Duplicate/ })).toHaveCount(0);
  await page.getByRole('button', { name: 'Show structure panel' }).click();
  await structure.getByRole('tab', { name: 'Spaces', exact: true }).click();
  await structure.getByLabel('Search structure').fill('Closet');
  await structure.getByRole('button', { name: 'Find Closet on map', exact: true }).click();
  await page.getByRole('button', { name: 'Show properties panel' }).click();
  await page
    .locator('.inspector')
    .getByRole('button', { name: /Lobby.*open boundary/ })
    .click();
  await expect(page.locator('.inspector').getByRole('heading', { name: 'Lobby', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Show structure panel' }).click();
  await structure.getByRole('tab', { name: 'Topology', exact: true }).click();
  await structure.getByRole('button', { name: 'Open graph view' }).click();
  await page.getByRole('button', { name: 'Show navigation panel' }).click();
  await page.getByRole('textbox', { name: 'From', exact: true }).fill('Lobby');
  await page.locator('.place-option').filter({ hasText: 'Lobby' }).click();
  await page.getByRole('textbox', { name: 'To', exact: true }).fill('Closet');
  await page.locator('.place-option').filter({ hasText: 'Closet' }).click();
  await expect(page.locator('.nav-summary')).toBeVisible();
  await expect(page.locator('.nav-empty')).toHaveCount(0);
  await page.getByRole('button', { name: 'Play route', exact: true }).click();
  await expect(graph).not.toBeVisible();
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Play route', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Active floor', exact: true })).toHaveAttribute(
    'data-value',
    'floor-ground',
  );
  await page.screenshot({ path: info.outputPath('viewer-navigation.png') });
  expect(await page.evaluate(id => JSON.parse(localStorage.getItem(`kerros:project:${id}`)!), p.id)).toEqual(p);
  expect(editorRequests).toEqual([]);
  expect(errors).toEqual([]);
});

test('viewer POV playback calls and rides a lift using the host controller', async ({ page }, info) => {
  test.setTimeout(120000);
  const p = createBackrooms({ seed: 'viewer-parity', size: 12 });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(project => localStorage.setItem(`kerros:project:${project.id}`, JSON.stringify(project)), p);
  await page.goto('/viewer.html');
  await page.getByRole('button', { name: /The Backrooms/ }).click();
  await expect(page.locator('.map-wrap')).toHaveAttribute('data-frame', 'ready');
  await page.getByRole('button', { name: 'Walk', exact: true }).click();
  await page.waitForFunction(() => !!(window as any).__kerrosWalk);
  await expect(page.getByRole('slider', { name: 'POV field of view' })).toHaveValue('100');
  await page.getByRole('slider', { name: 'POV field of view' }).fill('110');
  await page.evaluate(() => (window as any).__kerrosWalk.place([2, 0], 90));
  await page.waitForTimeout(500); // let the throttled avatar callback reach the route panel
  await page.getByRole('button', { name: 'Show navigation panel' }).click();
  await page.getByRole('textbox', { name: 'To', exact: true }).fill('Tall pool chamber 1');
  await page.locator('.place-option').filter({ hasText: 'The endless baths' }).first().click();
  await page.getByRole('button', { name: 'Play route', exact: true }).click();
  await expect(page.locator('.walk-status')).toContainText('Calling');
  await expect(page.getByText('You are inside the elevator.', { exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath('viewer-elevator-ride.png') });
  await expect(page.getByRole('button', { name: 'Active floor', exact: true })).toContainText('The endless baths');
  await expect(page.getByRole('button', { name: 'Play route', exact: true })).toBeVisible({ timeout: 45000 });
  await expect(page.locator('.walk-status')).toContainText('Arrived');
  await expect(page.getByText('You are inside the elevator.', { exact: true })).not.toBeVisible();
  expect(errors).toEqual([]);
});
