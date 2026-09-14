import { expect, test } from '@playwright/test';
import { createCanvas } from '@napi-rs/canvas';

test('uses server-rendered PDF reference pages without loading a PDF parser in the editor', async ({ page }) => {
  const canvas = createCanvas(320, 160),
    context = canvas.getContext('2d');
  context.fillStyle = 'white';
  context.fillRect(0, 0, 320, 160);
  context.strokeStyle = 'black';
  context.strokeRect(20, 20, 280, 120);
  await page.addInitScript(png => {
    const original = window.fetch.bind(window);
    Object.assign(window, { __pdfPreviewRequests: 0 });
    window.fetch = async (input, options) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith('/api/ai-import/preview')) {
        const body = options?.body as FormData;
        if ((body.get('file') as File)?.name !== 'floor.pdf' || body.get('page') !== '2')
          throw new Error('Invalid reference preview request');
        (window as unknown as { __pdfPreviewRequests: number }).__pdfPreviewRequests++;
        return new Response(
          Uint8Array.from(atob(png), c => c.charCodeAt(0)),
          { headers: { 'Content-Type': 'image/png' } },
        );
      }
      if (url.includes('/api/ai-import')) throw new Error('Reference import must not start an AI import');
      return original(input, options);
    };
  }, canvas.toBuffer('image/png').toString('base64'));
  await page.route('**/vectortiles/stylejson/**', route =>
    route.fulfill({
      json: {
        version: 8,
        sources: {},
        layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#e6e8e4' } }],
      },
    }),
  );
  const parsers: string[] = [];
  page.on('request', request => {
    if (/pdfjs-dist|pdf\.worker|@anthropic-ai/.test(request.url())) parsers.push(request.url());
  });
  await page.goto('/app.html');
  await page.getByRole('button', { name: /New blank site/ }).click();
  await expect(page.locator('.map-wrap')).toHaveAttribute('data-frame', 'ready');
  await page.getByRole('button', { name: 'Plan editor', exact: true }).click();
  await page.getByRole('button', { name: 'Import reference drawing', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog
    .locator('input[type=file]')
    .setInputFiles({ name: 'floor.pdf', mimeType: 'application/pdf', buffer: Buffer.from('Mock source PDF') });
  await dialog.getByRole('spinbutton', { name: 'PDF page' }).fill('2');
  await dialog.getByRole('button', { name: 'Align drawing', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Align your drawing' })).toBeVisible();
  await expect(page.locator('.alignment-image img')).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __pdfPreviewRequests: number }).__pdfPreviewRequests)).toBe(
    1,
  );
  expect(parsers).toEqual([]);
});
