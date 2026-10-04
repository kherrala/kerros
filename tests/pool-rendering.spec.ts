import { expect, test } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { createCanvas, loadImage } from '@napi-rs/canvas';

test.use({
  launchOptions:
    process.platform === 'darwin' ? { args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] } : {},
});

test('pool water preserves reflections with reduced transmission cost and guarded refraction', async ({
  page,
}, info) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', e => {
    if (e.type() === 'error' && /shader|WebGL|THREE/.test(e.text())) errors.push(e.text());
  });
  await page.route('**/vectortiles/stylejson/**', r =>
    r.fulfill({
      json: {
        version: 8,
        sources: {},
        layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#ced5dc' } }],
      },
    }),
  );
  await page.goto('/app.html');
  await page.getByRole('button', { name: 'Open offices', exact: true }).click();
  await expect(page.locator('.map-wrap')).toHaveAttribute('data-frame', 'ready');
  await page.getByRole('button', { name: 'Walk', exact: true }).click();
  await page.getByRole('button', { name: 'Active floor' }).click();
  await page.locator('.place-option').filter({ hasText: 'The endless baths' }).click();
  await page.evaluate(() => {
    const l = (window as any).__kerrosMap.getLayer('kerros-3d').implementation;
    const p = l.project,
      pool = p.objects.find((o: any) => o.water && o.name === 'Arrival reflecting pool');
    const w = (window as any).__kerrosWalk;
    w.pitch = 72;
    w.place([pool.position[0], pool.position[1] - pool.depth / 2 - 2], 0);
    w.lookAt(pool.position);
    (window as any).__testPool = pool;
  });
  await page.waitForTimeout(1000);
  await page.evaluate(() => {
    const l = (window as any).__kerrosMap.getLayer('kerros-3d').implementation;
    const renderer = l.renderer,
      gl = renderer.getContext(),
      original = renderer.render;
    const water: any[] = [];
    l.scene.traverse((o: any) => {
      if (o.userData.water) water.push(o);
    });
    (window as any).__profilePool = (scale: number, side: number, guard: number) =>
      new Promise(resolve => {
        for (const w of water) {
          w.material.side = side;
          w.material.userData.refractionGuard.value = guard;
          w.material.needsUpdate = true;
        }
        const samples: { milliseconds: number; calls: number }[] = [];
        renderer.render = function (...args: any[]) {
          renderer.transmissionResolutionScale = scale;
          gl.finish();
          const start = performance.now();
          original.apply(this, args);
          gl.finish();
          samples.push({ milliseconds: performance.now() - start, calls: renderer.info.render.calls });
          if (samples.length === 16) {
            renderer.render = original;
            resolve(samples.slice(6));
          }
        };
        l.map.triggerRepaint();
      });
  });
  const baseline = await page.evaluate(() => (window as any).__profilePool(1, 2, 0));
  const before = await page.screenshot({ path: info.outputPath('pool-original-refraction.png') });
  const optimized = await page.evaluate(() => (window as any).__profilePool(0.5, 0, 1));
  const metrics = await page.evaluate(() => {
    const l = (window as any).__kerrosMap.getLayer('kerros-3d').implementation;
    const water: any[] = [];
    l.scene.traverse((o: any) => {
      if (o.userData.water) water.push(o);
    });
    return {
      water: water.length,
      transmission: water.filter(w => w.material.transmission > 0.9).length,
      scale: l.renderer.transmissionResolutionScale,
    };
  });
  await writeFile(
    info.outputPath('pool-render-cost.json'),
    JSON.stringify({ ...metrics, baseline, optimized }, null, 2),
  );
  const after = await page.screenshot({ path: info.outputPath('pool-distant.png') });
  const probe = await page.evaluate(() => {
    const l = (window as any).__kerrosMap.getLayer('kerros-3d').implementation;
    const pool = (window as any).__testPool;
    const point = l.projectPoint(
      [pool.position[0] + pool.width * 0.15, pool.position[1] - pool.depth * 0.35],
      pool.floorId,
    );
    const rect = l.map.getCanvas().getBoundingClientRect();
    return { x: Math.round(point.x + rect.left), y: Math.round(point.y + rect.top) };
  });
  const luminance = async (png: Buffer) => {
    const image = await loadImage(png),
      canvas = createCanvas(image.width, image.height),
      ctx = canvas.getContext('2d');
    ctx.drawImage(image, 0, 0);
    const pixels = ctx.getImageData(probe.x - 5, probe.y - 5, 10, 10).data;
    let total = 0;
    for (let i = 0; i < pixels.length; i += 4)
      total += 0.2126 * pixels[i] + 0.7152 * pixels[i + 1] + 0.0722 * pixels[i + 2];
    return total / 100;
  };
  // The old ray picked the dark foreground floor at this basin point. The guarded ray retains
  // the lit pool bottom, with transmission/reflections still enabled in both captures.
  expect(await luminance(after)).toBeGreaterThan((await luminance(before)) + 40);
  await page.evaluate(() => {
    const w = (window as any).__kerrosWalk,
      pool = (window as any).__testPool;
    w.pitch = 62;
    w.place([pool.position[0], pool.position[1] - pool.depth / 2 - 0.5], 0);
    w.lookAt(pool.position);
  });
  await page.waitForTimeout(300);
  await page.screenshot({ path: info.outputPath('pool-near.png') });
  expect(metrics.water).toBeGreaterThan(0);
  expect(metrics.transmission).toBe(metrics.water);
  expect(metrics.scale).toBe(0.5);
  expect(errors).toEqual([]);
});
