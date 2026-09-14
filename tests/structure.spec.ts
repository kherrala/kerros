import { expect, test } from '@playwright/test';
import { addFloor, addPortal, addSpace, addTestZone, newProject } from '../src/model/testFixtures';
import { validateProject } from '../src/schema';

test('structure exposes ungrouped spaces, all portals, nested zones and the routing topology', async ({
  page,
}, info) => {
  const project = newProject('Structure review');
  addFloor(project, 'upper', 3);
  addSpace(project, 'Lobby', 'floor-ground', [0, 0]);
  addSpace(project, 'Upper office', 'upper', [0, 0]);
  addSpace(project, 'Isolated store', 'floor-ground', [8, 0]);
  for (let i = 0; i < 53; i++) {
    addSpace(project, `Suite ${i + 1}`, 'floor-ground', [16 + (i % 10) * 6, Math.floor(i / 10) * 6]);
    addPortal(project, 'Lobby', `Suite ${i + 1}`, { name: `Passage ${i + 1}`, passage: i === 0 ? 'a-to-b' : 'both' });
  }
  const child = addTestZone(project, 'Private suite', ['Suite 1'], { purpose: 'security' });
  addTestZone(project, 'Office tenant', ['Upper office'], { childZoneIds: [child.id], purpose: 'tenant' });
  project.portalGroups = [{ id: 'group-main', name: 'Reception access', portalIds: [project.portals![0].id] }];
  validateProject(project);
  await page.route('**/vectortiles/stylejson/**', route =>
    route.fulfill({ json: { version: 8, sources: {}, layers: [] } }),
  );
  await page.goto('/app.html');
  await page.getByRole('button', { name: /New blank site/ }).click();
  await expect(page.locator('.map-wrap')).toHaveAttribute('data-frame', 'ready');
  await page.getByRole('button', { name: 'Import reference drawing', exact: true }).click();
  const modal = page.getByRole('dialog');
  await modal.getByRole('button', { name: 'Project', exact: true }).click();
  await modal.locator('input[type=file]').setInputFiles({
    name: 'structure.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(project)),
  });
  await modal.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(modal).not.toBeVisible();
  await page.getByRole('button', { name: 'Show structure panel', exact: true }).click();
  const panel = page.locator('.structure-panel');
  await expect(panel.getByRole('tab', { name: 'Spaces', exact: true })).toHaveAttribute('aria-selected', 'true');
  await panel.getByLabel('Search structure').fill('Isolated store');
  await panel.locator('.structure-record > summary').click();
  await expect(panel).toContainText('Not grouped into a zone');
  await panel.getByLabel('Search structure').fill('Upper office');
  await panel.locator('.structure-record > summary').click();
  await panel.getByRole('button', { name: 'Find Upper office on map', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Active floor', exact: true })).toHaveAttribute('data-value', 'upper');
  await panel.getByLabel('Search structure').fill('');
  await panel.getByRole('tab', { name: 'Zones', exact: true }).click();
  await panel.getByRole('button', { name: /^Office tenant/ }).click();
  await expect(panel).toContainText('Contains zones: Private suite');
  await expect(panel.locator('.structure-detail')).toContainText('Suite 1');
  await panel.screenshot({ path: info.outputPath('structure-zones-expanded.png') });
  await panel.getByRole('tab', { name: 'Portals', exact: true }).click();
  await expect(panel.locator('.structure-record')).toHaveCount(50);
  await panel.locator('.structure-load-more').scrollIntoViewIfNeeded();
  await expect(panel.locator('.structure-record')).toHaveCount(53);
  await expect(panel.getByLabel('Portal group', { exact: true })).not.toBeVisible();
  await panel.getByRole('button', { name: 'Filter by portal group', exact: true }).click();
  await panel.getByLabel('Portal group', { exact: true }).selectOption('group-main');
  await expect(panel.locator('.structure-record')).toHaveCount(1);
  await panel.locator('.structure-record > summary').click();
  await expect(panel.locator('.structure-connection')).toContainText('Lobby→Suite 1');
  await panel.screenshot({ path: info.outputPath('structure-portals.png') });
  await panel.getByRole('tab', { name: 'Topology', exact: true }).click();
  await panel.getByLabel('Search structure').fill('Lobby');
  await panel.locator('.structure-record > summary').click();
  await expect(panel).toContainText('→ outgoing');
  await panel.screenshot({ path: info.outputPath('structure-topology-expanded.png') });
  await panel.getByLabel('Search structure').fill('');
  await panel.getByRole('checkbox', { name: /Only isolated nodes/ }).check();
  await expect(panel.locator('.structure-record')).toHaveCount(2);
  await panel.getByLabel('Structure floor').selectOption('upper');
  await expect(panel.locator('.structure-record')).toHaveCount(1);
  await expect(panel.locator('.structure-record')).toContainText('Upper office');
  await panel.screenshot({ path: info.outputPath('structure-topology.png') });
  await panel.getByRole('button', { name: 'Open graph view', exact: true }).click();
  const graph = page.getByRole('region', { name: 'Navigation graph view' });
  await expect(graph).toBeVisible();
  await expect(page.getByTestId('map-canvas')).not.toBeVisible();
  await expect(graph.getByRole('img', { name: /Navigation graph with/ })).toHaveAttribute(
    'aria-label',
    'Navigation graph with 1 nodes and 0 edges',
  );
  await graph.getByLabel('Graph floor', { exact: true }).selectOption('all');
  await expect(graph.getByRole('img', { name: /Navigation graph with/ })).toHaveAttribute(
    'aria-label',
    'Navigation graph with 56 nodes and 53 edges',
  );
  await graph.getByRole('checkbox', { name: 'Auto balance', exact: true }).uncheck();
  await expect(graph).toContainText('Layout paused');
  await graph.getByRole('button', { name: 'Fit graph', exact: true }).click();
  await graph.screenshot({ path: info.outputPath('navigation-graph.png') });
  await graph.getByLabel('Search graph nodes').fill('Upper office');
  await graph.getByLabel('Graph node', { exact: true }).selectOption('space:Upper office');
  await graph.getByRole('button', { name: 'Find node on map', exact: true }).click();
  await expect(graph).not.toBeVisible();
  await expect(page.getByTestId('map-canvas')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Active floor', exact: true })).toHaveAttribute('data-value', 'upper');
});
