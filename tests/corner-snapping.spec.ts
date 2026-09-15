import { expect, test, type Page } from '@playwright/test';
import {
  addBarrier,
  addVirtualBoundary,
  boundaryEdges,
  closeRing,
  createObject,
  distance,
  openRing,
  rotate,
  toLngLat,
  validateProject,
  type Point,
  type ProjectDocument,
} from '../src/schema';
import { encloseRoom } from '../src/model/authoring';
import { newProject } from '../src/model/testFixtures';

async function savedProject(page: Page, id: string): Promise<ProjectDocument> {
  return page.evaluate(
    id =>
      new Promise<ProjectDocument>((resolve, reject) => {
        const open = indexedDB.open('kerros-projects', 1);
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const read = db.transaction('projects').objectStore('projects').get(id);
          read.onsuccess = () => {
            db.close();
            resolve(read.result);
          };
          read.onerror = () => {
            db.close();
            reject(read.error);
          };
        };
      }),
    id,
  );
}

for (const mode of ['wall', 'virtual', 'independent'] as const) {
  test(`${mode} rectangle corner snaps back after deforming and keeps the preview through save`, async ({
    page,
  }, info) => {
    const project = newProject(`Corner snapping ${mode}`);
    const floorId = project.floors[0].id;
    const at = (x: number, y: number): Point => rotate([x + 0.13, y + 0.27], 17);
    const corners = [at(0, 0), at(6.37, 0), at(6.37, 4.82), at(0, 4.82)];
    let room;
    if (mode === 'independent') {
      room = createObject('room', at(3, 2), floorId, 'Rectangle');
      room.rings = [closeRing(corners)];
      room.geometry = { mode: 'independent' };
      project.objects.push(room);
    } else {
      for (let i = 0; i < 4; i++) {
        if (mode === 'wall') addBarrier(project, corners[i], corners[(i + 1) % 4], floorId, 'wall');
        else addVirtualBoundary(project, floorId, corners[i], corners[(i + 1) % 4]);
      }
      room = encloseRoom(project, floorId, at(3, 2))!.room;
    }
    validateProject(project);
    const roomId = room.id;
    const junctionId = project.junctions.find(j => distance(j.position, corners[2]) < 1e-8)?.id;
    const position = (p: ProjectDocument): Point =>
      mode === 'independent'
        ? openRing(p.objects.find(o => o.id === roomId)!.rings![0])[2]
        : p.junctions.find(j => j.id === junctionId)!.position;
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/vectortiles/stylejson/**', route =>
      route.fulfill({
        json: {
          version: 8,
          sources: {},
          layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#e6e8e4' } }],
        },
      }),
    );
    await page.addInitScript(p => localStorage.setItem(`kerros:project:${p.id}`, JSON.stringify(p)), project);
    await page.goto('/app.html');
    await page.getByRole('button', { name: new RegExp(`^Corner snapping ${mode}`) }).click();
    await expect(page.locator('.map-wrap')).toHaveAttribute('data-frame', 'ready');
    await page.getByRole('button', { name: 'Plan editor', exact: true }).click();
    await page.getByRole('button', { name: '2D', exact: true }).click();
    await page.evaluate(
      center => (window as any).__kerrosMap.jumpTo({ center, zoom: 22, pitch: 0, bearing: 0 }),
      toLngLat(at(3.2, 2.4), project.origin),
    );
    await page.waitForFunction(
      () => !(window as any).__kerrosMap.isMoving() && (window as any).__kerrosMap.getPitch() < 0.01,
    );
    const selection = await page.evaluate(
      ll => {
        const map = (window as any).__kerrosMap;
        const point = map.project(ll),
          box = map.getContainer().getBoundingClientRect();
        return { x: point.x + box.left, y: point.y + box.top };
      },
      toLngLat(at(3, 2), project.origin),
    );
    await page.mouse.click(selection.x, selection.y);
    const handles = page.getByRole('button', {
      name: mode === 'independent' ? /^Move vertex / : /^Move space boundary corner /,
    });
    await expect(handles).toHaveCount(4);
    const world = async (index: number): Promise<Point> => [
      Number(await handles.nth(index).getAttribute('data-wx')),
      Number(await handles.nth(index).getAttribute('data-wy')),
    ];
    const points = await Promise.all([0, 1, 2, 3].map(world));
    const index = points.findIndex(point => distance(point, corners[2]) < 1e-8);
    expect(index).toBeGreaterThanOrEqual(0);
    const handle = handles.nth(index);
    const move = async (point: Point) => {
      const box = (await handle.boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      const destination = await page.evaluate(
        ll => {
          const map = (window as any).__kerrosMap;
          const point = map.project(ll),
            box = map.getContainer().getBoundingClientRect();
          return { x: point.x + box.left, y: point.y + box.top };
        },
        toLngLat(point, project.origin),
      );
      await page.mouse.move(destination.x, destination.y, { steps: 5 });
    };
    const distorted = at(7.1, 3.9);
    await page.keyboard.down('Shift');
    await move(distorted);
    await page.mouse.up();
    await page.keyboard.up('Shift');
    await expect
      .poll(async () => distance(position(await savedProject(page, project.id)), distorted))
      .toBeLessThan(1e-5);
    const before = await savedProject(page, project.id);

    await move(at(6.4, 4.86));
    await expect.poll(async () => distance(await world(index), corners[2])).toBeLessThan(1e-6);
    const preview = await world(index);
    expect(await savedProject(page, project.id)).toEqual(before);
    await page.screenshot({ path: info.outputPath('rectangle-corner-preview.png') });
    await page.mouse.up();
    await expect.poll(async () => distance(position(await savedProject(page, project.id)), preview)).toBeLessThan(1e-6);
    const restored = await savedProject(page, project.id);
    expect(() => validateProject(restored)).not.toThrow();
    expect(boundaryEdges(restored)).toHaveLength(mode === 'independent' ? 0 : 4);
    await page.screenshot({ path: info.outputPath('rectangle-corner-restored.png') });

    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect
      .poll(async () => distance(position(await savedProject(page, project.id)), distorted))
      .toBeLessThan(1e-5);
    await page.getByRole('button', { name: 'Redo', exact: true }).click();
    await expect.poll(async () => distance(position(await savedProject(page, project.id)), preview)).toBeLessThan(1e-6);
    await page.reload();
    await expect(page.locator('.map-wrap')).toHaveAttribute('data-frame', 'ready');
    expect(distance(position(await savedProject(page, project.id)), preview)).toBeLessThan(1e-6);
    expect(errors).toEqual([]);
  });
}
