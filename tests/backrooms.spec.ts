import { expect, test } from '@playwright/test';

test.use({
  launchOptions:
    process.platform === 'darwin' ? { args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] } : {},
});

test('generates, renders, walks, and restores the office sample', async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => {
    if (/Context Lost/i.test(m.text()) || (m.type() === 'error' && /THREE|WebGL|shader|geometry/i.test(m.text())))
      errors.push(m.text());
  });
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
  const preview = page.getByRole('img', { name: /Generated office plan/ });
  const original = await preview.getAttribute('aria-label');
  await page.getByRole('textbox', { name: 'Office layout seed' }).fill('playwright-offices');
  await expect(preview).not.toHaveAttribute('aria-label', original!);
  await page.screenshot({ path: testInfo.outputPath('office-generator.png') });
  await page.getByRole('button', { name: 'Open offices', exact: true }).click();
  await expect(page.locator('.map-wrap')).toHaveAttribute('data-frame', 'ready');
  await page.waitForFunction(() => {
    const map = (window as any).__kerrosMap;
    return map && !map.isMoving() && (map.getLayer('kerros-3d')?.implementation.diagnostics?.drawCalls ?? 0) > 0;
  });
  await page.waitForTimeout(800);
  // The budget this guards is batching: 3,734 objects drawn one at a time would be thousands of
  // calls, and the scene has to stay merged by material however many rooms the seed makes. The
  // number is not the count of objects on screen — it is the count of CELLS, because the walk cuts
  // each material's batch into 20 m squares so the frustum and the shadow passes can drop what is
  // behind you. Two deliberate changes have moved it since it was first set at 100: that cell
  // chunking, and a 90 degree walk lens, which between them put roughly half the floor in frame.
  // Assert the invariant as well as the ceiling, so a regression to per-object drawing still fails
  // here even if someone widens the lens again.
  const budget = await page.evaluate(() => {
    const layer = (window as any).__kerrosMap.getLayer('kerros-3d').implementation;
    const materials = new Set<string>();
    let meshes = 0;
    layer.scene.traverse((o: any) => {
      if (!o.isMesh) return;
      meshes++;
      materials.add((Array.isArray(o.material) ? o.material[0] : o.material).uuid);
    });
    return { calls: layer.diagnostics.drawCalls, meshes, materials: materials.size };
  });
  expect(budget.calls).toBeLessThan(250);
  // A handful of finishes, not one material per room.
  expect(budget.materials).toBeLessThan(16);
  // And every mesh is a merged run of many objects: 468 rooms and 5,466 barriers in ~300 meshes.
  expect(budget.meshes).toBeLessThan(600);
  await page.screenshot({ path: testInfo.outputPath('office-cutaway.png') });
  await page.getByRole('button', { name: '2D', exact: true }).click();
  await expect(page).toHaveURL(/v=2d/);
  await page.waitForTimeout(800);
  const order = await page.evaluate(
    () => (window as any).__kerrosMap.getStyle().layers.map((l: { id: string }) => l.id) as string[],
  );
  expect(order.indexOf('kerros-underground')).toBeLessThan(order.indexOf('kerros-areas'));
  expect(order.indexOf('kerros-dim')).toBeLessThan(order.indexOf('kerros-areas'));
  await page.screenshot({ path: testInfo.outputPath('office-2d.png') });
  await page.getByRole('button', { name: '3D', exact: true }).click();
  const revision = await page.evaluate(
    () => (window as any).__kerrosMap.getLayer('kerros-3d').implementation.diagnostics.revision,
  );
  await page.getByRole('button', { name: /^Walk/ }).click();
  await expect(page).toHaveURL(/v=walk/);
  await page.waitForFunction(
    previous => (window as any).__kerrosMap.getLayer('kerros-3d').implementation.diagnostics.revision > previous,
    revision,
  );
  await page.waitForTimeout(800);
  await expect(page.locator('.space-label')).toHaveCount(0);
  await expect(page.locator('.mini-marker[data-kind="room"], .mini-marker[data-kind="zone"]')).toHaveCount(0);
  const lamps = await page.evaluate(() => {
    const layer = (window as any).__kerrosMap.getLayer('kerros-3d').implementation;
    return {
      active: layer.scene.children.filter((o: any) => o.isPointLight && o.intensity > 0).length,
      panels: layer.scene.children.filter((o: any) => o.isInstancedMesh).map((o: any) => o.count),
    };
  });
  expect(lamps.active).toBeGreaterThan(0);
  expect(lamps.active).toBeLessThanOrEqual(4);
  expect(lamps.panels).toContain(28 * 28);
  await page.screenshot({ path: testInfo.outputPath('office-walk.png') });
  await expect(page.getByText('All changes saved', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.locator('.map-wrap')).toHaveAttribute('data-frame', 'ready');
  await expect(page).toHaveURL(/v=walk/);
  await page.getByRole('link', { name: 'kerros Spaces' }).click();
  await expect(page.getByRole('button', { name: 'Open offices', exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test('walks through a gallery opening and lights the tiled bath chambers underwater', async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => {
    if (m.type() === 'error' && /THREE|WebGL|shader|geometry/i.test(m.text())) errors.push(m.text());
  });
  await page.goto('/app.html');
  await page.getByRole('button', { name: 'Open offices', exact: true }).click();
  await expect(page.locator('.map-wrap')).toHaveAttribute('data-frame', 'ready');
  await page.getByRole('button', { name: 'Walk', exact: true }).click();
  await expect(page.getByRole('slider', { name: 'POV field of view' })).toBeVisible();
  await page.waitForFunction(() => {
    const map = (window as any).__kerrosMap;
    return (map?.getLayer('kerros-3d')?.implementation.diagnostics?.drawCalls ?? 0) > 0;
  });
  await page.evaluate(() => {
    const scene = (window as any).__kerrosMap.getLayer('kerros-3d').implementation;
    const hall = scene.project.objects.find(
      (o: any) => o.floorId === 'backrooms-office-0' && o.category === 'backrooms-hall',
    );
    const hole = hall.rings[1];
    const y = Math.min(...hole.map((p: number[]) => p[1]));
    (window as any).__kerrosWalk.pitch = 65;
    (window as any).__kerrosWalk.place([hall.position[0], y - 0.6], 0);
  });
  await page.screenshot({ path: testInfo.outputPath('gallery-opening.png') });
  await page.keyboard.down('w');
  await expect
    .poll(() => page.evaluate(() => (window as any).__kerrosMap.getLayer('kerros-3d').implementation.activeFloor))
    .toBe('backrooms-office-1');
  await page.keyboard.up('w');
  const landing = await page.evaluate(() => (window as any).__kerrosWalk.pose.position);
  await expect
    .poll(() => page.evaluate(() => (window as any).__kerrosMap.transform.getCameraAltitude()))
    .toBeCloseTo(2.03, 2);
  expect(await page.evaluate(() => (window as any).__kerrosWalk.pose.position)).toEqual(landing);
  await page.screenshot({ path: testInfo.outputPath('double-height-hall.png') });
  await page.getByRole('button', { name: 'Active floor' }).click();
  await page.locator('.place-option').filter({ hasText: 'The endless baths' }).click();
  await expect
    .poll(() => page.evaluate(() => (window as any).__kerrosMap.getLayer('kerros-3d').implementation.activeFloor))
    .toBe('backrooms-pool-0');
  await page.evaluate(() => {
    const scene = (window as any).__kerrosMap.getLayer('kerros-3d').implementation;
    const pool = scene.project.objects.find(
      (o: any) => o.floorId === 'backrooms-pool-0' && o.name === 'Stillwater pool',
    );
    const walk = (window as any).__kerrosWalk;
    walk.pitch = 73;
    walk.place([pool.position[0] - pool.width * 0.25, pool.position[1] - pool.depth / 2 - 1.2], 0);
  });
  await expect
    .poll(() =>
      page.evaluate(() => {
        const scene = (window as any).__kerrosMap.getLayer('kerros-3d').implementation;
        return scene.scene.children.filter((o: any) => o.isPointLight && o.intensity > 0 && o.position.z < 0).length;
      }),
    )
    .toBeGreaterThan(0);
  const water = await page.evaluate(() => {
    const scene = (window as any).__kerrosMap.getLayer('kerros-3d').implementation;
    const pools: any[] = [];
    scene.scene.traverse((o: any) => {
      if (o.userData.water) pools.push(o);
    });
    return pools.map(o => ({
      transmission: o.material.transmission,
      ior: o.material.ior,
      triangles: o.geometry.attributes.position.count / 3,
    }));
  });
  expect(water).toHaveLength(6);
  expect(water.every(o => o.transmission > 0.9 && o.ior === 1.333 && o.triangles > 100)).toBe(true);
  const illumination = await page.evaluate(() => {
    const scene = (window as any).__kerrosMap.getLayer('kerros-3d').implementation.scene;
    let caustics = 0,
      ceilingEmission = 0;
    scene.traverse((o: any) => {
      const materials = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
      for (const material of materials) {
        if (material.userData.poolCaustics) caustics++;
        ceilingEmission = Math.max(
          ceilingEmission,
          material.emissiveIntensity && material.emissive?.getHex() ? material.emissiveIntensity : 0,
        );
      }
    });
    return {
      caustics,
      ceilingEmission,
      environment: scene.environmentIntensity,
      otherLights: scene.children.filter((o: any) => o.isLight && !o.isPointLight && o.intensity > 0).length,
    };
  });
  expect(illumination.caustics).toBeGreaterThan(0);
  expect(illumination.ceilingEmission).toBe(0);
  expect(illumination.environment).toBe(0);
  expect(illumination.otherLights).toBe(0);
  await page.waitForTimeout(500);
  await page.screenshot({ path: testInfo.outputPath('white-tiled-pool.png') });
  await page.evaluate(() => {
    const scene = (window as any).__kerrosMap.getLayer('kerros-3d').implementation;
    const pool = scene.project.objects.find((o: any) => o.floorId === 'backrooms-pool-0' && o.name === 'Slide pool');
    const walk = (window as any).__kerrosWalk;
    walk.pitch = 80;
    walk.place([pool.position[0] - pool.width / 2 - 1.2, pool.position[1]], 90);
  });
  await page.waitForTimeout(500);
  await page.screenshot({ path: testInfo.outputPath('tiled-slide-chamber.png') });
  await page.evaluate(() => {
    const scene = (window as any).__kerrosMap.getLayer('kerros-3d').implementation;
    const pool = scene.project.objects.find(
      (o: any) => o.floorId === 'backrooms-pool-0' && o.name === 'Quiet immersion pool 1',
    );
    const walk = (window as any).__kerrosWalk;
    walk.pitch = 85;
    walk.place([pool.position[0] - pool.width * 0.2, pool.position[1] - pool.depth / 2 - 1.2], 0);
  });
  await page.waitForTimeout(500);
  await page.screenshot({ path: testInfo.outputPath('small-tiled-chamber.png') });
  expect(errors).toEqual([]);
});
