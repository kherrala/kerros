# @kerros/server

Node-only source extraction, calibrated JSON/SVG evidence and AI imports for Kerros. Requires Node.js 22+. Build and package this workspace locally before publishing a release.

```ts
import { openVisualSource, queryCandidates, analysisSvg } from '@kerros/server';

const source = await openVisualSource('/data/floor.pdf', { cacheDirectory: '/data/analysis' });
try {
  const artifact = await source.analyse!({ page: 1 });
  const vectors = queryCandidates(artifact, { kind: 'path', limit: 25 });
  const svg = analysisSvg(artifact);
} finally {
  await source.close();
}
```

Exports include `openDwgSource`, `renderPdfDrawing`, `runAiPlanImport`, `createClaudeProvider`, source-analysis contracts and tools. DWG requires LibreDWG's `dwgread` executable. The package includes extraction helper scripts; hosts supply an SVG rasterizer only when they enable image review. No LLM call happens until a provider turn is explicitly run.

PDF paths/text and DWG entities are source evidence. Images/scanned PDF regions use local OpenCV line pairing, wall thickness/outline proposals and Finnish/English/Swedish OCR. Exemplar matching proposes repeated symbols at quarter turns, mirrors and nearby scales. Results are bounded JSON/SVG evidence, not automatically connected walls or model objects; tables/furniture and interrupted outlines need interpretation.

The package includes `dist/tools/raster.py`. Raster support requires Python 3 with OpenCV/numpy and Tesseract (`fin`, `eng`, `swe` language data); the API Docker image supplies them. Override the Python executable with `KERROS_OPENCV_PYTHON` or the host's `raster.python` option. `source.analyse({ mode: 'raster', profile: 'scan', bbox: [x0,y0,x1,y1], ocr: true })` uses original source coordinates. Run `make test-raster` for the isolated, offline native fixtures; no LLM calls are made.

The browser editor uses HTTP host adapters and does not import this package. For headless CAD conversion, this package also exports `importPlanEntities`, layer detection, sheet registration and `documentSvg`. Browser hosts get the same helpers from `@kerros/editor` or `@kerros/editor/host`; their implementation is shared internally.

Build from the repository with `npm run build --workspace @kerros/server`, then create a local tarball with `npm pack --workspace @kerros/server --pack-destination /tmp`. The complete reference is in `docs/reference/server.md` in the repository.
