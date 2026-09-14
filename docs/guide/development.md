# Run the development stack

Install Docker Desktop (or Docker Engine with Compose supporting `watch` and `sync+restart`), start Docker, then run from the repository root:

```sh
make up
```

This creates `.env.local` from `.env.example` if it does not exist, builds the images, and starts the editor, viewer, documentation and AI import backend. The first build installs Chromium, OpenCV, Tesseract language data and compiles LibreDWG; allow several minutes. Later starts reuse those layers.

| Service | Address |
| --- | --- |
| Editor | <http://127.0.0.1:5173/app.html> |
| Viewer | <http://127.0.0.1:5173/viewer.html> |
| Documentation | <http://127.0.0.1:5173/guide/> |
| AI import | Proxied through `/api/ai-import` on the editor's origin |

Compose watches source files. Frontend and documentation changes reload in the browser; importer/core-model changes restart the backend. Frontend-only edits do not restart an import. Dependency changes rebuild containers. Keep `make up` running while developing; Ctrl+C stops it. Use `make down` to remove the containers, or `make logs` to follow their output. Project documents remain in browser storage.

Homepage guide and reference links use the same port as the apps. Vite forwards the documentation and its live-reload connection to the docs container under `/kerros/`; `/guide/` opens Getting started. The docs server is also available directly at <http://127.0.0.1:5174/kerros/>. `PORT` changes the public app/documentation port; `DOCS_PORT` changes only the direct docs port.

See [Docker's Compose Watch documentation](https://docs.docker.com/compose/how-tos/file-watch/) for the watch actions and supported Compose versions.

## Configure optional services

Edit `.env.local`, then restart `make up`:

```dotenv
VITE_MML_API_KEY=your_mml_key
ANTHROPIC_API_KEY=your_claude_key
```

These services are independent. Without keys, normal editing and the bundled examples still work. The AI import panel explains when its backend key is missing.

PDF reference conversion, PDF/DWG extraction and local OpenCV/OCR/symbol analysis also work without a Claude key. Parsing and AI execution use the [`@kerros/server` workspace package](../reference/server); the frontend contains no PDF.js worker, OpenCV or LLM SDK. Compose watches `src/server` (including its Python worker) as part of the backend. Rebuild with `make up` after native dependency changes.

Extracted JSON/SVG artifacts survive container restarts in the `analysis-cache` named volume. They contain source drawing geometry and text. Native CLI runs use `.cache/plan-analysis`; `KERROS_IMPORT_ANALYSIS_CACHE` overrides that path for the AI runner. The cache is separate from saved live projects and can be discarded when no longer needed; the next extraction regenerates it.

- [MML vector maps and cadastral boundaries](./mml-maps) explains obtaining and using the map key.
- [Import features](./ai-import) explains file formats, live editing and saved sessions; the [AI engine reference](../reference/ai-import) covers Claude setup and the CLI.

Compose reads `.env.local` for interpolation and explicitly gives each container only its relevant settings: the web container receives the public MML key, and the backend receives the Claude secret. `.dockerignore` excludes environment files from images and source synchronization. Do not rename the secret to `VITE_ANTHROPIC_API_KEY`: Vite exposes `VITE_` variables to browser code. See [Compose environment variables](https://docs.docker.com/compose/how-tos/environment-variables/set-environment-variables/).

The published ports bind to loopback. This is a local developer backend, with one import job at a time; a public deployment needs its own authentication, per-user job isolation and usage controls.

## Native development

Docker supplies the native import tools automatically. To run directly on the host, install Node.js 22+, run `npm ci`, and install Chromium with `npx playwright install chromium`. DWG import also needs `dwgread` from LibreDWG (`brew install libredwg` on macOS).

For raster analysis, install Python 3 with OpenCV/numpy and Tesseract plus Finnish, English and Swedish language data. Debian/Ubuntu provide `python3-opencv tesseract-ocr tesseract-ocr-fin tesseract-ocr-eng tesseract-ocr-swe`. `KERROS_OPENCV_PYTHON` selects a host virtual-environment interpreter if needed. Native dependencies belong only to the API environment; browser builds enforce that boundary. The reference Docker runtime is tested with OpenCV 4.6 and Tesseract 5.

Set `VITE_AI_IMPORT_URL=/api/ai-import` in `.env.local` and use separate terminals:

```sh
npm run api
make dev
make docs
```

Vite proxies `/api/ai-import` to `127.0.0.1:3001` and documentation to `127.0.0.1:5174`. If the native docs server uses another port, set `KERROS_DOCS_PROXY_TARGET` in the environment when starting Vite. The backend loads its secret from the process environment, then `.env.local`, then `.env`, without overriding an already supplied value. Its default bind address is `127.0.0.1`; Compose changes that address only inside its private network.

Use `make check` for formatting, TypeScript, core/frontend tests, backend tests and the generated AI tool schema check. After changing mutation or model types, run `npm run generate:ai-tools` and include the updated schema in the change.

Use `make test-raster` for deterministic OpenCV/OCR fixtures in an isolated Docker container. The build downloads dependencies when necessary; test execution has networking disabled and consumes no LLM tokens. On a host with the native dependencies installed, `npm run test:raster` runs the same fixtures directly. Ordinary tests skip this native suite. It covers wall position/thickness, real gaps, oblique lines, exterior contours, labels, coordinate transforms, cache reuse, mixed PDFs and repeated symbol hypotheses.

## Published static site

The **Publish site** GitHub Actions workflow builds the homepage, editor, viewer and documentation,
then deploys `dist/` to GitHub Pages after pushes to `main`. It can also be started manually with
`gh workflow run pages.yml --ref main`. The project uses the `/kerros/` deployment base; internal
links remain relative to the site rather than naming a custom domain.

Pages serves static files only. AI import and PDF conversion still need the separate server module;
use `make up` for those features locally. The optional repository Actions variable `VITE_MML_API_KEY`
enables the public MML basemap in the published build. Never put a Claude credential in a browser
build variable. The workflow runs no paid model requests.
