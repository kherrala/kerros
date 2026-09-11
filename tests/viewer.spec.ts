import { expect, test } from '@playwright/test';
import { createDemo } from '../app/demo/demo';

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
  await expect(floor(/Beauty & cosmetics/)).toHaveClass(/active/);
  await floor(/Herkku food market/).click();
  await expect(floor(/Herkku food market/)).toHaveClass(/active/);
  await page.getByRole('button', { name: '3D', exact: true }).click();
  await expect(page.locator('.map-wrap')).toHaveClass(/perspective/);
  await expect(page.getByTestId('map-canvas')).toBeVisible();
  expect(errors).toEqual([]);
});
