import { expect, test, type Page } from '@playwright/test';
import type { Map } from 'maplibre-gl';
import {
  addBarrier,
  boundaryEdges,
  createObject,
  toLngLat,
  validateProject,
  type Point,
  type ProjectDocument,
} from '../src/schema';
import { newProject } from '../src/model/testFixtures';

async function openEditor(page: Page, project: ProjectDocument) {
  await page.route('**/vectortiles/stylejson/**', route =>
    route.fulfill({
      json: { version: 8, sources: {}, layers: [{ id: 'background', type: 'background' }] },
    }),
  );
  await page.addInitScript(p => localStorage.setItem('kerros:project:' + p.id, JSON.stringify(p)), project);
  await page.goto('/app.html');
  await page.getByRole('button', { name: new RegExp('^' + project.name) }).click();
  await expect(page.locator('.map-wrap')).toHaveAttribute('data-frame', 'ready');
  await page.getByRole('button', { name: 'Plan editor', exact: true }).click();
  await page.evaluate(
    center => {
      const map = (window as unknown as { __kerrosMap: Map }).__kerrosMap;
      map.jumpTo({ center, zoom: 21.5, pitch: 0, bearing: 0 });
    },
    toLngLat([4, 3], project.origin),
  );
  await page.waitForFunction(() => !(window as unknown as { __kerrosMap: Map }).__kerrosMap.isMoving());
}

async function clickPoint(page: Page, project: ProjectDocument, point: Point) {
  const at = await page.evaluate(
    ll => {
      const map = (window as unknown as { __kerrosMap: Map }).__kerrosMap;
      const p = map.project(ll),
        box = map.getContainer().getBoundingClientRect();
      return { x: p.x + box.left, y: p.y + box.top };
    },
    toLngLat(point, project.origin),
  );
  await page.mouse.click(at.x, at.y);
}

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

for (const tool of ['Wall', 'Fence', 'Virtual boundary']) {
  test(
    tool + ' finishes a closed outline without Enter and leaves subsequent clicks in selection mode',
    async ({ page }) => {
      const project = newProject('Closing outline');
      await openEditor(page, project);
      if (tool === 'Wall') await page.getByRole('button', { name: 'Wall tool', exact: true }).click();
      else {
        await page.getByRole('button', { name: 'All drawing tools' }).click();
        await page.getByRole('button', { name: tool, exact: true }).click();
      }
      for (const point of [
        [0, 0],
        [8, 0],
        [8, 6],
        [0, 6],
      ] as Point[]) {
        await clickPoint(page, project, point);
        await expect(page.locator('.tool-instruction')).toBeVisible();
      }
      await clickPoint(page, project, [0, 0]);
      await expect(page.locator('.tool-instruction')).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Select tool', exact: true })).toHaveClass('active');
      await expect.poll(async () => boundaryEdges(await savedProject(page, project.id)).length).toBe(4);
      await clickPoint(page, project, [4, 3]);
      await expect(page.locator('.tool-instruction')).toHaveCount(0);
      expect(boundaryEdges(await savedProject(page, project.id))).toHaveLength(4);
      await page.keyboard.press('ControlOrMeta+z');
      await expect.poll(async () => boundaryEdges(await savedProject(page, project.id)).length).toBe(3);
      await page.keyboard.press('ControlOrMeta+Shift+z');
      await expect.poll(async () => boundaryEdges(await savedProject(page, project.id)).length).toBe(4);
      validateProject(await savedProject(page, project.id));
    },
  );
}

test('a wall may start on a barrier and finishes when its final point joins the middle of that barrier', async ({
  page,
}) => {
  const project = newProject('Joining a fence');
  addBarrier(project, [0, 6], [8, 6], project.floors[0].id, 'fence');
  await openEditor(page, project);
  await page.getByRole('button', { name: 'Wall tool', exact: true }).click();
  await clickPoint(page, project, [0, 6]);
  await clickPoint(page, project, [0, 0]);
  await expect(page.locator('.tool-instruction')).toBeVisible();
  await clickPoint(page, project, [6, 6]);
  await expect(page.locator('.tool-instruction')).toHaveCount(0);
  await expect.poll(async () => (await savedProject(page, project.id)).barriers.length).toBe(4);
  validateProject(await savedProject(page, project.id));
});

test('a refused connection through a door keeps the last point active until a valid connection is accepted', async ({
  page,
}) => {
  const project = newProject('Correcting a connection');
  const floor = project.floors[0].id;
  const wall = addBarrier(project, [0, 6], [8, 6], floor, 'wall')!;
  const door = createObject('door', [4, 6], floor);
  Object.assign(door, { barrierId: wall.id, offset: 4, width: 1 });
  project.objects.push(door);
  await openEditor(page, project);
  await page.getByRole('button', { name: 'Wall tool', exact: true }).click();
  await clickPoint(page, project, [4, 0]);
  await clickPoint(page, project, [4, 6]);
  await expect(page.getByRole('status')).toContainText('A junction cannot split an opening');
  await expect(page.locator('.tool-instruction')).toBeVisible();
  expect((await savedProject(page, project.id)).barriers).toHaveLength(1);
  await clickPoint(page, project, [2, 6]);
  await expect(page.locator('.tool-instruction')).toHaveCount(0);
  await expect.poll(async () => (await savedProject(page, project.id)).barriers.length).toBe(3);
  validateProject(await savedProject(page, project.id));
});
