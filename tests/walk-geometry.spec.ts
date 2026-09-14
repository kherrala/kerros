import { test, expect, type Page } from '@playwright/test';
import { newProject } from '../src/model/testFixtures';
import { createObject } from '../src/model/factory';
import { addBarrier, rectangle } from '../src/model/geometry';
import type { ProjectDocument } from '../src/model/types';
import { transact } from '../src/model/validate';

test.use({
  launchOptions:
    process.platform === 'darwin' ? { args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] } : {},
});
export async function openFixture(page: Page, p: ProjectDocument) {
  await page.route('**/vectortiles/stylejson/**', route =>
    route.fulfill({
      json: {
        version: 8,
        sources: {},
        layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#ecece5' } }],
      },
    }),
  );
  await page.goto('/app.html');
  await page.evaluate(p => localStorage.setItem(`kerros:project:${p.id}`, JSON.stringify(p)), p);
  await page.goto(`/app.html#p=${p.id}&f=floor-ground`);
  await page.reload();
  await expect(page.locator('.map-wrap')).toHaveAttribute('data-frame', 'ready');
}
const pose = (page: Page) =>
  page.evaluate(() => {
    const w = (window as any).__kerrosWalk,
      m = (window as any).__kerrosMap,
      layer = m.getLayer('kerros-3d').implementation;
    const expected = layer.xy(w.position);
    return {
      position: w.position,
      height: w.stairs.height,
      floor: w.terrain.floorId,
      near: layer.camera.position.toArray(),
      eyeError: Math.hypot(layer.camera.position.x - expected[0], layer.camera.position.y - expected[1]),
    };
  });

function fixture(escalator = false) {
  const p = newProject('Walking geometry');
  p.floors.push({ ...p.floors[0], id: 'upper', elevation: 3.2 });
  for (const floor of p.floors) {
    const room = createObject('room', [0, 0], floor.id, 'Hall');
    Object.assign(room, { rings: [rectangle([0, 0], 22, 22)], width: 22, depth: 22, material: 'terrazzo' });
    p.objects.push(room);
  }
  const stair = createObject('stairs', [0, 0], 'floor-ground', 'Test stair');
  Object.assign(stair, {
    stairModel: escalator ? 'escalator' : 'straight',
    width: 2,
    depth: 8,
    servedFloorIds: ['floor-ground', 'upper'],
  });
  p.objects.push(stair);
  addBarrier(p, [-9, -8], [9, -8], 'floor-ground', 'wall');
  const result = transact(p, () => {});
  if (!result.ok) throw new Error(result.error);
  return result.project;
}

test('walking climbs stairs continuously and returns downstairs without using floor shortcuts', async ({ page }) => {
  await openFixture(page, fixture());
  await page.getByRole('button', { name: 'Walk', exact: true }).click();
  await page.evaluate(() => (window as any).__kerrosWalk.place([0, -4.1], 0));
  await page.keyboard.down('KeyW');
  await expect.poll(async () => (await pose(page)).height).toBeGreaterThan(0.5);
  const midway = await pose(page);
  expect(midway.height).toBeLessThan(3.2);
  expect(midway.eyeError).toBeLessThan(0.01);
  await expect.poll(async () => (await pose(page)).floor).toBe('upper');
  await page.keyboard.up('KeyW');
  expect((await pose(page)).position[1]).toBeLessThan(4.5);
  await page.keyboard.down('KeyS');
  await expect.poll(async () => (await pose(page)).floor).toBe('floor-ground');
  await expect.poll(async () => (await pose(page)).height).toBeLessThan(0.1);
  await page.keyboard.up('KeyS');
});

test('an escalator carries a standing avatar and stops sideways movement through its rail', async ({ page }, info) => {
  await openFixture(page, fixture(true));
  await page.getByRole('button', { name: 'Walk', exact: true }).click();
  await page.evaluate(() => (window as any).__kerrosWalk.place([0, -2.4], 0));
  await page.keyboard.down('KeyW');
  await expect.poll(async () => (await pose(page)).height).toBeGreaterThan(0.3);
  await page.keyboard.up('KeyW');
  const before = await pose(page);
  await expect.poll(async () => (await pose(page)).height).toBeGreaterThan(before.height + 0.3);
  await page.keyboard.down('KeyE');
  await page.waitForTimeout(1200);
  await page.keyboard.up('KeyE');
  expect((await pose(page)).position[0]).toBeLessThan(0.7);
  await page.screenshot({ path: info.outputPath('escalator-treads.png') });
  await expect.poll(async () => (await pose(page)).floor, { timeout: 20000 }).toBe('upper');
});

test('the camera eye stays at collision origin and close walls remain in the POV frustum', async ({ page }, info) => {
  await openFixture(page, fixture());
  await page.getByRole('button', { name: 'Walk', exact: true }).click();
  await expect(page.getByRole('slider', { name: 'POV field of view' })).toHaveValue('100');
  await page.evaluate(() => (window as any).__kerrosWalk.place([3, -7], 180));
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(1400);
  await page.keyboard.up('KeyW');
  const at = await pose(page);
  expect(at.position[1]).toBeGreaterThan(-7.6);
  expect(at.position[1]).toBeLessThan(-7.5);
  expect(at.eyeError).toBeLessThan(0.01);
  const clip = await page.evaluate(async () => {
    const l = (window as any).__kerrosMap.getLayer('kerros-3d').implementation;
    const { Vector3 } = await import('/node_modules/.vite/deps/three.js');
    const xy = l.xy([3, -7.85]);
    return new Vector3(xy[0], xy[1], l.camera.position.z).applyMatrix4(l.worldToClip).toArray();
  });
  expect(clip[2]).toBeGreaterThan(-1);
  expect(clip[2]).toBeLessThan(1);
  await page.screenshot({ path: info.outputPath('close-wall.png') });
});

test('mezzanine walls and exposed edges block walking while supported gallery holes still drop', async ({
  page,
}, info) => {
  const p = newProject('Gallery support');
  p.floors[0].height = 7;
  p.floors.push({ ...p.floors[0], id: 'gallery', name: 'Gallery', elevation: 4, height: 3, mezzanine: true });
  const unsupportedHole = rectangle([-4, 0], 2, 2).reverse();
  for (const floor of p.floors) {
    const room = createObject('room', [0, 0], floor.id, floor.name);
    Object.assign(room, {
      rings: [
        rectangle([0, 0], 12, 12),
        unsupportedHole,
        ...(floor.id === 'gallery' ? [rectangle([0, 0], 4, 4).reverse()] : []),
      ],
      width: 12,
      depth: 12,
      ceilingHeight: floor.id === 'gallery' ? 3 : 7,
    });
    p.objects.push(room);
  }
  const wall = addBarrier(p, [-5, 3], [5, 3], 'floor-ground', 'wall')!;
  wall.height = 7;
  const door = createObject('door', [4, 3], 'floor-ground', 'Lower door');
  Object.assign(door, { barrierId: wall.id, offset: 9, width: 1.2, height: 2.1 });
  p.objects.push(door);
  addBarrier(p, [-5, -3], [5, -3], 'floor-ground', 'wall')!.height = 3;
  const valid = transact(p, () => {});
  if (!valid.ok) throw new Error(valid.error);
  await openFixture(page, valid.project);
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.getByRole('button', { name: 'Active floor', exact: true }).click();
  await page.locator('.place-option').filter({ hasText: 'Gallery' }).click();
  await page.getByRole('button', { name: 'Walk', exact: true }).click();
  const stand = (position: number[], heading: number) =>
    page.evaluate(({ position, heading }) => (window as any).__kerrosWalk.place(position, heading), {
      position,
      heading,
    });
  const walk = async (ms = 550) => {
    await page.keyboard.down('KeyW');
    await page.waitForTimeout(ms);
    await page.keyboard.up('KeyW');
  };
  // The ground-floor doorway has solid wall above it at the gallery's height.
  await stand([4, 2], 0);
  await walk();
  const stopped = await pose(page);
  expect(stopped.floor).toBe('gallery');
  expect(stopped.position[1]).toBeGreaterThan(2.5);
  expect(stopped.position[1]).toBeLessThan(2.6);
  expect(stopped.eyeError).toBeLessThan(0.01);
  await page.screenshot({ path: info.outputPath('gallery-host-wall.png') });
  // The shorter host partition is entirely below the gallery.
  await stand([4, -3.7], 0);
  await walk();
  expect((await pose(page)).position[1]).toBeGreaterThan(-2.8);
  await stand([5.8, 4], 90);
  await walk();
  expect((await pose(page)).position[0]).toBeCloseTo(6, 3);
  expect((await pose(page)).floor).toBe('gallery');
  // Route playback must respect the same edge, both for ordinary legs and physical transfers.
  for (const physical of [false, true]) {
    await stand([5.8, 4], 90);
    const outcome = await page.evaluate(
      physical =>
        new Promise(resolve => {
          (window as any).__kerrosWalk.follow(
            [
              [5.8, 4],
              [8, 4],
            ],
            () => resolve('arrived'),
            {
              physical,
              onCancel: () => resolve('stopped'),
            },
          );
        }),
      physical,
    );
    expect(outcome).toBe('stopped');
    expect((await pose(page)).position[0]).toBeLessThanOrEqual(6);
  }
  await stand([-4, -1.2], 0);
  await walk();
  expect((await pose(page)).position[1]).toBeCloseTo(-1, 3);
  expect((await pose(page)).floor).toBe('gallery');
  await page.screenshot({ path: info.outputPath('gallery-unsupported-hole.png') });
  await stand([0, -2.2], 0);
  await page.keyboard.down('KeyW');
  await expect.poll(async () => (await pose(page)).floor).toBe('floor-ground');
  await page.keyboard.up('KeyW');
  await expect
    .poll(() => page.evaluate(() => (window as any).__kerrosMap.transform.getCameraAltitude()))
    .toBeCloseTo(2.03, 2);
  expect((await pose(page)).position[1]).toBeGreaterThan(-2);
  expect((await pose(page)).position[1]).toBeLessThan(-1.8);
  await page.screenshot({ path: info.outputPath('gallery-landing.png') });
  expect(errors).toEqual([]);
});
