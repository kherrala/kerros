// Capture original Chromium frames instead of Playwright's compressed 25 fps WebM.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

export async function captureFrames(page, directory, size) {
  await mkdir(directory, { recursive: true });
  const session = await page.context().newCDPSession(page);
  const started = Date.now();
  const frames = [];
  let pending = Promise.resolve(), error, stopping = false;
  const elapsed = () => (Date.now() - started) / 1000;
  const receive = event => {
    if (stopping) return;
    const time = Math.max(0, (event.metadata.timestamp ? event.metadata.timestamp * 1000 - started : Date.now() - started) / 1000);
    const file = join(directory, `frame-${String(frames.length).padStart(6, '0')}.png`);
    frames.push({ time, file });
    pending = pending.then(async () => {
      await writeFile(file, Buffer.from(event.data, 'base64'));
      await session.send('Page.screencastFrameAck', { sessionId: event.sessionId });
    }).catch(reason => { error = reason; });
  };
  session.on('Page.screencastFrame', receive);
  await session.send('Page.startScreencast', {
    format: 'png', maxWidth: size.width, maxHeight: size.height, everyNthFrame: 1,
  });
  return {
    elapsed,
    async stop() {
      stopping = true;
      session.off('Page.screencastFrame', receive);
      await session.send('Page.stopScreencast');
      await pending;
      await session.detach();
      if (error) throw error;
      if (!frames.length) throw new Error('The browser supplied no capture frames.');
      return frames;
    },
  };
}

// Sample the original frame timestamps at the output cadence. Static frames are held;
// missing source frames are never disguised with motion interpolation.
export function sampleChapters(frames, phases, fps = 30) {
  if (!frames.length || !phases.length || !Number.isFinite(fps) || fps <= 0)
    throw new Error('Capture needs frames, chapters and a positive frame rate.');
  const selected = [], chapters = [];
  let cursor = 0;
  for (const phase of phases) {
    if (!(phase.end > phase.start && phase.speed > 0)) throw new Error('Invalid chapter interval.');
    const count = Math.max(1, Math.round((phase.end - phase.start) / phase.speed * fps));
    const start = selected.length / fps;
    for (let i = 0; i < count; i++) {
      const time = phase.start + i / fps * phase.speed;
      while (cursor + 1 < frames.length && frames[cursor + 1].time <= time) cursor++;
      selected.push(frames[cursor].file);
    }
    chapters.push({ start, end: selected.length / fps, label: phase.label });
  }
  return { selected, chapters, duration: selected.length / fps };
}

export async function encodeFrames(files, output, fps = 30) {
  const child = spawn('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(fps),
    '-vcodec', 'png', '-i', 'pipe:0', '-an', '-c:v', 'libx264', '-preset', 'slow',
    '-crf', '18', '-pix_fmt', 'yuv420p', '-g', String(fps * 2), '-movflags', '+faststart', output,
  ], { stdio: ['pipe', 'ignore', 'pipe'] });
  let message = '', failed;
  child.stderr.on('data', chunk => { message = (message + chunk).slice(-4000); });
  child.stdin.on('error', error => { failed = error; });
  const done = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(new Error(`Encoding failed: ${message}`)));
  });
  // Attach immediately, including while feeding the pipe, to avoid an unhandled exit rejection.
  done.catch(() => {});
  try {
    let previous, buffer;
    for (const file of files) {
      if (failed) throw failed;
      if (file !== previous) buffer = await readFile(file);
      previous = file;
      if (!child.stdin.write(buffer)) await once(child.stdin, 'drain');
    }
    child.stdin.end();
    await done;
  } catch (error) {
    child.kill('SIGTERM');
    await done.catch(() => {});
    throw error;
  }
}
