import { expect, test, type Page } from '@playwright/test';
import type { ProjectDocument } from '../src/model/types';
import { newProject } from '../src/model/testFixtures';
import { toLngLat } from '../src/model/geometry';

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

async function floorPixels(page: Page): Promise<number> {
  const screenshot = await page.getByTestId('map-canvas').screenshot();
  return page.evaluate(async data => {
    const blob = await (await fetch(`data:image/png;base64,${data}`)).blob();
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let count = 0;
    // The plan fill is a saturated pastel (cool campus rooms or warm Stockmann cream/brick) — count
    // any pixel whose channels are clearly non-grey, so the check is independent of the palette hue.
    for (let i = 0; i < pixels.length; i += 4) {
      const [r, g, b] = [pixels[i], pixels[i + 1], pixels[i + 2]];
      if (Math.max(Math.abs(r - g), Math.abs(g - b), Math.abs(r - b)) > 12) count++;
    }
    return count;
  }, screenshot.toString('base64'));
}

async function canvasPoint(page: Page, x: number, y: number) {
  const box = await page.getByTestId('map-canvas').boundingBox();
  if (!box) throw new Error('Map has no bounds');
  return { x: box.x + box.width * x, y: box.y + box.height * y };
}

async function clickAt(page: Page, point: { x: number; y: number }) {
  await page.mouse.click(point.x, point.y);
}

async function importFile(page: Page, name: string, mimeType: string, buffer: Buffer, tab?: string) {
  await page.getByRole('button', { name: 'Import', exact: true }).click();
  const dialog = page.getByRole('dialog');
  if (tab) await dialog.getByRole('button', { name: tab, exact: true }).click();
  await dialog.locator('input[type=file]').setInputFiles({ name, mimeType, buffer });
  await dialog.getByRole('button', { name: tab ? 'Import' : 'Align drawing', exact: true }).click();
}

async function rename(page: Page, name: string) {
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill(name);
  await page.getByRole('textbox', { name: 'Name', exact: true }).press('Enter');
}

// Wait until the camera is fully idle: a reference element's screen position stops moving.
async function cameraSettled(page: Page, name: string) {
  let previous = '';
  for (let i = 0; i < 30; i++) {
    const box = await page.getByRole('button', { name }).boundingBox();
    const current = box ? `${Math.round(box.x)},${Math.round(box.y)}` : '';
    if (current && current === previous) return;
    previous = current;
    await page.waitForTimeout(300);
  }
  throw new Error(`Camera never settled while watching “${name}”`);
}

async function ready(page: Page) {
  await expect(page.locator('.map-loading')).toHaveCount(0);
  await expect(page.locator('.map-wrap')).toHaveAttribute('data-frame', 'ready');
  // Projects land in Plan viewer by default; these suites exercise the editor.
  await page.getByRole('button', { name: 'Plan editor', exact: true }).click();
}

/** Wait until the plan is flat and still.
 *
 *  Geometry assertions convert screen pixels to metres, and that conversion is only isotropic when
 *  the camera is unpitched: at 16 degrees a vertical pixel is worth ten times a horizontal one, so a
 *  wall aimed "six pixels off level" is really aimed seven metres off. The landing view eases out of
 *  3D, and how far that ease has got by the time a test clicks depends on frame rate — which is to
 *  say, on whether the run has a GPU. Make the precondition explicit rather than lucky. */
async function flatCamera(page: Page) {
  await page.waitForFunction(
    () => {
      const map = (window as unknown as { __kerrosMap?: { getPitch(): number; isMoving(): boolean } }).__kerrosMap;
      return !!map && !map.isMoving() && map.getPitch() < 0.01;
    },
    undefined,
    { timeout: 15000 },
  );
}

async function pickFloor(page: Page, name: string | RegExp, exclude?: string) {
  await page.getByRole('button', { name: 'Active floor' }).click();
  let options = page.locator('.place-option').filter({ hasText: name });
  if (exclude) options = options.filter({ hasNotText: exclude });
  await options.first().click();
}

async function savedProject(page: Page): Promise<ProjectDocument> {
  // A just-committed change flips the header to "Saving…" only on the next render; wait out the
  // debounce so "All changes saved" can never be the PREVIOUS save observed too early.
  await page.waitForTimeout(600);
  await expect(page.locator('.save-status')).toContainText('All changes saved');
  return page.evaluate(() => {
    const key = Object.keys(localStorage).find(key => key.startsWith('kerros:project:'))!;
    return JSON.parse(localStorage.getItem(key)!);
  });
}

test('both populated sites render, switch floors, and open 3D without runtime errors', async ({ page }, testInfo) => {
  // Headless Chromium renders WebGL through SwiftShader unless a spec asks for the GPU, and a buried
  // basement of a few thousand objects takes most of a minute to paint in software. Asking for the
  // GPU suite-wide is worse: sixteen specs sharing one browser exhaust its WebGL contexts and the
  // later ones stop rendering entirely. So this one view gets the time it needs instead.
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/app.html');
  await page.getByRole('button', { name: /Stockmann Helsinki.*Open/ }).click();
  await ready(page);
  // The document names its own opening floor (initialFloorId), so the demo lands on the offices
  // rather than the street — a 17-storey building should not open buried under its ground floor.
  const activeFloor = page.getByRole('button', { name: 'Active floor' });
  await expect(activeFloor).toHaveAttribute('data-value', 'floor-08');
  await expect(activeFloor).toContainText('Offices');
  expect((await savedProject(page)).floors.length).toBeGreaterThanOrEqual(8);
  await page.screenshot({ path: testInfo.outputPath('campus-2d.png') });
  await page.getByRole('button', { name: '3D', exact: true }).click();
  await expect(page.locator('.map-wrap')).toHaveClass(/perspective/);
  await page.getByRole('button', { name: 'Cutaway', exact: true }).click();
  await expect(page.getByRole('button', { name: 'All floors', exact: true })).toBeVisible();
  await page.waitForTimeout(800); // Wait for the intentional camera/building entrance animation.
  await page.screenshot({ path: testInfo.outputPath('campus-stack.png') });
  await page.getByRole('button', { name: 'All floors', exact: true }).click();
  await pickFloor(page, 'Herkku food market');
  await page.waitForTimeout(800);
  await page.screenshot({ path: testInfo.outputPath('basement.png') });
  await page.getByRole('button', { name: 'All spaces', exact: true }).click();
  expect(errors).toEqual([]);
});

test('import, align, trace, attach, save, export and reopen a complete site', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/app.html');
  await page.getByRole('button', { name: /New blank site/ }).click();
  await ready(page);

  const origin = newProject().origin;
  const footprint = {
    type: 'Feature',
    properties: { name: 'Test building' },
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [-20, -15],
          [20, -15],
          [20, 15],
          [-20, 15],
          [-20, -15],
        ].map(p => toLngLat(p as [number, number], origin)),
      ],
    },
  };
  await importFile(
    page,
    'footprint.geojson',
    'application/geo+json',
    Buffer.from(JSON.stringify(footprint)),
    'GeoJSON',
  );
  await expect(page.getByRole('heading', { name: 'Test building' })).toBeVisible();
  await page.getByRole('button', { name: 'Create floor walls' }).click();
  expect((await savedProject(page)).barriers).toHaveLength(4);
  await page.getByRole('button', { name: 'Fit floor', exact: true }).click();
  await cameraSettled(page, 'Move vertex 1');
  const vertex = async (index: number) => {
    const b = await page.getByRole('button', { name: `Move vertex ${index}` }).boundingBox();
    if (!b) throw new Error('Missing footprint vertex');
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  };
  const [sw, se, ne, nw] = await Promise.all([1, 2, 3, 4].map(vertex));
  // Split the footprint with a wall across the middle, west edge → east edge. (Horizontal, not
  // top→bottom: the drawing instruction bar overlays the bottom strip of the map, so a bottom-edge
  // click would land on the bar rather than the canvas.)
  const left = { x: (sw.x + nw.x) / 2, y: (sw.y + nw.y) / 2 },
    right = { x: (se.x + ne.x) / 2, y: (se.y + ne.y) / 2 };
  await page.getByRole('button', { name: 'Wall tool', exact: true }).click();
  // The map reads the active tool from props: wait until the tool instruction proves the wall
  // tool reached the canvas, or a fast follow-up click still lands as a select-tool click.
  await expect(page.locator('.tool-instruction')).toContainText('Click on the map to start');
  // The test key cannot load MML sources, so the "Basemap unavailable" banner may sit over a
  // facade; dismiss it before drawing across the plan.
  if (await page.locator('.map-error').count()) await page.locator('.map-error').click();
  await clickAt(page, left);
  await clickAt(page, right);
  await page.keyboard.press('Enter');
  expect((await savedProject(page)).barriers).toHaveLength(7);
  await page.getByRole('button', { name: 'Door tool', exact: true }).click();
  await expect(page.locator('.tool-instruction')).toContainText('Click a supporting wall');
  await clickAt(page, { x: (left.x + right.x) / 2, y: (left.y + right.y) / 2 });
  await page.getByRole('button', { name: 'Select tool', exact: true }).click();
  await rename(page, 'Lobby door');
  const withDoor = await savedProject(page);
  const door = withDoor.objects.find(o => o.name === 'Lobby door')!;
  expect(door.barrierId).toBeTruthy();
  expect(door.feedId).toBeTruthy();

  // Generate a modest drawing fixture in the browser; no image or network dependency.
  const data = await page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 800;
    c.height = 600;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, 800, 600);
    ctx.strokeStyle = '#606060';
    ctx.lineWidth = 5;
    ctx.strokeRect(80, 60, 640, 480);
    ctx.beginPath();
    ctx.moveTo(400, 60);
    ctx.lineTo(400, 540);
    ctx.stroke();
    return c.toDataURL('image/png').split(',')[1];
  });
  await importFile(page, 'architect.png', 'image/png', Buffer.from(data, 'base64'));
  const image = page.getByAltText('Architectural drawing to align');
  await expect(image).toBeVisible();
  const imageBox = await image.boundingBox();
  await image.click({ position: { x: imageBox!.width * 0.1, y: imageBox!.height * 0.1 } });
  await image.click({ position: { x: imageBox!.width * 0.9, y: imageBox!.height * 0.1 } });
  await clickAt(page, nw);
  await clickAt(page, ne);
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm alignment', exact: true }).click();
  let saved = await savedProject(page);
  expect(saved.drawings).toHaveLength(1);
  expect(saved.drawings[0].scale).toBeCloseTo(40 / 640, 2);
  await page.getByRole('switch', { name: 'Visible', exact: true }).click();
  await page.getByRole('button', { name: 'Close properties' }).click();

  await page.getByRole('button', { name: 'Structure', exact: true }).click();
  await page.getByRole('button', { name: 'Duplicate current floor' }).click();
  saved = await savedProject(page);
  expect(saved.floors).toHaveLength(2);
  const copiedFloorId = (await page.getByRole('button', { name: 'Active floor' }).getAttribute('data-value'))!;
  expect(saved.objects.filter(o => o.floorId === copiedFloorId).every(o => !o.feedId)).toBe(true);
  await pickFloor(page, 'Ground floor', 'copy');
  await page.getByRole('button', { name: /Objects\d*/ }).click();
  await page.getByRole('button', { name: /Lobby door.*door/ }).click();
  expect((await savedProject(page)).objects).toEqual(saved.objects);
  // The reference app supplies no StatusFeed, so the editor offers no monitoring surface at all.
  await expect(page.getByRole('button', { name: 'Live view', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Plan viewer', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Move selected object' })).toHaveCount(0);
  // Entering a non-edit mode folds both side panels for a full-bleed map.
  await expect(page.locator('.sidebar')).toHaveCount(0);
  await expect(page.locator('.inspector')).toHaveCount(0);
  await page.getByRole('button', { name: '3D', exact: true }).click();
  await page.screenshot({ path: testInfo.outputPath('imported-site.png') });

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Export project' }).click(),
  ]);
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
  const exported = JSON.parse(Buffer.concat(chunks).toString());
  expect(Object.keys(exported.embeddedAssets)).toHaveLength(1);
  expect(exported).not.toHaveProperty('statuses');
  await page.getByRole('button', { name: 'Show side panel' }).click();
  await page.getByRole('button', { name: 'All spaces', exact: true }).click();
  await page.reload();
  await page.locator('.home-row-main').first().click();
  await ready(page);
  expect((await savedProject(page)).drawings).toHaveLength(2);
  await page.getByRole('button', { name: 'All spaces', exact: true }).click();
  await page.locator('input[type=file]').setInputFiles({
    name: 'portable.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(exported)),
  });
  await ready(page);
  await expect(page.locator('.drawing-item')).toContainText('architect.png');
  expect(errors).toEqual([]);
});

test('drawing zones with holes, nested areas, fences and gates supports undo', async ({ page }) => {
  await page.goto('/app.html');
  await page.getByRole('button', { name: /New blank site/ }).click();
  await ready(page);
  await pickFloor(page, 'Outdoor site');
  const polygon = async (points: number[][]) => {
    await page.getByRole('button', { name: 'Zone polygon tool' }).click();
    for (const [x, y] of points) await clickAt(page, await canvasPoint(page, x, y));
    await page.keyboard.press('Enter');
  };
  await polygon([
    [0.15, 0.25],
    [0.85, 0.25],
    [0.85, 0.65],
    [0.15, 0.65],
  ]);
  await rename(page, 'Site perimeter');
  const parentId = (await savedProject(page)).objects[0].id;
  await page.getByRole('button', { name: 'All drawing tools' }).click();
  await page.getByRole('button', { name: 'Cut a hole', exact: true }).click();
  for (const [x, y] of [
    [0.2, 0.3],
    [0.3, 0.3],
    [0.3, 0.4],
    [0.2, 0.4],
  ])
    await clickAt(page, await canvasPoint(page, x, y));
  await page.keyboard.press('Enter');
  expect((await savedProject(page)).objects[0].rings).toHaveLength(2);
  await polygon([
    [0.55, 0.4],
    [0.75, 0.4],
    [0.75, 0.6],
    [0.55, 0.6],
  ]);
  await rename(page, 'Equipment storage');
  await page.getByLabel('Parent zone').selectOption(parentId);
  expect((await savedProject(page)).objects[1].parentId).toBe(parentId);
  await page.getByRole('button', { name: 'All drawing tools' }).click();
  await page.getByRole('button', { name: 'Fence', exact: true }).click();
  await clickAt(page, await canvasPoint(page, 0.15, 0.7));
  await clickAt(page, await canvasPoint(page, 0.85, 0.7));
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'All drawing tools' }).click();
  await page.getByRole('button', { name: 'Gate', exact: true }).click();
  await clickAt(page, await canvasPoint(page, 0.5, 0.7));
  expect((await savedProject(page)).objects.find(o => o.kind === 'gate')?.barrierId).toBeTruthy();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect((await savedProject(page)).objects.some(o => o.kind === 'gate')).toBe(false);
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  expect((await savedProject(page)).objects.some(o => o.kind === 'gate')).toBe(true);
});

test('save errors retain work and invalid imports do not replace the current project', async ({ page }) => {
  await page.goto('/app.html');
  await page.getByRole('button', { name: /New blank site/ }).click();
  await ready(page);
  const before = await savedProject(page);
  await importFile(page, 'invalid.json', 'application/json', Buffer.from('{"schemaVersion":999}'), 'Project');
  await expect(page.getByRole('alert')).toContainText('unsupported schema');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect((await savedProject(page)).id).toBe(before.id);
  await page.evaluate(() => {
    Storage.prototype.setItem = () => {
      throw new DOMException('Quota exceeded', 'QuotaExceededError');
    };
  });
  await page.getByRole('button', { name: 'Show properties panel', exact: true }).click();
  await page.getByRole('textbox', { name: 'Floor name', exact: true }).fill('Unsaved floor');
  await page.getByRole('textbox', { name: 'Floor name', exact: true }).press('Enter');
  await expect(page.locator('.save-status')).toContainText('Not saved');
  await page.getByRole('button', { name: 'All spaces', exact: true }).click();
  await expect(page.getByLabel('Active floor')).toBeVisible();
  await expect(page.getByLabel('Active floor')).toContainText('Unsaved floor');
  await expect(page.getByRole('button', { name: 'Export project' })).toBeEnabled();
});

test('floor geometry renders while the MML style and tiles are still pending', async ({ page }) => {
  let releaseStyle!: () => void;
  const pending = new Promise<void>(resolve => {
    releaseStyle = resolve;
  });
  await page.route('**/vectortiles/stylejson/**', async route => {
    await pending;
    await route.fulfill({
      json: {
        version: 8,
        sources: {
          pending: { type: 'raster', tiles: ['https://mml-test.invalid/pending-tiles/{z}/{x}/{y}.png'], tileSize: 256 },
        },
        layers: [{ id: 'pending-map', type: 'raster', source: 'pending' }],
      },
    });
  });
  await page.route('**/pending-tiles/**', () => {
    /* Deliberately leave external tiles pending. */
  });
  await page.goto('/app.html');
  await page.getByRole('button', { name: /Stockmann Helsinki.*Open/ }).click();
  await ready(page);
  await expect.poll(() => floorPixels(page)).toBeGreaterThan(1000);
  releaseStyle();
  await expect.poll(() => floorPixels(page)).toBeGreaterThan(1000);
  await page.getByRole('button', { name: 'Map settings' }).click();
  // The host supplies the MML basemap via adapters.basemap, so it selects as the 'host' option (labelled MML).
  await expect(page.getByLabel('Basemap')).toHaveValue('host');
  await page.getByLabel('Basemap').selectOption('plan');
  await expect.poll(() => floorPixels(page)).toBeGreaterThan(1000);
});

test('an unavailable MML style leaves the local floor model visible', async ({ page }) => {
  await page.route('**/vectortiles/stylejson/**', route => route.fulfill({ status: 503, body: 'Unavailable' }));
  await page.goto('/app.html');
  await page.getByRole('button', { name: /Stockmann Helsinki.*Open/ }).click();
  await ready(page);
  await expect(page.locator('.map-error')).toContainText('Basemap unavailable');
  await expect.poll(() => floorPixels(page)).toBeGreaterThan(1000);
});

test('indoor navigation: authored route, cross-floor directions and journey playback', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/app.html');
  await page.getByRole('button', { name: /Stockmann Helsinki.*Open/ }).click();
  await ready(page); // enters Plan editor

  // Route authoring: the Route tool chains nav nodes onto the current floor via map clicks.
  const before = (await savedProject(page)).navNodes?.length ?? 0;
  await page.getByRole('button', { name: 'Route path tool' }).click();
  await expect(page.locator('.tool-instruction')).toContainText('route node');
  await clickAt(page, await canvasPoint(page, 0.45, 0.5));
  await clickAt(page, await canvasPoint(page, 0.55, 0.55));
  await expect.poll(async () => (await savedProject(page)).navNodes?.length ?? 0).toBeGreaterThan(before);
  await page.keyboard.press('Escape');

  // Navigate panel: a cross-floor A→B route produces a multi-step, multi-floor direction list.
  await page.getByRole('button', { name: 'Show navigation panel' }).click();
  await page.getByRole('textbox', { name: 'From' }).fill('Main entrance');
  await page.locator('.place-option').first().click();
  await page.getByRole('textbox', { name: 'To' }).fill('buying & admin');
  await page.locator('.place-option').first().click();
  await expect(page.locator('.nav-step').first()).toBeVisible();
  const stepCount = await page.locator('.nav-step').count();
  expect(stepCount).toBeGreaterThan(2);
  // The route crosses floors, so at least one step names a lift or stairs ride.
  await expect(page.locator('.nav-steps')).toContainText(/Lift|stair|escalator/i);

  // Journey playback advances the active step and cancels cleanly without runtime errors.
  await page.getByRole('button', { name: /Play/ }).click();
  await page.waitForTimeout(2500);
  await expect(page.locator('.nav-step.active')).toBeVisible();
  await page.mouse.click((await canvasPoint(page, 0.5, 0.5)).x, (await canvasPoint(page, 0.5, 0.5)).y); // user gesture cancels
  await page.waitForTimeout(400);
  expect(errors).toEqual([]);
});

test('a floor can be deleted, taking its contents and leaving a loadable document', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/app.html');
  await page.getByRole('button', { name: /New blank site/ }).click();
  await ready(page);

  // Two floors, so one can go: duplicate the starting floor.
  await page.getByRole('button', { name: 'Structure', exact: true }).click();
  await page.getByRole('button', { name: 'Duplicate current floor' }).click();
  await expect(page.locator('.floor-item:not(.outdoor)')).toHaveCount(2);
  const doomed = (await page.getByRole('button', { name: 'Active floor' }).getAttribute('data-value'))!;

  await page.getByRole('button', { name: 'Show properties panel' }).click();
  await page.getByRole('button', { name: 'Delete this floor' }).click();
  await page.getByRole('button', { name: 'Delete floor', exact: true }).click();

  await expect(page.locator('.floor-item:not(.outdoor)')).toHaveCount(1);
  const after = await savedProject(page);
  expect(after.floors.some(f => f.id === doomed)).toBe(false);
  // Nothing may still point at the floor that went.
  for (const list of [after.objects, after.barriers, after.junctions, after.drawings])
    expect((list as { floorId: string | null }[]).some(x => x.floorId === doomed)).toBe(false);
  expect(errors).toEqual([]);
});

test('walls hold to the building axis, and the partition tool offers the wall a space is missing', async ({ page }) => {
  await page.goto('/app.html');
  await page.getByRole('button', { name: /New blank site/ }).click();
  await ready(page);
  await flatCamera(page);
  // A space wider than it is deep. Its long edges define the building's main axis; the wall it is
  // missing is the one that runs the short way across.
  await page.getByRole('button', { name: 'Zone polygon tool' }).click();
  for (const [x, y] of [
    [0.2, 0.3],
    [0.8, 0.3],
    [0.8, 0.6],
    [0.2, 0.6],
  ])
    await clickAt(page, await canvasPoint(page, x, y));
  await page.keyboard.press('Enter');

  const ends = (project: ProjectDocument, index: number) => {
    const wall = project.barriers[index];
    return [wall.startId, wall.endId].map(id => project.junctions.find(j => j.id === id)!.position);
  };
  // Aimed 6 px off level over a 600 px run — about half a degree, which nobody means.
  const start = await canvasPoint(page, 0.3, 0.4);
  await page.getByRole('button', { name: 'Wall tool' }).click();
  await clickAt(page, start);
  await page.mouse.move(start.x + 600, start.y + 6);
  await expect(page.locator('.tool-instruction')).toContainText('Parallel to building');
  await clickAt(page, { x: start.x + 600, y: start.y + 6 });
  await page.keyboard.press('Enter');
  const [held, heldTo] = ends(await savedProject(page), 0);
  expect(held[1], 'the drawn wall is exactly level, not half a degree off').toBe(heldTo[1]);

  // Aimed 90 px off over the same run — about 8.5°, which somebody does mean.
  const askew = await canvasPoint(page, 0.3, 0.5);
  await page.getByRole('button', { name: 'Wall tool' }).click();
  await clickAt(page, askew);
  await clickAt(page, { x: askew.x + 600, y: askew.y + 90 });
  await page.keyboard.press('Enter');
  const [free, freeTo] = ends(await savedProject(page), 1);
  expect(Math.abs(free[1] - freeTo[1]), 'a deliberate angle is left alone').toBeGreaterThan(1);

  await page.getByRole('button', { name: 'Partition tool' }).click();
  const inside = await canvasPoint(page, 0.6, 0.45);
  await page.mouse.move(inside.x, inside.y);
  await expect(page.locator('.tool-instruction')).toContainText('Click to build the wall shown');
  await clickAt(page, inside);
  const saved = await savedProject(page);
  const [a, b] = ends(saved, saved.barriers.length - 1);
  expect(Math.abs(a[0] - b[0]), 'the offered wall runs square across the space').toBeLessThan(0.02);
  expect(Math.abs(a[1] - b[1]), 'and spans it, rather than stopping at the pointer').toBeGreaterThan(1);
});

// The scoped reset (.kerros-root button { padding: 0 }) must not outrank the component rules layered
// over it. Written without :where() it scores (0,1,1) and beats every single-class rule, silently
// flattening cards and rows to bare text. Cheap to assert, and invisible until someone looks.
test('the scoped reset does not flatten padded buttons', async ({ page }) => {
  await page.goto('/app.html');
  const padded = async (selector: string) => {
    await expect(page.locator(selector).first()).toBeVisible();
    return page
      .locator(selector)
      .first()
      .evaluate(el => {
        const { paddingTop, paddingLeft } = getComputedStyle(el);
        return `${el.tagName} ${paddingTop} ${paddingLeft}`;
      });
  };
  expect(await padded('.home-card'), 'project cards keep their padding').not.toContain('0px 0px');
  await page.getByRole('button', { name: /New blank site/ }).click();
  await ready(page);
  expect(await padded('.back-link'), 'the back link keeps its padding').not.toContain('0px 0px');
});

// The structure panel is the only view of the parts of the model that have no shape — a zone
// spanning eleven floors cannot be checked by looking at the plan.
test('the structure panel browses zones, their spaces and the doors that bound them', async ({ page }) => {
  await page.goto('/app.html');
  await page
    .getByRole('button', { name: /Stockmann/ })
    .first()
    .click();
  await ready(page);
  await page.getByRole('button', { name: /structure panel/ }).click();
  const panel = page.locator('.structure-panel');
  await expect(panel).toBeVisible();
  // The demo's zones are derived, not authored: every lift and stair core becomes one circulation
  // zone over the landings that share a shaft.
  await expect(panel.locator('.structure-group h3').first()).toHaveText(/circulation/i);
  await expect(panel.getByRole('button', { name: /Lift A/ })).toBeVisible();

  await panel
    .getByRole('button', { name: /Lift A/ })
    .first()
    .click();
  const detail = panel.locator('.structure-detail');
  // A shaft whose landings swallowed their own lobbies would show no ways in at all — the zone
  // would be sealed by its own definition. This is the assertion that catches that.
  await expect(detail.locator('h4').first()).toContainText(/ways in/i);
  const ways = await detail.locator('h4').first().locator('xpath=following-sibling::ul[1]/li').count();
  expect(ways, 'the lift is entered from a lobby on each floor it serves').toBeGreaterThan(5);

  // Picking a space follows the plan to the floor it is on.
  await detail
    .getByRole('button', { name: /Lift A/ })
    .first()
    .click();
  await expect(page.locator('.floor-item.active:not(.outdoor)')).toBeVisible();
});

// Zones are the part of the ontology a person has to author — portals are read off the plan, but
// what counts as "Finance" is a decision. This goes through the same commit path as the map tools,
// so it has to land in the document and in history like anything else.
test('zones can be authored from the structure panel, and undone', async ({ page }) => {
  await page.goto('/app.html');
  await page.getByRole('button', { name: /New blank site/ }).click();
  await ready(page);
  await page.getByRole('button', { name: 'Zone polygon tool' }).click();
  for (const [x, y] of [
    [0.25, 0.3],
    [0.75, 0.3],
    [0.75, 0.65],
    [0.25, 0.65],
  ])
    await clickAt(page, await canvasPoint(page, x, y));
  await page.keyboard.press('Enter');
  await rename(page, 'Server room');

  await page.getByRole('button', { name: /structure panel/ }).click();
  const panel = page.locator('.structure-panel');
  await expect(panel.locator('.structure-empty'), 'a fresh plan has no ontology yet').toBeVisible();

  // The selected area becomes a zone.
  await panel.getByRole('button', { name: /New zone/ }).click();
  const saved = await savedProject(page);
  expect(saved.zones?.[0]?.name).toBe('Server room zone');
  expect(saved.zones?.[0]?.spaceIds).toEqual([saved.objects[0].id]);

  // Renaming writes through, and `connects` is a real schema value rather than a label.
  await panel.getByRole('button', { name: /Server room zone/ }).click();
  await panel.getByLabel('Zone name').fill('Finance');
  await panel.getByLabel('Connects').selectOption('adjacent');
  const edited = await savedProject(page);
  expect(edited.zones?.[0].name).toBe('Finance');
  expect(edited.zones?.[0].connects).toBe('adjacent');

  // And it is ordinary history, not a side channel.
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect((await savedProject(page)).zones?.[0].connects).toBeUndefined();
});

// Deleting an object that the ontology references used to produce an invalid document, so commit
// refused the whole change and the object stayed on the plan with no error shown — the worst way
// for a bug to present. The demo ships portals and zones, so this exercises the real cascade.
test('deleting a door that a portal points at actually deletes it', async ({ page }) => {
  await page.goto('/app.html');
  await page
    .getByRole('button', { name: /Stockmann/ })
    .first()
    .click();
  await ready(page);
  await pickFloor(page, /Offices · marketing/);

  const before = await savedProject(page);
  // A door whose name is unique in the document: core doors repeat their name on every floor they
  // serve, so picking one by name in the object list would select an arbitrary other instance.
  const named = new Map<string, number>();
  for (const o of before.objects) named.set(o.name, (named.get(o.name) ?? 0) + 1);
  const door = before.objects.find(
    o => o.kind === 'door' && named.get(o.name) === 1 && (before.portals ?? []).some(x => x.openingId === o.id),
  )!;
  expect(door, 'the demo has a uniquely named door with a portal on it').toBeTruthy();

  await page.getByRole('button', { name: 'Objects' }).first().click();
  await page.getByRole('textbox', { name: /Search/ }).fill(door.name);
  await page.locator('.object-row').filter({ hasText: door.name }).first().click();
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await page.getByRole('button', { name: 'Delete object', exact: true }).click();

  const after = await savedProject(page);
  expect(
    after.objects.some(o => o.id === door.id),
    'the door is gone',
  ).toBe(false);
  expect(
    (after.portals ?? []).some(x => x.openingId === door.id),
    'and so is its portal',
  ).toBe(false);
});

// Placing an opening used to be blind: you clicked at a wall you could only guess the edge of, and
// either it took or you got an error afterwards. The preview and the click now share one rule.
test('an opening previews on the wall it will land on', async ({ page }) => {
  await page.goto('/app.html');
  await page.getByRole('button', { name: /New blank site/ }).click();
  await ready(page);
  await flatCamera(page);
  await page.getByRole('button', { name: 'Wall tool' }).click();
  const a = await canvasPoint(page, 0.3, 0.45);
  const b = await canvasPoint(page, 0.7, 0.45);
  await clickAt(page, a);
  await clickAt(page, b);
  await page.keyboard.press('Enter');

  await page.getByRole('button', { name: 'Door tool' }).click();
  const guides = () =>
    page.evaluate(() => {
      const m = (window as unknown as { __kerrosMap?: { querySourceFeatures(id: string): unknown[] } }).__kerrosMap;
      return m ? m.querySourceFeatures('kerros-guide').length : -1;
    });
  // Well away from any wall: nothing to promise, so nothing is drawn.
  await page.mouse.move(a.x, a.y - 220);
  await expect.poll(guides, { message: 'no preview far from a wall' }).toBe(0);

  // Near the wall: the leaf appears on it before any click.
  await page.mouse.move((a.x + b.x) / 2, a.y - 10);
  await expect.poll(guides, { message: 'the leaf previews on the wall' }).toBeGreaterThan(0);

  // And the click lands where the preview said, rather than erroring.
  await clickAt(page, { x: (a.x + b.x) / 2, y: a.y - 10 });
  const saved = await savedProject(page);
  const door = saved.objects.find(o => o.kind === 'door');
  expect(door?.barrierId, 'the door attached to the wall it previewed on').toBe(saved.barriers[0].id);
});

// A wall across a space really divides it, and removing that wall has to ask what to do rather than
// silently leaving two rooms where there is now one, or silently destroying one of their identities.
test('a wall divides a space, and removing it asks how to rejoin', async ({ page }) => {
  await page.goto('/app.html');
  await page.getByRole('button', { name: /New blank site/ }).click();
  await ready(page);
  await flatCamera(page);
  await page.getByRole('button', { name: 'Zone polygon tool' }).click();
  for (const [x, y] of [
    [0.2, 0.3],
    [0.8, 0.3],
    [0.8, 0.7],
    [0.2, 0.7],
  ])
    await clickAt(page, await canvasPoint(page, x, y));
  await page.keyboard.press('Enter');
  await rename(page, 'Hall');
  expect(
    (await savedProject(page)).objects.filter(o => o.rings),
    'one space to begin with',
  ).toHaveLength(1);

  // A wall straight across it, overshooting both sides.
  await page.getByRole('button', { name: 'Wall tool' }).click();
  await clickAt(page, await canvasPoint(page, 0.5, 0.22));
  await clickAt(page, await canvasPoint(page, 0.5, 0.78));
  await page.keyboard.press('Enter');
  const split = await savedProject(page);
  expect(
    split.objects.filter(o => o.rings),
    'the wall divided the hall',
  ).toHaveLength(2);
  expect(split.barriers, 'and drew exactly one wall, not two').toHaveLength(1);

  // Removing that wall must ask, not decide.
  await page.getByRole('button', { name: 'Select tool' }).click();
  await clickAt(page, await canvasPoint(page, 0.5, 0.5));
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await page.getByRole('button', { name: 'Delete object', exact: true }).click();
  await expect(page.getByText('This wall was dividing two spaces')).toBeVisible();

  // Choosing to keep both leaves two spaces and no wall.
  await page.getByRole('button', { name: 'Keep both spaces' }).click();
  const kept = await savedProject(page);
  expect(kept.barriers).toHaveLength(0);
  expect(
    kept.objects.filter(o => o.rings),
    'both spaces survive',
  ).toHaveLength(2);
});
