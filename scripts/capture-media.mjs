// Re-capture the docs media (hero still, showcase clip).
//
//   node scripts/capture-media.mjs                 # capture everything
//   node scripts/capture-media.mjs hero gif        # capture only the named targets (gif = the showcase)
//
// Spins up the app on a throwaway Vite dev server (which loads the real MML key from .env.local, so
// the basemap actually renders), drives the editor with Playwright, and writes the hero PNG and a
// showcase MP4 into docs/public/media/. Requires ffmpeg on PATH for the showcase. Repeatable: safe
// to re-run.
import { spawn } from 'node:child_process';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MEDIA = join(ROOT, 'docs/public/media');
const APP = 'http://127.0.0.1:5183';
const SHOW_VIEWPORT = { width: 1920, height: 1200 }; // video records at CSS pixels, so record big natively
// The hero shoots the same layout at 2× (deviceScaleFactor) → a 3840×2400 PNG that doubles as the poster.
const targets = process.argv.slice(2);
const want = name => targets.length === 0 || targets.includes(name);

function serve(cmd, args, label) {
  // detached so we can kill the whole process tree (npm → vite) on teardown.
  const child = spawn(cmd, args, { cwd: ROOT, env: process.env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  child.stderr.on('data', d => {
    if (/error/i.test(String(d))) process.stderr.write(`[${label}] ${d}`);
  });
  return child;
}
function stop(child) {
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    child.kill('SIGTERM');
  }
}
async function waitFor(url, timeoutMs = 40000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise(r => setTimeout(r, 400));
  }
  throw new Error(`Timed out waiting for ${url}`);
}
// Resolve once the MapLibre instance (exposed as window.__kerrosMap in dev) is loaded, its tiles are in,
// and it has stopped moving — so screenshots never catch a grey basemap or a mid-flight camera.
async function mapReady(page) {
  await page.waitForFunction(
    () => {
      const m = window.__kerrosMap;
      return !!m && m.loaded() && m.areTilesLoaded() && !m.isMoving();
    },
    { timeout: 30000 },
  );
  await page.waitForTimeout(1400); // let 3D extrusions, labels and the fit-in settle
}
async function pickFloor(page, name) {
  await page.getByRole('button', { name: 'Active floor' }).click();
  await page.locator('.place-option').filter({ hasText: name }).first().click();
}
// The stack toggle is labelled with the state you are in, not the one the click takes you to, so a
// blind click is a coin flip: it lands on the stacked whole-building view exactly when 3D opened in
// cutaway. Read the label first, and only act when the stack is on. Located by class because the
// button also carries the ⇧X key hint, which an exact accessible-name match would miss.
async function ensureCutaway(page) {
  const toggle = page.locator('.stack-button');
  await toggle.waitFor({ state: 'visible' });
  if (/All floors/.test(await toggle.innerText())) {
    await toggle.click();
    await page.waitForFunction(
      () => !/All floors/.test(document.querySelector('.stack-button')?.textContent ?? 'All floors'),
    );
  }
}
async function openStockmannEditor(page, base) {
  page.setDefaultTimeout(60000); // vite cold-starts can be slow; don't flake on the first paint
  await page.goto(`${base}/app.html`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: /Stockmann Helsinki.*Open/ }).click();
  await page.getByRole('button', { name: 'Plan editor', exact: true }).click();
  await pickFloor(page, /Offices · management/); // top office floor
}
// One staging for both shots, because the hero still is the clip's poster frame and the two have to
// open on the same view. Left to itself the camera does not: opening the project starts a fly-in that
// the floor fit interrupts wherever it happens to be, so bearing, pitch and zoom settle somewhere new
// on every run. "Reset north" puts the camera on the site's own heading at the 3D pitch and "Fit floor"
// frames the plate from there — the product's own two controls, and the same view every time.
async function stageCutaway(page, base) {
  await openStockmannEditor(page, base);
  await page.getByRole('button', { name: '3D', exact: true }).click();
  await ensureCutaway(page);
  await page.getByRole('button', { name: 'Show properties panel' }).click(); // open the right panel too
  await mapReady(page);
  await page.getByRole('button', { name: 'Reset north' }).click();
  await mapReady(page);
  await page.getByRole('button', { name: 'Fit floor' }).click();
  await mapReady(page);
}

async function main() {
  const servers = [];
  if (want('hero') || want('gif'))
    servers.push(serve('npm', ['run', 'dev', '--', '--port', '5183', '--strictPort'], 'app'));
  // Headless Chromium defaults to SwiftShader (software WebGL): slow, and not what a real viewer
  // sees. Force the real GPU so the captures match the product.
  const browser = await chromium.launch({
    args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'],
  });
  try {
    if (want('hero') || want('gif')) await waitFor(`${APP}/app.html`);

    if (want('hero')) {
      const page = await browser.newPage({ viewport: SHOW_VIEWPORT, deviceScaleFactor: 2 });
      await stageCutaway(page, APP);
      await page.screenshot({ path: join(MEDIA, 'editor-3d.png') });
      console.log('✓ hero → editor-3d.png');
      await page.close();
    }

    if (want('gif')) {
      const dir = await mkdtemp(join(tmpdir(), 'kerros-gif-'));
      const context = await browser.newContext({ viewport: SHOW_VIEWPORT, recordVideo: { dir, size: SHOW_VIEWPORT } });
      const started = Date.now(); // video timeline starts here; trim the setup off the front later
      const page = await context.newPage();
      // Setup (trimmed from the GIF): a 3D cutaway of the top office floor, both panels open.
      await stageCutaway(page, APP);
      const skip = (Date.now() - started) / 1000;
      // Showcase: descend the building floor by floor, each level's plan revealed inside the cutaway.
      // Floor step = Shift+ArrowDown; eight of them walk the office and retail floors (09 → 01) and stop
      // above the street, short of the garage. The heading holds, but every step re-fits the camera to
      // the new floor's depth, so the basemap drifts a little as the descent goes on — that is the
      // product's own framing, not a stray drag.
      await page.waitForTimeout(700);
      for (let i = 0; i < 8; i++) {
        await page.keyboard.press('Shift+ArrowDown');
        await page.waitForTimeout(850);
      }
      await page.waitForTimeout(700);
      await context.close(); // flushes the .webm
      const webm = join(dir, (await readdir(dir)).find(f => f.endsWith('.webm')));
      // H.264 MP4 for the docs <video> — a near-still camera compresses to inter-frame deltas, so a
      // proper 1920×1200 clip stays ~2 MB. The hero still doubles as the poster: same staging, so the
      // first frame is the still.
      await encodeMp4(webm, join(MEDIA, 'showcase.mp4'), skip);
      await rm(dir, { recursive: true, force: true });
      console.log('✓ showcase → showcase.mp4');
    }

  } finally {
    await browser.close();
    for (const s of servers) stop(s);
  }
}

function ffmpeg(args) {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', ['-y', ...args], { stdio: 'ignore' });
    ff.on('exit', code => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`))));
  });
}
const seek = skip => (skip > 0 ? ['-ss', skip.toFixed(2)] : []); // drop the setup navigation off the front
function encodeMp4(webm, out, skip = 0) {
  // yuv420p + faststart so it plays inline everywhere; scale to even dimensions for H.264.
  return ffmpeg([
    ...seek(skip), '-i', webm,
    '-vf', 'fps=24,scale=1920:-2:flags=lanczos',
    '-c:v', 'libx264', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-crf', '28', '-preset', 'veryslow',
    '-movflags', '+faststart', '-an', out,
  ]);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
