import { test, expect } from '@playwright/test';

test.use({
  launchOptions:
    process.platform === 'darwin' ? { args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] } : {},
});

test('Stockmann shows opposing ribbed escalators in a shared well beside a tiled hall', async ({ page }, info) => {
  test.setTimeout(90000);
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/vectortiles/stylejson/**', route =>
    route.fulfill({
      json: {
        version: 8,
        sources: {},
        layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#eee' } }],
      },
    }),
  );
  await page.goto('/app.html');
  await page.getByRole('button', { name: /Stockmann Helsinki.*Open/ }).click();
  await expect(page.locator('.map-wrap')).toHaveAttribute('data-frame', 'ready');
  await page.getByRole('button', { name: 'Active floor' }).click();
  await page.locator('.place-option').filter({ hasText: 'Beauty & cosmetics' }).click();
  await page.getByRole('button', { name: 'Walk', exact: true }).click();
  await page.evaluate(() => {
    const w = (window as any).__kerrosWalk;
    w.pitch = 80;
    w.place([8.5, -24], 0);
  });
  await page.waitForTimeout(700);
  const materials = await page.evaluate(() => {
    const l = (window as any).__kerrosMap.getLayer('kerros-3d').implementation;
    const seen: string[] = [];
    l.scene.traverse((o: any) => {
      for (const m of Array.isArray(o.material) ? o.material : [o.material])
        if (m?.userData.finish && m.map) seen.push(m.userData.finish);
    });
    return seen;
  });
  expect(materials).toContain('terrazzo');
  expect(materials).toContain('escalator-tread');
  await page.screenshot({ path: info.outputPath('stockmann-escalator-pair.png') });
  expect(errors).toEqual([]);
});

test('Stockmann interior facades have one finish per face and every window stays transparent', async ({
  page,
}, info) => {
  test.setTimeout(90000);
  await page.route('**/vectortiles/stylejson/**', route =>
    route.fulfill({
      json: {
        version: 8,
        sources: {},
        layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#cee1ed' } }],
      },
    }),
  );
  await page.goto('/app.html');
  await page.getByRole('button', { name: /Stockmann Helsinki.*Open/ }).click();
  await expect(page.locator('.map-wrap')).toHaveAttribute('data-frame', 'ready');
  await page.getByRole('button', { name: 'Active floor' }).click();
  await page.locator('.place-option').filter({ hasText: 'Beauty & cosmetics' }).click();
  await page.getByRole('button', { name: 'Walk', exact: true }).click();
  const result = await page.evaluate(async () => {
    const THREE = await import('/node_modules/.vite/deps/three.js' as string);
    const { wallPieces } = await import('/src/map/features.ts' as string);
    const { objectPosition } = await import('/src/model/geometry.ts' as string);
    const l = (window as any).__kerrosMap.getLayer('kerros-3d').implementation;
    const p = l.project,
      floor = 'floor-ground';
    const pieces = wallPieces(p, floor, false);
    const windows = p.objects.filter((o: any) => o.floorId === floor && o.kind === 'window');
    const target = windows[4],
      wall = p.barriers.find((b: any) => b.id === target.barrierId);
    const edge = l.interiorFace(
      p,
      pieces.find((s: any) => s.id === wall.id),
      floor,
    );
    const dx = edge[1][0] - edge[0][0],
      dy = edge[1][1] - edge[0][1],
      length = Math.hypot(dx, dy);
    const normal = [dy / length, -dx / length],
      center = objectPosition(p, target);
    const w = (window as any).__kerrosWalk;
    w.pitch = 88;
    w.place(
      [center[0] + normal[0] * 7, center[1] + normal[1] * 7],
      (Math.atan2(-normal[0], -normal[1]) * 180) / Math.PI,
    );
    l.scene.updateMatrixWorld(true);
    const panes: number[] = [],
      opaqueHits: string[] = [];
    for (const window of windows) {
      const piece = pieces.find((s: any) => s.id === window.barrierId),
        inner = l.interiorFace(p, piece, floor);
      if (!inner) continue;
      const a = objectPosition(p, window);
      // The inward normal is taken from the actual face, including oblique facade edges.
      const nx = (inner[1][1] - inner[0][1]) / Math.hypot(inner[1][0] - inner[0][0], inner[1][1] - inner[0][1]);
      const ny = -(inner[1][0] - inner[0][0]) / Math.hypot(inner[1][0] - inner[0][0], inner[1][1] - inner[0][1]);
      const from = new THREE.Vector3(...l.xy([a[0] + nx * 0.8, a[1] + ny * 0.8]), 2);
      const to = new THREE.Vector3(...l.xy(a), 2);
      const ray = new THREE.Raycaster(from, to.clone().sub(from).normalize(), 0, 1.2);
      const hits = ray.intersectObjects(l.scene.children, true).filter((h: any) => h.object.material);
      const first = hits[0];
      if (!first || !first.object.material.transparent || first.object.material.opacity >= 0.5)
        opaqueHits.push(window.id);
      else panes.push(first.object.material.opacity);
    }
    return { panes: panes.length, windows: windows.length, opaqueHits };
  });
  expect(result.opaqueHits).toEqual([]);
  expect(result.panes).toBe(result.windows);
  await page.waitForTimeout(500);
  await page.screenshot({ path: info.outputPath('stockmann-interior-facade.png') });
});

test('the POV atrium shows supported storeys without floating well caps or ghost elevator shafts', async ({
  page,
}, info) => {
  test.setTimeout(90000);
  await page.route('**/vectortiles/stylejson/**', route =>
    route.fulfill({
      json: {
        version: 8,
        sources: {},
        layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#cee1ed' } }],
      },
    }),
  );
  await page.goto('/app.html');
  await page.getByRole('button', { name: /Stockmann Helsinki.*Open/ }).click();
  await expect(page.locator('.map-wrap')).toHaveAttribute('data-frame', 'ready');
  await page.getByRole('button', { name: 'Active floor' }).click();
  await page.locator('.place-option').filter({ hasText: 'Menswear & denim' }).click();
  await page.getByRole('button', { name: 'Walk', exact: true }).click();
  await page.evaluate(() => {
    const w = (window as any).__kerrosWalk;
    w.pitch = 98;
    w.place([10, -27], 0);
  });
  await page.waitForTimeout(700);
  const result = await page.evaluate(() => {
    const l = (window as any).__kerrosMap.getLayer('kerros-3d').implementation;
    const plates = new Set(),
      caps = new Set(),
      ghosts = new Set();
    const lifts = new Set(l.project.objects.filter((o: any) => o.kind === 'elevator').map((o: any) => o.id));
    l.scene.traverse((o: any) => {
      for (const s of o.userData.spans ?? []) {
        if (s.id.startsWith('atrium-plate:')) plates.add(s.id);
        if (s.id.startsWith('well:')) caps.add(s.id);
        if (lifts.has(s.id) && o.material?.transparent) ghosts.add(s.id);
      }
    });
    return { plates: plates.size, caps: caps.size, ghosts: ghosts.size };
  });
  expect(result.plates).toBeGreaterThan(6);
  expect(result.caps).toBe(0);
  expect(result.ghosts).toBe(0);
  await page.screenshot({ path: info.outputPath('stockmann-atrium-context.png') });
});
