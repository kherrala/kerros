# Homepage and recordings

`landing.html`, `landing.css` and `landing.js` are shared by the Vite development index and the published VitePress home (`docs/index.md`). `npm run build:site` assembles the app and documentation into `dist/` for the `/kerros/` deployment path. There is no hero image.

The homepage also introduces live AI import and the five modules, including the Node-only `@kerros/server` extraction and AI backend. Its guide/reference links work through the development app's documentation proxy as well as the published site.

## GitHub Pages

`.github/workflows/pages.yml` builds and publishes `dist/` after pushes to `main`, or through a manual
**Publish site** workflow run. The documentation base is `/kerros/`; app links and assets use relative
paths. The deployment includes the homepage, editor, viewer, manual and recorded media.

For a repository administrator, initial setup with GitHub CLI is:

```sh
gh api --method POST repos/kherrala/kerros/pages -f build_type=workflow
gh workflow run pages.yml --ref main
gh run list --workflow pages.yml
```

If Pages already exists, change its publishing method with `gh api --method PUT repos/kherrala/kerros/pages -f build_type=workflow`.
The workflow uses the `github-pages` environment and GitHub's deployment token; it needs no personal
access token or deploy key stored as a repository secret. See GitHub's
[custom Pages workflow documentation](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages).

Optionally set the repository Actions variable `VITE_MML_API_KEY` for MML vector maps. This value is
compiled into public JavaScript, so use only the public map credential described in the MML guide.
GitHub Pages hosts static files; it does not run `@kerros/server`, PDF conversion or Claude imports.
The Pages build leaves the AI backend URL empty. Use `make up` for the complete local stack.

## Recordings

The three videos live in `docs/public/media/`. Each has an MP4, a JPEG poster and an English WebVTT annotation track. The clips are encoded at 1280 × 800, 20 fps with a 600 kbit/s ceiling. They load on demand, have native playback controls, and pause one another. Recordings are silent; the interactive demo includes music and ambience. The Backrooms clip starts beside a pool in the deep baths after the POV scene has warmed up, follows an elevator route to the yellow offices, then visits the other bath level.

To refresh recordings, install Chromium for Playwright, provide the MML public map credential in `.env.local`, and have `ffmpeg` on PATH. Run:

```sh
npm run capture:media -- manual
npm run capture:media -- building
npm run capture:media -- backrooms
```

Omit the target to record all three. The script starts its own local server, records real browser interactions, trims setup between scenes, and writes caption timing alongside the encoded clips. Manual editing requires actual MML cadastral features; it does not substitute map fixtures. Failure screenshots and chapter diagnostics are retained in the printed temporary directory. Keep app source unchanged while recording to avoid hot reloads in the video.
