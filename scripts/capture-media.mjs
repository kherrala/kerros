// Record real editor interactions for the homepage. Requires .env.local (MML) and ffmpeg.
// npm run capture:media [-- manual|building|backrooms]
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MEDIA = join(ROOT, 'docs/public/media');
const APP = 'http://127.0.0.1:5183';
const SIZE = { width: 1600, height: 1000 };
const requested = process.argv.slice(2);
const want = name => !requested.length || requested.includes(name);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const server = spawn('npm', ['run', 'dev', '--', '--port', '5183', '--strictPort'], {
  cwd: ROOT,
  env: process.env,
  stdio: 'ignore',
  detached: true,
});
let browser;
const diagnostics = await mkdtemp(join(tmpdir(), 'kerros-captures-'));
console.log(`Capture diagnostics: ${diagnostics}`);
async function waitForServer() {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${APP}/app.html`)).ok) return;
    } catch {
      /* server starting */
    }
    await sleep(400);
  }
  throw new Error('Capture server did not start.');
}
async function ready(page, tiles = false) {
  await expect(page.locator('.map-wrap')).toHaveAttribute('data-frame', 'ready');
  await page.waitForFunction(tiles => {
    const m = window.__kerrosMap;
    return m && !m.isMoving() && (!tiles || m.areTilesLoaded());
  }, tiles);
  await page.waitForTimeout(600);
}
async function floor(page, name) {
  await page.getByRole('button', { name: 'Active floor' }).click();
  await page.locator('.place-option').filter({ hasText: name }).first().click();
  await ready(page);
}
async function clickAt(page, local) {
  const p = await screen(page, local);
  await page.mouse.move(p.x, p.y, { steps: 12 });
  await page.waitForTimeout(240);
  await page.mouse.click(p.x, p.y);
  await page.waitForTimeout(350);
}
async function screen(page, local) {
  return page.evaluate(async local => {
    const { toLngLat } = await import('/src/model/geometry.ts');
    const m = window.__kerrosMap,
      p = m.project(toLngLat(local, window.__captureOrigin ?? [24.946, 60.185]));
    const b = m.getContainer().getBoundingClientRect();
    return { x: p.x + b.left, y: p.y + b.top };
  }, local);
}
async function drag(page, handle, destination) {
  const b = await handle.boundingBox(),
    p = await screen(page, destination);
  const from = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  await page.mouse.move(from.x, from.y, { steps: 12 });
  await page.mouse.down();
  for (let i = 1; i <= 32; i++) {
    await page.mouse.move(from.x + ((p.x - from.x) * i) / 32, from.y + ((p.y - from.y) * i) / 32);
    await page.waitForTimeout(25);
  }
  await page.waitForTimeout(400);
  await page.mouse.up();
  await page.waitForTimeout(650);
}
async function name(page, value) {
  const field = page.getByRole('textbox', { name: 'Name', exact: true });
  await field.fill(value);
  await field.press('Enter');
  await page.waitForTimeout(400);
}
async function walk(page, keys, ms) {
  for (const key of keys) await page.keyboard.down(key);
  await page.waitForTimeout(ms);
  for (const key of keys) await page.keyboard.up(key);
}
async function record(name, action) {
  const dir = await mkdtemp(join(tmpdir(), `kerros-${name}-`));
  const context = await browser.newContext({
    viewport: SIZE,
    recordVideo: { dir, size: SIZE },
    reducedMotion: 'no-preference',
  });
  // A cursor recorded inside the page makes the actual mouse gestures legible in headless capture.
  await context.addInitScript(() => {
    localStorage.setItem('kerros:dark', '0');
    document.addEventListener('DOMContentLoaded', () => {
      const dot = document.createElement('div');
      Object.assign(dot.style, {
        position: 'fixed',
        width: '17px',
        height: '17px',
        border: '2px solid #6557e8',
        borderRadius: '50%',
        background: '#ffffffa0',
        pointerEvents: 'none',
        zIndex: '999999',
        transform: 'translate(-50%,-50%)',
        left: '-50px',
      });
      document.body.append(dot);
      document.addEventListener('pointermove', e => {
        dot.style.left = `${e.clientX}px`;
        dot.style.top = `${e.clientY}px`;
      });
      document.addEventListener('pointerdown', () => {
        dot.style.background = '#6557e8';
      });
      document.addEventListener('pointerup', () => {
        dot.style.background = '#ffffffa0';
      });
    });
  });
  const started = Date.now(),
    page = await context.newPage();
  page.setDefaultTimeout(60000);
  const failures = [];
  page.on('pageerror', error => failures.push(error.message));
  const phases = [];
  const shot = async (label, fn, hold = 700, speed = 1) => {
    console.log(`${name}: ${label}`);
    const start = (Date.now() - started) / 1000;
    await page.waitForTimeout(350);
    await fn();
    await page.waitForTimeout(hold);
    phases.push({ start, end: (Date.now() - started) / 1000, speed, label });
  };
  try {
    await action(page, shot);
    if (failures.length) throw new Error(`Runtime error during capture: ${failures.join('; ')}`);
    await page.screenshot({ path: join(diagnostics, `${name}-final.png`) });
    const source = await page.video().path();
    await context.close();
    await encode(source, name, phases, dir);
    await rm(dir, { recursive: true, force: true });
  } catch (error) {
    await page.screenshot({ path: join(diagnostics, `${name}-failure.png`) }).catch(() => {});
    await writeFile(
      join(diagnostics, `${name}-failure.txt`),
      await page
        .locator('body')
        .innerText()
        .catch(() => ''),
    );
    await context.close();
    throw error;
  }
}
async function manual(page, shot) {
  await page.goto(`${APP}/app.html`);
  await page.getByRole('button', { name: /New blank site/ }).click();
  await ready(page);
  await page.getByRole('button', { name: 'Plan editor', exact: true }).click();
  await page.evaluate(() => window.__kerrosMap.jumpTo({ center: [24.946, 60.185], zoom: 18.5, pitch: 0, bearing: 0 }));
  await ready(page, true);
  // Do not substitute mock map data: the first clip must actually show MML cadastral geometry.
  await page.waitForFunction(() => {
    const m = window.__kerrosMap;
    return (
      m.getSource('kerros-cadastre') &&
      m.querySourceFeatures('kerros-cadastre', { sourceLayer: 'KiinteistorajanSijaintitiedot' }).length > 0
    );
  });
  await shot(
    'Start on the MML map, with cadastral boundaries visible.',
    async () => {
      await page.waitForTimeout(1500);
      await page.evaluate(() => window.__kerrosMap.easeTo({ zoom: 19.8, duration: 1600 }));
      await ready(page, true);
    },
    1000,
  );
  await shot('Draw the outer walls. Geometry and angle snapping keep the corners connected.', async () => {
    await page.getByRole('button', { name: 'Wall tool', exact: true }).click();
    for (const p of [
      [-12, -8],
      [12, -8],
      [12, 8],
      [-12, 8],
      [-12, -8],
    ])
      await clickAt(page, p);
    await page.keyboard.press('Enter');
  });
  await shot('Create a room directly from its enclosing walls.', async () => {
    await page.getByRole('button', { name: 'Space from walls tool', exact: true }).click();
    await clickAt(page, [0, 0]);
    await name(page, 'Ground floor studio');
  });
  await shot('Draw a shared partition to divide the floor into two rooms.', async () => {
    await page.getByRole('button', { name: 'Wall tool', exact: true }).click();
    await clickAt(page, [0, -8]);
    await clickAt(page, [0, 8]);
    await page.keyboard.press('Enter');
    await page.keyboard.press('Escape');
    await clickAt(page, [-6, 0]);
    await name(page, 'Reception');
    await clickAt(page, [6, 0]);
    await name(page, 'Workspace');
  });
  await shot('Move the shared wall. Both room outlines and areas update together.', async () => {
    await clickAt(page, [0, 4]);
    await drag(page, page.getByRole('button', { name: 'Move whole wall', exact: true }), [2, 0]);
  });
  await shot(
    'Set door handing and opening side, or choose a sliding door.',
    async () => {
      await page.getByRole('button', { name: 'Door tool', exact: true }).click();
      await clickAt(page, [2, 0]);
      await page.keyboard.press('Escape');
      await clickAt(page, [2, 0]);
      await drag(page, page.getByRole('button', { name: 'Slide along the wall', exact: true }), [4, 1]);
      await page.getByRole('combobox', { name: 'Door hinge' }).selectOption('right');
      await page.waitForTimeout(700);
      await page.getByRole('combobox', { name: 'Door type' }).selectOption('sliding');
      await page.waitForTimeout(1000);
      await page.getByRole('combobox', { name: 'Door type' }).selectOption('hinged');
    },
    1700,
  );
  const properties = page.getByRole('button', { name: 'Hide properties panel' });
  if (await properties.count()) await properties.click();
  await shot(
    'The finished floor plan remains connected and editable.',
    async () => {
      await page.keyboard.press('Escape');
    },
    1400,
  );
}
async function building(page, shot) {
  await page.goto(`${APP}/app.html`);
  await page.getByRole('button', { name: /Stockmann Helsinki.*Open/ }).click();
  await ready(page, true);
  await page.getByRole('button', { name: 'Map settings', exact: true }).click();
  await page.getByRole('radio', { name: 'Day', exact: true }).click();
  await page.getByRole('button', { name: 'Close map settings', exact: true }).click();
  await page.getByRole('button', { name: '3D', exact: true }).click();
  await page.getByRole('button', { name: 'Fit floor', exact: true }).click();
  await ready(page);
  await shot(
    'Rotate a 3D cutaway of Stockmann in its real Helsinki setting.',
    async () => {
      const box = await page.getByTestId('map-canvas').boundingBox();
      const x = box.x + box.width * 0.57,
        y = box.y + box.height * 0.62;
      await page.mouse.move(x, y);
      await page.mouse.down({ button: 'right' });
      for (let i = 1; i <= 65; i++) {
        await page.mouse.move(x + i * 4, y - i * 0.65);
        await page.waitForTimeout(28);
      }
      await page.mouse.up({ button: 'right' });
    },
    1400,
  );
  await shot(
    'Switch floors to reveal a different part of the building.',
    async () => {
      await floor(page, 'Womenswear');
      await page.waitForTimeout(800);
      await floor(page, 'Beauty & cosmetics');
    },
    1300,
  );
  await shot(
    'Inspect the full building stack, then return to a floor cutaway.',
    async () => {
      await page.locator('.stack-button').click();
      await page.waitForTimeout(2000);
      await page.locator('.stack-button').click();
      await page.waitForTimeout(800);
    },
    600,
  );
  // Stage the next shot at a real landing. The call is allowed to finish before recording boarding.
  await page.getByRole('button', { name: 'Walk', exact: true }).click();
  await page.evaluate(() => {
    const w = window.__kerrosWalk;
    w.pitch = 83;
    w.place([23, 2.4], 180);
  });
  await page.getByRole('button', { name: 'Elevator controls' }).click();
  const panel = page.getByRole('complementary', { name: 'Elevator controls' });
  await panel.getByRole('combobox', { name: 'Choose elevator' }).selectOption({ label: 'Lift A' });
  await panel.getByRole('button', { name: 'Call to this floor' }).click();
  await expect(panel.getByRole('button', { name: 'Enter elevator', exact: true })).toBeEnabled({ timeout: 60000 });
  await shot(
    'Enter the elevator. Its live mirror reflects your avatar.',
    async () => {
      await panel.getByRole('button', { name: 'Enter elevator', exact: true }).click();
      await panel.getByRole('button', { name: 'Look in mirror' }).click();
      await page.waitForTimeout(900);
      await panel.getByRole('button', { name: 'Wave', exact: true }).click();
    },
    1400,
  );
  await shot(
    'Choose a destination. Doors close before travel and open on arrival.',
    async () => {
      await panel.getByRole('button', { name: /2 · Womenswear/ }).click();
      await expect(panel.getByRole('button', { name: 'Exit elevator', exact: true })).toBeEnabled({ timeout: 60000 });
    },
    700,
  );
  await shot(
    'Step onto the destination floor.',
    async () => {
      await panel.getByRole('button', { name: 'Exit elevator', exact: true }).click();
      await page.getByRole('button', { name: 'Elevator controls' }).click();
      await walk(page, ['KeyW'], 1100);
      await walk(page, ['KeyD'], 450);
    },
    1200,
  );
}
async function backrooms(page, shot) {
  await page.goto(`${APP}/app.html`);
  await page.getByRole('button', { name: 'Open offices', exact: true }).click();
  await ready(page);
  await floor(page, 'Deep bath chambers');
  // The map's initial ready signal precedes the lazy Three.js scene and shader compilation.
  await page.waitForFunction(() => {
    const layer = window.__kerrosMap?.getLayer('kerros-3d')?.implementation;
    return layer?.walking && layer?.renderer?.info.render.calls > 0 &&
      layer.activeFloor === 'backrooms-pool-1' && window.__kerrosWalk;
  });
  await page.waitForTimeout(6000);
  await page.evaluate(() => {
    const l = window.__kerrosMap.getLayer('kerros-3d').implementation;
    const pool = l.project.objects.find(o => o.floorId === 'backrooms-pool-1' && o.water);
    const w = window.__kerrosWalk;
    w.pitch = 82;
    w.place([pool.position[0], Math.min(...pool.rings[0].map(p => p[1])) - 1.1], 0);
  });
  await page.waitForTimeout(1000);
  await page.screenshot({ path: join(diagnostics, 'backrooms-route-start.png') });
  await shot(
    'Begin in the deep baths: tiled rooms, clear water and blue underwater light.',
    async () => {
      await walk(page, ['KeyD'], 500);
      await walk(page, ['KeyE'], 1000);
      await walk(page, ['KeyA'], 450);
    },
    900,
  );
  await shot(
    'Choose the office landing upstairs and inspect the cross-floor route.',
    async () => {
      await page.getByRole('button', { name: 'Show navigation panel' }).click();
      await page.getByRole('textbox', { name: 'To', exact: true }).fill('Stair landing');
      await page.locator('.place-option').filter({ hasText: 'Yellow offices' }).first().click();
      await expect(page.locator('.nav-step').first()).toBeVisible();
    },
    1500,
  );
  await shot(
    'Follow the route from the pool: call the lift, wait, board and ride to the offices.',
    async () => {
      await page.getByRole('button', { name: /Play/ }).click();
      await expect(page.getByRole('button', { name: 'Active floor' })).toContainText('Yellow offices', {
        timeout: 90000,
      });
      await expect(page.getByRole('button', { name: 'Play route', exact: true })).toBeVisible({ timeout: 60000 });
      await expect(page.locator('.walk-status')).toContainText('Arrived');
      await page.waitForTimeout(1000);
    },
    1000,
  );
  const pause = page.getByRole('button', { name: /Pause/ });
  if (await pause.count()) await pause.click();
  await page.getByRole('button', { name: 'Clear route', exact: true }).click();
  await page.getByRole('button', { name: 'Close navigation' }).click();
  await shot(
    'Continue on foot through the yellow offices at eye level.',
    async () => {
      await walk(page, ['KeyW'], 1600);
      await walk(page, ['KeyD'], 480);
      await walk(page, ['KeyW'], 1000);
    },
    1600,
  );
  await shot(
    'Switch levels to explore another pool in the endless baths.',
    async () => {
      await floor(page, 'The endless baths');
      await page.evaluate(() => {
        const l = window.__kerrosMap.getLayer('kerros-3d').implementation;
        const pool = l.project.objects.find(o => o.floorId === 'backrooms-pool-0' && o.water);
        const w = window.__kerrosWalk;
        w.pitch = 82;
        w.place([pool.position[0], Math.min(...pool.rings[0].map(p => p[1])) - 1.1], 0);
      });
      await walk(page, ['KeyE'], 1000);
      await walk(page, ['KeyD'], 420);
    },
    1500,
  );
}
function ffmpeg(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', ...args], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let error = '';
    child.stderr.on('data', b => (error += b));
    child.on('exit', code => (code === 0 ? resolve() : reject(new Error(`Encoding failed: ${error.slice(-1500)}`))));
  });
}
const timestamp = seconds => {
  const ms = Math.round(seconds * 1000);
  return `${String(Math.floor(ms / 3600000)).padStart(2, '0')}:${String(Math.floor(ms / 60000) % 60).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`;
};
async function encode(source, name, phases, dir) {
  const files = [],
    captions = ['WEBVTT\n'];
  let duration = 0;
  for (const [i, p] of phases.entries()) {
    const file = join(dir, `part-${i}.mp4`);
    files.push(file);
    await ffmpeg([
      '-ss',
      String(p.start),
      '-t',
      String(p.end - p.start),
      '-i',
      source,
      '-vf',
      `setpts=(PTS-STARTPTS)/${p.speed},fps=20,scale=1280:800:flags=lanczos`,
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-crf',
      '31',
      '-maxrate',
      '600k',
      '-bufsize',
      '1200k',
      '-preset',
      'medium',
      '-an',
      file,
    ]);
    const length = (p.end - p.start) / p.speed;
    captions.push(`${i + 1}\n${timestamp(duration)} --> ${timestamp(duration + length)}\n${p.label}\n`);
    duration += length;
  }
  const list = join(dir, 'parts.txt');
  await writeFile(list, files.map(f => `file '${f}'`).join('\n'));
  const output = join(MEDIA, `${name}.mp4`);
  await ffmpeg(['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', output]);
  await ffmpeg([
    '-ss',
    String(name === 'manual-editor' ? duration * 0.7 : 1),
    '-i',
    output,
    '-frames:v',
    '1',
    '-q:v',
    '3',
    join(MEDIA, `${name}.jpg`),
  ]);
  await writeFile(join(MEDIA, `${name}.vtt`), captions.join('\n'));
  await writeFile(join(diagnostics, `${name}-chapters.json`), JSON.stringify({ duration, phases }, null, 2));
  console.log(`✓ ${name}.mp4 — ${duration.toFixed(1)} seconds`);
}
try {
  await mkdir(MEDIA, { recursive: true });
  await waitForServer();
  browser = await chromium.launch({
    args: process.platform === 'darwin' ? ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] : [],
  });
  if (want('manual')) await record('manual-editor', manual);
  if (want('building')) await record('building-3d', building);
  if (want('backrooms')) await record('backrooms-route', backrooms);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await browser?.close();
  try {
    process.kill(-server.pid, 'SIGTERM');
  } catch {
    server.kill('SIGTERM');
  }
}
