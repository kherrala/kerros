let setup: Promise<void> | undefined;

/** Configure MapLibre's CSP-compatible worker when a rendering surface is first requested. */
export function setupMaplibreWorker(): Promise<void> {
  return (setup ??= Promise.all([
    import('maplibre-gl'),
    import('maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'),
  ]).then(([maplibregl, worker]) => {
    maplibregl.setWorkerUrl(worker.default);
  }));
}
