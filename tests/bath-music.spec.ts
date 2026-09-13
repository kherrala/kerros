import { expect, test } from '@playwright/test';
import { writeFile } from 'node:fs/promises';

test.use({
  launchOptions:
    process.platform === 'darwin' ? { args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] } : {},
});

for (const preset of ['baths', 'elevator'])
  test(`${preset} music renders a finite stereo phrase with a quiet entrance and room tail`, async ({ page }, info) => {
    await page.goto('/app.html');
    const audio = await page.evaluate(async preset => {
      const path = '/src/map/bathMusic.ts';
      const { bathMusic, elevatorMusic } = await import(path);
      const ctx = new OfflineAudioContext(2, 28 * 22050, 22050);
      const volume = ctx.createGain();
      volume.gain.value = 0.55;
      volume.connect(ctx.destination);
      const music = (preset === 'elevator' ? elevatorMusic : bathMusic)(ctx, volume);
      const buffer = await ctx.startRendering();
      for (const source of music.sources) source.stop();
      for (const node of music.nodes) node.disconnect();
      const left = buffer.getChannelData(0),
        right = buffer.getChannelData(1);
      let peak = 0,
        power = 0,
        stereo = 0,
        attack = 0,
        tail = 0;
      for (let i = 0; i < left.length; i++) {
        peak = Math.max(peak, Math.abs(left[i]), Math.abs(right[i]));
        power += left[i] ** 2 + right[i] ** 2;
        stereo += (left[i] - right[i]) ** 2;
        if (i < 2205) attack = Math.max(attack, Math.abs(left[i]), Math.abs(right[i]));
        // Offline rendering completes before the realtime look-ahead timer runs. Both recipes
        // initially schedule two eight-beat chords; measure the reverb after that phrase ends.
        const tailStart = (60 / (preset === 'elevator' ? 88 : 48)) * 16 + 3;
        if (i > tailStart * 22050) tail += left[i] ** 2 + right[i] ** 2;
      }
      const bytes = new ArrayBuffer(44 + left.length * 4);
      const wav = new DataView(bytes);
      const text = (at: number, value: string) => [...value].forEach((c, i) => wav.setUint8(at + i, c.charCodeAt(0)));
      text(0, 'RIFF');
      wav.setUint32(4, bytes.byteLength - 8, true);
      text(8, 'WAVE');
      text(12, 'fmt ');
      wav.setUint32(16, 16, true);
      wav.setUint16(20, 1, true);
      wav.setUint16(22, 2, true);
      wav.setUint32(24, 22050, true);
      wav.setUint32(28, 22050 * 4, true);
      wav.setUint16(32, 4, true);
      wav.setUint16(34, 16, true);
      text(36, 'data');
      wav.setUint32(40, bytes.byteLength - 44, true);
      for (let i = 0; i < left.length; i++) {
        wav.setInt16(44 + i * 4, Math.round(Math.max(-1, Math.min(1, left[i])) * 32767), true);
        wav.setInt16(46 + i * 4, Math.round(Math.max(-1, Math.min(1, right[i])) * 32767), true);
      }
      const raw = new Uint8Array(bytes);
      let binary = '';
      for (let i = 0; i < raw.length; i += 8192) binary += String.fromCharCode(...raw.subarray(i, i + 8192));
      return {
        peak,
        rms: Math.sqrt(power / left.length / 2),
        stereo,
        attack,
        tail,
        voices: music.sources.length,
        wav: btoa(binary),
      };
    }, preset);
    expect(audio.peak).toBeLessThan(0.8);
    expect(audio.rms).toBeGreaterThan(0.005);
    expect(audio.rms).toBeLessThan(0.15);
    expect(audio.attack).toBeLessThan(0.01);
    expect(audio.stereo).toBeGreaterThan(0.01);
    expect(audio.tail).toBeGreaterThan(0);
    expect(audio.voices).toBeLessThan(20);
    await writeFile(info.outputPath(`${preset}-music.wav`), Buffer.from(audio.wav, 'base64'));
  });

test('entering the baths plays music, respects mute, and releases audio after leaving Walk', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('/app.html');
  await page.getByRole('button', { name: 'Open offices', exact: true }).click();
  await expect(page.locator('.map-wrap')).toHaveAttribute('data-frame', 'ready');
  await page.getByRole('button', { name: 'Walk', exact: true }).click();
  await page.getByRole('button', { name: 'Active floor' }).click();
  await page.locator('.place-option').filter({ hasText: 'The endless baths' }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__kerrosSound?.playing?.key)).toBe('baths@0.55');
  await expect.poll(() => page.evaluate(() => (window as any).__kerrosSound?.ctx?.state)).toBe('running');
  await page.keyboard.press('m');
  await expect.poll(() => page.evaluate(() => (window as any).__kerrosSound.isMuted)).toBe(true);
  await page.keyboard.press('m');
  await expect.poll(() => page.evaluate(() => (window as any).__kerrosSound.isMuted)).toBe(false);
  await page.getByRole('button', { name: 'Active floor' }).click();
  await page.locator('.place-option').filter({ hasText: 'Yellow offices' }).first().click();
  await expect.poll(() => page.evaluate(() => (window as any).__kerrosSound?.playing?.key)).toMatch(/^backrooms@/);
  await expect.poll(() => page.evaluate(() => (window as any).__kerrosSound.fading.length)).toBe(0);
  await page.evaluate(() => {
    (window as any).__bathAudio = (window as any).__kerrosSound.ctx;
  });
  await page.getByRole('button', { name: '2D', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__bathAudio.state)).toBe('closed');
  expect(errors).toEqual([]);
});
