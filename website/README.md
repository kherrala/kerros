# Homepage and recordings

`landing.html`, `landing.css` and `landing.js` are shared by the Vite development index and the published VitePress home (`docs/index.md`). `npm run build:site` assembles the app and documentation into `dist/` for the `/kerros/` deployment path. There is no hero image.

The three videos live in `docs/public/media/`. Each has an MP4, a JPEG poster and an English WebVTT annotation track. The clips are encoded at 1280 × 800, 20 fps with a 600 kbit/s ceiling. They load on demand, have native playback controls, and pause one another. Recordings are silent; the interactive demo includes music and ambience.

To refresh recordings, install Chromium for Playwright, provide the MML public map credential in `.env.local`, and have `ffmpeg` on PATH. Run:

```sh
npm run capture:media -- manual
npm run capture:media -- building
npm run capture:media -- backrooms
```

Omit the target to record all three. The script starts its own local server, records real browser interactions, trims setup between scenes, and writes caption timing alongside the encoded clips. Manual editing requires actual MML cadastral features; it does not substitute map fixtures. Failure screenshots and chapter diagnostics are retained in the printed temporary directory. Keep app source unchanged while recording to avoid hot reloads in the video.
