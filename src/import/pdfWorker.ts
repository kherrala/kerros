// Where pdf.js's worker lives, in its own module on purpose.
//
// `new URL('…', import.meta.url)` is how a bundler is told about an asset, and in a library build
// Vite answers by inlining it — there is no page for a library to emit files next to, so the 1.2 MB
// worker becomes 1.6 MB of base64 sitting in whichever module asked for it. Asked for from
// ImportDialog, that was 1.6 MB in the editor's eager bundle, carried by every consumer whether or
// not they ever open a PDF.
//
// Alone in a module and reached with `await import()`, it is still 1.6 MB — but 1.6 MB that arrives
// when somebody actually opens a PDF, which is the only moment it means anything.
export const pdfWorkerUrl = () => new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString();
