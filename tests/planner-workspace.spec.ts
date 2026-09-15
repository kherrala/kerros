import { expect, test } from '@playwright/test';

test('sidebar and map preferences survive closing panels and switching workspace modes', async ({ page }) => {
  await page.route('**/vectortiles/stylejson/**', route =>
    route.fulfill({
      json: {
        version: 8,
        sources: {},
        layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#e6e8e4' } }],
      },
    }),
  );
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/app.html');
  await page.getByRole('button', { name: /New blank site/ }).click();
  await expect(page.locator('.map-wrap')).toHaveAttribute('data-frame', 'ready');
  await page.getByRole('button', { name: 'Plan editor', exact: true }).click();

  const sidebar = page.locator('.sidebar');
  const building = sidebar.getByRole('button', { name: /^Main building/ });
  await building.click();
  await expect(building).toHaveAttribute('aria-expanded', 'false');
  await sidebar.getByRole('button', { name: /^Objects / }).click();
  await sidebar.getByRole('textbox', { name: 'Search objects' }).fill('Meeting room');
  await page.getByRole('button', { name: 'Hide side panel' }).click();
  await expect(sidebar).toHaveCount(0);
  await page.getByRole('button', { name: 'Show side panel' }).click();
  await expect(sidebar.getByRole('textbox', { name: 'Search objects' })).toHaveValue('Meeting room');
  await sidebar.getByRole('button', { name: 'Structure', exact: true }).click();
  await expect(building).toHaveAttribute('aria-expanded', 'false');

  await page.getByRole('button', { name: 'Map settings', exact: true }).click();
  await page.getByRole('switch', { name: 'Space labels', exact: true }).click();
  await page.getByRole('switch', { name: 'Snap to geometry & grid', exact: true }).click();
  await page.getByRole('button', { name: 'Close map settings' }).click();
  await page.getByRole('button', { name: 'Plan viewer', exact: true }).click();
  await page.getByRole('button', { name: 'Plan editor', exact: true }).click();
  await expect(building).toHaveAttribute('aria-expanded', 'false');
  await sidebar.getByRole('button', { name: /^Objects / }).click();
  await expect(sidebar.getByRole('textbox', { name: 'Search objects' })).toHaveValue('Meeting room');
  await page.getByRole('button', { name: 'Map settings', exact: true }).click();
  await expect(page.getByRole('switch', { name: 'Space labels', exact: true })).not.toBeChecked();
  await expect(page.getByRole('switch', { name: 'Snap to geometry & grid', exact: true })).not.toBeChecked();
  expect(errors).toEqual([]);
});
