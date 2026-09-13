import { expect, test } from '@playwright/test';

test.skip(!process.env.KERROS_E2E_PRODUCTION, 'Runs against built chunks with npm run test:production.');
test.use({
  launchOptions:
    process.platform === 'darwin' ? { args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] } : {},
});

test('the production Backrooms opens offices, walking mode and pool water without initialization errors', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', message => {
    if (message.type() === 'error' && /THREE|WebGL|shader|initialization/i.test(message.text()))
      errors.push(message.text());
  });
  await page.goto('/app.html');
  await page.getByRole('button', { name: 'Open offices', exact: true }).click();
  await expect(page.locator('.map-wrap')).toHaveAttribute('data-frame', 'ready');
  await page.getByRole('button', { name: 'Walk', exact: true }).click();
  await expect(page.getByRole('slider', { name: 'POV field of view' })).toHaveValue('90');
  await page.getByRole('button', { name: 'Active floor' }).click();
  await page.locator('.place-option').filter({ hasText: 'The endless baths' }).click();
  await expect(page.getByRole('button', { name: 'Active floor' })).toContainText('The endless baths');
  await page.waitForTimeout(1000);
  await expect(page.locator('.map-wrap')).toHaveAttribute('data-frame', 'ready');
  expect(errors).toEqual([]);
});
