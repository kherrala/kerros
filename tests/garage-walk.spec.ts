import { expect, test } from '@playwright/test';

test.use({
  launchOptions:
    process.platform === 'darwin' ? { args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] } : {},
});

test('garage ramps have flat aprons, open headroom and continuous walking between decks', async ({ page }, info) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/vectortiles/stylejson/**', r =>
    r.fulfill({
      json: {
        version: 8,
        sources: {},
        layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#b9ceda' } }],
      },
    }),
  );
  await page.goto('/app.html');
  await page.getByRole('button', { name: /Stockmann Helsinki.*Open/ }).click();
  await expect(page.locator('.map-wrap')).toHaveAttribute('data-frame', 'ready');
  await page.getByRole('button', { name: 'Active floor' }).click();
  await page.locator('.place-option').filter({ hasText: 'Parking P3' }).click();
  await page.getByRole('button', { name: 'Walk', exact: true }).click();
  const geometry = await page.evaluate(async () => {
    const THREE = await import('/node_modules/.vite/deps/three.js' as string);
    const { hitEntity } = await import('/src/map/surfaces.ts' as string);
    const l = (window as any).__kerrosMap.getLayer('kerros-3d').implementation;
    const p = l.project,
      ramp = p.objects.find((o: any) => o.name === 'Ramp P2 → P3');
    const [a, b] = ramp.slope.axis,
      low = ramp.slope.low,
      rise = ramp.slope.high - low;
    l.scene.updateMatrixWorld(true);
    const samples = [0.02, 0.25, 0.5, 0.75, 0.98].map(t => {
      const xy = l.xy([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
      const height = 0.33 + rise * (1 - t);
      const down = new THREE.Raycaster(new THREE.Vector3(...xy, height + 0.1), new THREE.Vector3(0, 0, -1), 0, 0.3);
      const floor = down.intersectObjects(l.scene.children, true).find((h: any) => hitEntity(h) === ramp.id);
      const up = new THREE.Raycaster(new THREE.Vector3(...xy, height + 0.2), new THREE.Vector3(0, 0, 1), 0, 20);
      const roof = up
        .intersectObjects(l.scene.children, true)
        .find((h: any) => /ceiling|plate/.test(hitEntity(h) ?? ''));
      return { t, delta: floor ? Math.abs(floor.point.z - height) : null, clearance: roof?.distance };
    });
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]),
      u = [(a[0] - b[0]) / length, (a[1] - b[1]) / length];
    const start = [b[0] - u[0] * 4, b[1] - u[1] * 4],
      end = [a[0] + u[0] * 4, a[1] + u[1] * 4];
    (window as any).__rampPath = [start, end];
    const w = (window as any).__kerrosWalk;
    w.pitch = 85;
    w.place(start, (Math.atan2(u[0], u[1]) * 180) / Math.PI);
    return samples;
  });
  for (const sample of geometry) {
    expect(sample.delta).not.toBeNull();
    expect(sample.delta!).toBeLessThan(0.003);
    expect(sample.clearance).toBeGreaterThan(2);
  }
  await page.keyboard.down('Shift');
  await page.keyboard.down('w');
  try {
    await expect
      .poll(() => page.evaluate(() => (window as any).__kerrosWalk.stairs.height), { timeout: 30000 })
      .toBeGreaterThan(-21.4);
  } finally {
    await page.keyboard.up('w');
    await page.keyboard.up('Shift');
  }
  await page.screenshot({ path: info.outputPath('ramp-mid-climb.png') });
  await page.evaluate(() => {
    const w = (window as any).__kerrosWalk;
    w.follow([w.position, (window as any).__rampPath[1]], () => {}, { physical: true, speed: 10 });
  });
  await expect(page.getByRole('button', { name: 'Active floor' })).toContainText('Parking P2');
  await expect.poll(() => page.evaluate(() => (window as any).__kerrosWalk.following)).toBe(false);
  expect(await page.evaluate(() => (window as any).__kerrosWalk.stairs.height)).toBeCloseTo(-19.2);
  await page.screenshot({ path: info.outputPath('ramp-upper-landing.png') });
  await page.evaluate(() => {
    const w = (window as any).__kerrosWalk;
    w.follow([w.position, (window as any).__rampPath[0]], () => {}, { physical: true, speed: 10 });
  });
  await expect(page.getByRole('button', { name: 'Active floor' })).toContainText('Parking P3');
  await expect.poll(() => page.evaluate(() => (window as any).__kerrosWalk.following)).toBe(false);
  expect(await page.evaluate(() => (window as any).__kerrosWalk.stairs.height)).toBeCloseTo(-23.4);

  // The stairs have their destination slab, walls and roof before the selected floor changes.
  const stair = await page.evaluate(async () => {
    const { flights, flightRun, stairModel } = await import('/src/model/vertical.ts' as string);
    const { stairGeometry } = await import('/src/model/stairGeometry.ts' as string);
    const l = (window as any).__kerrosMap.getLayer('kerros-3d').implementation;
    const p = l.project,
      w = (window as any).__kerrosWalk;
    const o = p.objects.find((o: any) => o.name === 'Garage stair' && o.floorId === 'floor-p3');
    const f = flights(p, o)[0],
      model = stairModel(p, o),
      shape = stairGeometry(o, flightRun(p, o, f.rise, model), f.rise, model);
    const points: number[][] = [];
    for (const [i, lane] of shape.lanes.entries()) {
      const dx = lane.head[0] - lane.foot[0],
        dy = lane.head[1] - lane.foot[1],
        len = Math.hypot(dx, dy);
      if (!i) points.push([lane.foot[0] - (dx / len) * 0.4, lane.foot[1] - (dy / len) * 0.4]);
      if (i) points.push([lane.foot[0] + (dx / len) * -0.05, lane.foot[1] + (dy / len) * -0.05]);
      points.push(lane.foot, lane.head);
      if (i === shape.lanes.length - 1) points.push([lane.head[0] + (dx / len) * 0.4, lane.head[1] + (dy / len) * 0.4]);
    }
    (window as any).__stairPath = points;
    w.place(points[0], (Math.atan2(points[1][0] - points[0][0], points[1][1] - points[0][1]) * 180) / Math.PI);
    const ids: string[] = [];
    l.scene.traverse((m: any) => {
      if (m.userData.spans) ids.push(...m.userData.spans.map((s: any) => s.id));
    });
    return { ids, floor: f.to.id };
  });
  expect(stair.ids).toContain(`atrium-plate:${stair.floor}`);
  expect(stair.ids).toContain(`connection-ceiling:${stair.floor}`);
  await page.screenshot({ path: info.outputPath('stairs-destination-visible.png') });
  await page.evaluate(() => {
    const w = (window as any).__kerrosWalk;
    w.follow((window as any).__stairPath, () => {}, { physical: true, speed: 2 });
  });
  await expect(page.getByRole('button', { name: 'Active floor' })).toContainText('Parking P2');
  await expect.poll(() => page.evaluate(() => (window as any).__kerrosWalk.following)).toBe(false);
  expect(await page.evaluate(() => (window as any).__kerrosWalk.stairs.height)).toBeCloseTo(-19.2);
  await page.screenshot({ path: info.outputPath('stairs-upper-landing.png') });
  expect(errors).toEqual([]);
});
