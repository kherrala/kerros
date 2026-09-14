import { expect, test } from '@playwright/test';
import { applyMutations, emptyProject, geoOrigin } from '../src/schema';

for (const pauseReason of ['input-budget', 'turn-limit'] as const)
  test(`saves AI changes and resumes after ${pauseReason}, reload and manual corrections`, async ({
    page,
  }, testInfo) => {
    const built = applyMutations(emptyProject(geoOrigin([24, 60]), 'Imported clinic'), [
      ...[
        [
          [0, 0],
          [8, 0],
        ],
        [
          [8, 0],
          [8, 6],
        ],
        [
          [8, 6],
          [0, 6],
        ],
        [
          [0, 6],
          [0, 0],
        ],
      ].map(([a, b]) => ({
        kind: 'addBarrier' as const,
        a: a as [number, number],
        b: b as [number, number],
        floorId: 'floor-ground',
        barrierKind: 'wall' as const,
      })),
      { kind: 'encloseRoom', floorId: 'floor-ground', point: [3, 3], name: 'Reception' },
    ]);
    if (!built.ok) throw new Error(built.error);
    const document = built.project;
    await page.addInitScript(doc => {
      const realFetch = window.fetch.bind(window);
      let pending: ReadableStreamDefaultController<Uint8Array> | undefined;
      let stopped = false;
      let result = doc;
      let checkpoint: Record<string, unknown>;
      let steering: { id: string; text: string }[] = [];
      const roomId = doc.objects.find(o => o.name === 'Reception')!.id;
      const usage = { inputTokens: 1200, outputTokens: 300, cacheReadTokens: 400, cacheWriteTokens: 100 };
      const encode = (event: unknown) => new TextEncoder().encode(JSON.stringify(event) + '\n');
      Object.assign(window, {
        __finishImport: (paused?: 'input-budget' | 'turn-limit') => {
          pending!.enqueue(
            encode({
              type: 'done',
              document: result,
              usage,
              ...(paused
                ? {
                    pause: {
                      reason: paused,
                      message: 'Run paused at its limit. Calibration and working notes saved.',
                    },
                  }
                : {}),
            }),
          );
          pending!.close();
          pending = undefined;
        },
        __importStopped: () => stopped,
      });
      window.fetch = async (input, init) => {
        if (!String(input).includes('/api/ai-import')) return realFetch(input, init);
        if (!init?.method) return Response.json({ configured: true });
        if (String(input).endsWith('/instructions')) {
          const instruction = JSON.parse(String(init.body));
          localStorage.setItem('test-ai-instruction', instruction.text);
          if (instruction.text === 'Save for next run.')
            return Response.json({ error: 'Run ending; saved for Continue.' }, { status: 409 });
          steering.push(instruction);
          pending!.enqueue(encode({ type: 'checkpoint', checkpoint: { ...checkpoint, steering } }));
          pending!.enqueue(encode({ type: 'text', detail: 'I will follow your updated instructions.' }));
          return Response.json({ queued: true }, { status: 202 });
        }
        const options = JSON.parse(String((init.body as FormData).get('options')));
        localStorage.setItem('test-ai-posts', String(Number(localStorage.getItem('test-ai-posts') || 0) + 1));
        if (
          options.brief?.widthMetres !== 20 ||
          options.brief?.footprintAreaM2 !== 150 ||
          options.brief?.buildingType !== 'house' ||
          options.brief?.floorCount !== 1
        )
          throw new Error('Import template was not retained');
        if (!options.base?.id) throw new Error('Import must start from the live project');
        if (
          String(JSON.stringify(options.checkpoint?.steering)).includes('Preserve my correction') &&
          !options.base.objects.some((o: { name: string }) => o.name === 'Corrected reception')
        )
          throw new Error('Continuation lost manual corrections');
        if (
          Number(localStorage.getItem('test-ai-posts')) > 1 &&
          options.checkpoint?.sourcePlan !== 'Exterior built; next add doors.'
        )
          throw new Error('Continuation lost its source plan');
        if (options.budget.inputTokens !== 200000 || options.budget.maxTurns !== 80) throw new Error('Budget was lost');
        result = options.base.objects.some((o: { id: string }) => o.id === roomId)
          ? options.base
          : { ...doc, id: options.base.id, origin: options.base.origin };
        steering = options.checkpoint?.steering ?? [];
        if (Number(localStorage.getItem('test-ai-posts')) > 1 && !steering.some(m => m.text === 'Save for next run.'))
          throw new Error('Queued instruction lost on reload');
        checkpoint = {
          version: 1,
          projectId: options.base.id,
          brief: options.brief,
          phase: 'build',
          notes: 'Continue openings',
          sourcePlan: 'Exterior built; next add doors.',
          calibration: { metresPerUnit: 0.02, basis: 'User width' },
          mutationKinds: ['addObject'],
          analysis: [],
          lastAssistantText: '',
          lastToolReport: '',
          steering,
        };
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            pending = controller;
            controller.enqueue(encode({ type: 'session', jobId: 'mock-job' }));
            controller.enqueue(
              encode({
                type: 'analysis',
                preview: {
                  artifactId: 'source',
                  background: {
                    pngBase64:
                      'iVBORw0KGgoAAAANSUhEUgAAAMgAAABkCAYAAADDhn8LAAAABHNCSVQICAgIfAhkiAAAAAFzUkdCAK7OHOkAAAFWSURBVHic7dwxCsJAEEBRI97MRjyDYJkzWQZyTy1sIoTfbsD3uukGls90O91v1/cJ2HUevQAcmUAgXLbDurzGbfLnHs/5Z/YW42zfwgWBIBAIAoEgEAgCgSAQCAKBIBAIAoEgEAgCgSAQCAKBIBAIAoEgEAgCgSAQCAKBIBAIAoEgEAgCgSAQCAKBIBAIAoEgEAgCgSAQCAKBIBAIAoEgEAgCgSAQCAKBIBAIAoEgEAgCgSAQCAKBIBAIAoEgEAgCgSAQCAKBIBAIAoEgEAgCgSAQCAKBIBAIAoEgEAgCgSAQCAKBIBAIl9EL8LUur9ErsMMFgSAQCAKBIBAIAoEgEAgCgSAQCAKBIBAIAoEgEAgCgSAQCAKBIBAIAoEgEAgCgSAQCAKBIBAIAoEgEAgCgSAQCAKBIBAIAoEgEAg+jjuIx3P+mX0kdwwuCASBQBAIBIFAEAgEgUAQCASBQBAIBIFAEAiE6X67vkcvAUflgkAQCIQPez4PU1TWyXUAAAAASUVORK5CYII=',
                    bounds: [0, 0, 200, 100],
                    matrix: [0.1, 0, 0, 0.1, 0, 0],
                  },
                  page: 1,
                  units: 'm',
                  transformId: 'scale',
                  metresPerUnit: 0.02,
                  calibration: 'Known exterior width: 20 m',
                  shown: 2,
                  total: 2,
                  counts: { wall: 1, outline: 1 },
                  warnings: [],
                  svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="-1 -1 22 12"><g data-kind="outline"><path d="M0 0L20 0L20 10L0 10Z" fill="none" stroke="#b45309" stroke-width=".2"/></g><g data-kind="wall"><path d="M10 0L10 10" stroke="#2563eb" stroke-width=".2"/></g></svg>',
                },
              }),
            );
            controller.enqueue(encode({ type: 'usage', usage: { ...usage, outputTokens: 10 } }));
            controller.enqueue(encode({ type: 'usage', usage }));
            controller.enqueue(encode({ type: 'text', detail: 'I found the exterior shell and a reception room. ' }));
            controller.enqueue(
              encode({ type: 'tool', detail: 'apply_mutations: exterior walls and enclosed Reception' }),
            );
            controller.enqueue(encode({ type: 'document', document: result }));
            controller.enqueue(
              encode({
                type: 'checkpoint',
                checkpoint,
              }),
            );
            controller.enqueue(encode({ type: 'text', detail: 'Checking the dimensions against the drawing…' }));
            init.signal?.addEventListener('abort', () => {
              stopped = true;
              if (pending) {
                pending.error(new DOMException('Aborted', 'AbortError'));
                pending = undefined;
              }
            });
          },
        });
        return new Response(stream, { headers: { 'Content-Type': 'application/x-ndjson' } });
      };
    }, document);
    await page.route('**/vectortiles/stylejson/**', route =>
      route.fulfill({
        json: {
          version: 8,
          sources: {},
          layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#e6e8e4' } }],
        },
      }),
    );
    await page.goto('/app.html');
    await page.getByRole('button', { name: /New blank site/ }).click();
    await expect(page.locator('.map-wrap')).toHaveAttribute('data-frame', 'ready');
    await page.getByRole('button', { name: 'Plan editor', exact: true }).click();
    if (pauseReason === 'turn-limit') await page.getByRole('button', { name: 'Switch to dark mode' }).click();
    const originalProjectId = new URLSearchParams(new URL(page.url()).hash.slice(1)).get('p');
    await page.getByRole('button', { name: 'Import plan', exact: true }).click();
    const dialog = page.getByRole('complementary', { name: 'Plan import' });
    const setup = dialog.getByRole('tabpanel', { name: 'Setup', exact: true });
    const activity = dialog.getByRole('tabpanel', { name: 'Activity', exact: true });
    const usage = dialog.getByRole('region', { name: 'Token usage' });
    const show = (name: string) => dialog.getByRole('tab', { name, exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(setup).toBeVisible();
    await setup
      .getByLabel('AI source drawing')
      .setInputFiles({ name: 'clinic.pdf', mimeType: 'application/pdf', buffer: Buffer.from('mock drawing') });
    await setup.getByLabel('Import building type').selectOption('house');
    await setup.getByLabel('Import floor count').fill('1');
    await setup.getByLabel('Overall width (m)').fill('20');
    await setup.getByLabel('Floor footprint (m²)').fill('150');
    await setup.getByLabel('Import instructions').fill('Ground floor only.');
    await setup.locator('.ai-import-budget summary').click();
    await setup.getByLabel('Turn limit', { exact: true }).fill('80');
    await dialog.screenshot({ path: testInfo.outputPath('ai-import-setup.png') });
    await dialog.getByRole('button', { name: 'Start AI import', exact: true }).click();
    await expect(activity).toBeVisible();
    await expect(dialog.getByRole('status')).toContainText('1 accepted edits');
    await expect(activity.locator('.ai-import-message').first()).toContainText('Checking the dimensions');
    await activity.getByLabel('Message to AI').fill('Keep the kitchen open.');
    await activity.getByRole('button', { name: 'Send', exact: true }).click();
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem('test-ai-instruction')))
      .toBe('Keep the kitchen open.');
    await expect(activity.getByText('You · queued', { exact: true })).toHaveCount(0);
    await expect(activity.getByLabel('Message to AI')).toHaveValue('');
    await expect(activity).toContainText('updated instructions');
    await dialog.getByRole('button', { name: 'Close plan import' }).click();
    await expect(dialog).not.toBeVisible();
    expect(await page.evaluate(() => (window as unknown as { __importStopped(): boolean }).__importStopped())).toBe(
      false,
    );
    await page.getByRole('button', { name: 'Import plan', exact: true }).click();
    await expect(dialog.getByRole('button', { name: 'Stop import' })).toBeVisible();
    await show('Analysis');
    await expect(dialog.getByRole('img', { name: 'Source analysis SVG, page 1' })).toBeVisible();
    await expect
      .poll(() =>
        dialog
          .getByRole('img', { name: 'Source analysis SVG, page 1' })
          .evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0),
      )
      .toBe(true);
    await dialog.getByLabel('Walls', { exact: false }).uncheck();
    await dialog.getByLabel('Analysis zoom').fill('2');
    await dialog.getByRole('button', { name: 'Fit', exact: true }).click();
    await dialog.getByRole('button', { name: 'Fullscreen SVG preview' }).click();
    const fullscreen = page.getByRole('dialog', { name: 'Source analysis · page 1' });
    await expect(fullscreen).toBeVisible();
    const bounds = await fullscreen.boundingBox();
    expect(bounds!.width).toBe(page.viewportSize()!.width);
    expect(bounds!.height).toBe(page.viewportSize()!.height);
    await expect(fullscreen.getByLabel('Original drawing')).toBeChecked();
    await fullscreen.getByLabel('Original drawing').uncheck();
    await fullscreen.getByLabel('Original drawing').check();
    await fullscreen.getByLabel('SVG opacity').fill('0.5');
    await fullscreen.getByLabel('Walls', { exact: false }).check();
    await fullscreen.getByLabel('Analysis zoom').fill('2');
    await fullscreen.getByRole('button', { name: 'Fit', exact: true }).click();
    await fullscreen.screenshot({ path: testInfo.outputPath('ai-import-fullscreen.png') });
    await page.keyboard.press('Escape');
    await expect(fullscreen).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: 'Fullscreen SVG preview' })).toBeFocused();
    await expect(dialog.getByLabel('Walls', { exact: false })).toBeChecked();
    await expect(dialog.getByLabel('SVG opacity')).toHaveValue('0.5');
    await expect(dialog.getByRole('button', { name: 'Stop import' })).toBeVisible();
    await dialog.screenshot({ path: testInfo.outputPath('ai-import-analysis.png') });
    await show('Usage');
    await expect(usage).toContainText('Tokens reported · 2,000');
    await dialog.getByRole('tab', { name: 'Usage', exact: true }).press('ArrowLeft');
    await expect(activity).toBeVisible();
    const composerBox = await activity.locator('.ai-import-composer').boundingBox();
    const stopBox = await dialog.getByRole('button', { name: 'Stop import' }).boundingBox();
    await activity.locator('.ai-import-tab-scroll').evaluate(el => {
      el.scrollTop = el.scrollHeight;
    });
    expect(await activity.locator('.ai-import-composer').boundingBox()).toEqual(composerBox);
    expect(await dialog.getByRole('button', { name: 'Stop import' }).boundingBox()).toEqual(stopBox);
    await activity.getByLabel('Message to AI').fill('Save for next run.');
    await activity.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(activity.getByText('You · queued', { exact: true })).toBeVisible();
    await expect(dialog.getByRole('alert')).toContainText('saved for Continue');
    await page.screenshot({ path: testInfo.outputPath('ai-import-live.png') });
    await page.evaluate(
      reason => (window as unknown as { __finishImport(reason: string): void }).__finishImport(reason),
      pauseReason,
    );
    await expect(dialog.getByRole('status')).toContainText('Paused');
    await expect(activity.getByText('You · queued', { exact: true })).toBeVisible();
    await page.reload();
    await expect(activity).toBeVisible();
    await expect(activity.getByText('You · queued', { exact: true })).toBeVisible();
    await expect(dialog.getByRole('status')).toContainText('Paused');
    await show('Analysis');
    await expect(dialog.getByRole('img', { name: 'Source analysis SVG, page 1' })).toBeVisible();
    await show('Setup');
    await expect(setup.getByLabel('Overall width (m)')).toHaveValue('20');
    await expect(setup.getByLabel('Floor footprint (m²)')).toHaveValue('150');
    await setup.locator('.ai-import-budget summary').click();
    await expect(setup.getByLabel('Turn limit', { exact: true })).toHaveValue('80');
    expect(new URLSearchParams(new URL(page.url()).hash.slice(1)).get('p')).toBe(originalProjectId);
    expect(await page.evaluate(() => localStorage.getItem('test-ai-posts'))).toBe('1');
    await show('Activity');
    await activity.getByLabel('Message to AI').fill('Continue with the doors.');
    await activity.getByRole('button', { name: 'Send & continue', exact: true }).click();
    await expect(dialog.getByRole('status')).toContainText('2 accepted edits');
    await dialog.getByRole('button', { name: 'Stop import' }).click();
    await expect(dialog.getByRole('status')).toContainText('Paused');
    await show('Usage');
    await expect(usage).toContainText('Tokens reported · 4,000');
    await dialog.getByRole('button', { name: 'Close plan import' }).click();
    await page.getByRole('button', { name: /^Objects \d/ }).click();
    await page.locator('.sidebar .object-row').filter({ hasText: 'Reception' }).click();
    await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Corrected reception');
    await page.getByRole('textbox', { name: 'Name', exact: true }).press('Tab');
    await page.getByRole('button', { name: 'Import plan', exact: true }).click();
    await show('Activity');
    await activity.getByLabel('Message to AI').fill('Preserve my correction and finish.');
    await page.reload();
    await expect(activity.getByLabel('Message to AI')).toHaveValue('Preserve my correction and finish.');
    await activity.getByRole('button', { name: 'Send & continue', exact: true }).click();
    await expect(dialog.getByRole('status')).toContainText('3 accepted edits');
    await page.evaluate(() => (window as unknown as { __finishImport(): void }).__finishImport());
    await expect(dialog.getByRole('status')).toContainText('Saved to project');
    await show('Usage');
    await expect(usage).toContainText('Tokens reported · 6,000');
    await page.reload();
    await expect(dialog.getByRole('status')).toContainText('Saved to project');
    await expect(usage).toContainText('Tokens reported · 6,000');
    expect(await page.evaluate(() => localStorage.getItem('test-ai-posts'))).toBe('3');
  });
