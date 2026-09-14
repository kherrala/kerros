import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { vectorBounds, vectorPath, type SourceCandidate, type VectorBounds } from './analysis';

export interface SourceAnalysisQuery {
  page?: number;
  /** Crop in ORIGINAL source pixels/PDF viewport points; never preview pixels. */
  bbox?: VectorBounds;
  mode?: 'auto' | 'native' | 'raster';
  profile?: 'clean' | 'scan';
  ocr?: boolean;
  /** A caller-confirmed exemplar. Matches are visual hypotheses, not model objects. */
  symbol?: { bounds: VectorBounds; label: string };
}
export interface RasterAnalysisOptions {
  /** Host configuration only. These paths are never model tool arguments. */
  python?: string;
  workerPath?: string;
}
export interface RasterEvidence {
  engine: string;
  profile: 'clean' | 'scan';
  ocr: boolean;
  region: VectorBounds;
  width: number;
  height: number;
  /** Exact affine map from analysis pixel edges to original source coordinates. */
  rasterToSource: [number, number, number, number, number, number];
  /** In the ORIGINAL y-down source frame; orientation evidence, not automatic snapping. */
  mainAxes: { degrees: number; score: number }[];
  symbol?: { bounds: VectorBounds; label: string };
}
export function analysisRequest(query: SourceAnalysisQuery = {}) {
  const { page = 1, mode = 'auto', profile = 'clean', ocr = true, bbox, symbol } = query;
  if (!Number.isInteger(page) || page < 1 || page > 20) throw new Error('Choose a source page from 1 to 20.');
  if (!['auto', 'native', 'raster'].includes(mode) || !['clean', 'scan'].includes(profile) || typeof ocr !== 'boolean')
    throw new Error('Invalid source analysis mode, profile or OCR setting.');
  if (
    bbox !== undefined &&
    (!Array.isArray(bbox) ||
      bbox.length !== 4 ||
      !bbox.every(Number.isFinite) ||
      bbox[2] <= bbox[0] ||
      bbox[3] <= bbox[1])
  )
    throw new Error('Analysis bbox must be x0,y0,x1,y1 with positive size in original source coordinates.');
  if (mode === 'native' && bbox)
    throw new Error('Native extraction reads the whole page; use query_candidates to filter it.');
  if (
    symbol &&
    (!Array.isArray(symbol.bounds) ||
      symbol.bounds.length !== 4 ||
      !symbol.bounds.every(Number.isFinite) ||
      symbol.bounds[2] <= symbol.bounds[0] ||
      symbol.bounds[3] <= symbol.bounds[1] ||
      typeof symbol.label !== 'string' ||
      !symbol.label.trim() ||
      symbol.label.length > 60 ||
      mode === 'native')
  )
    throw new Error('Choose a labelled symbol box in original source coordinates and use raster analysis.');
  return {
    page,
    mode,
    profile,
    ocr,
    ...(bbox ? { bbox } : {}),
    ...(symbol ? { symbol: { bounds: symbol.bounds, label: symbol.label.trim() } } : {}),
  };
}

/** Bounded local child process. No shell, network, provider or user-supplied executable arguments. */
export async function analyseRaster(
  png: Uint8Array,
  region: VectorBounds,
  settings: { profile: 'clean' | 'scan'; ocr: boolean; symbol?: SourceAnalysisQuery['symbol'] },
  options: RasterAnalysisOptions = {},
): Promise<{ candidates: SourceCandidate[]; warnings: string[]; raster: RasterEvidence }> {
  const directory = await mkdtemp(join(tmpdir(), 'kerros-raster-'));
  try {
    await writeFile(join(directory, 'source.png'), png, { mode: 0o600 });
    const worker = options.workerPath ?? fileURLToPath(new URL('./tools/raster.py', import.meta.url));
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        options.python ?? process.env.KERROS_OPENCV_PYTHON ?? 'python3',
        [
          worker,
          join(directory, 'source.png'),
          join(directory, 'result.json'),
          settings.profile,
          settings.ocr ? 'ocr' : 'no-ocr',
          JSON.stringify(
            settings.symbol ? { label: settings.symbol.label, bounds: settings.symbol.bounds, region } : null,
          ),
        ],
        {
          stdio: ['ignore', 'ignore', 'pipe'],
          detached: process.platform !== 'win32',
          env: { ...process.env, OMP_THREAD_LIMIT: '1', OPENCV_IO_MAX_IMAGE_PIXELS: '5760000' },
        },
      );
      let stderr = '';
      let failure: Error | undefined;
      const stop = () => {
        try {
          if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
          else child.kill('SIGKILL');
        } catch {
          /* Already exited. */
        }
      };
      const timer = setTimeout(() => {
        failure = new Error('Raster analysis exceeded 45 seconds. Try a smaller source region.');
        stop();
      }, 45_000);
      child.stderr.on('data', chunk => {
        stderr = (stderr + chunk.toString()).slice(-2000);
      });
      child.on('error', error => {
        failure = new Error(
          `Cannot start OpenCV worker: ${error.message}. Use the API Docker image or configure KERROS_OPENCV_PYTHON.`,
        );
      });
      child.on('close', code => {
        clearTimeout(timer);
        if (failure) reject(failure);
        else if (code !== 0) reject(new Error(`Raster analysis failed: ${stderr.trim() || `exit ${code}`}`));
        else resolve();
      });
    });
    if ((await stat(join(directory, 'result.json'))).size > 8 * 1024 * 1024)
      throw new Error('Raster result exceeds its storage limit.');
    const bytes = await readFile(join(directory, 'result.json'));
    const result = JSON.parse(bytes.toString()) as {
      width: number;
      height: number;
      engine: string;
      mainAxes: { degrees: number; score: number }[];
      candidates: SourceCandidate[];
      warnings: string[];
    };
    const sx = (region[2] - region[0]) / result.width,
      sy = (region[3] - region[1]) / result.height;
    if (![sx, sy].every(s => Number.isFinite(s) && s > 0)) throw new Error('Invalid raster coordinate transform.');
    const matrix: RasterEvidence['rasterToSource'] = [sx, 0, 0, sy, region[0], region[1]];
    const candidates = result.candidates.map(c => {
      const path = vectorPath(c.path, matrix);
      // Width is measured normal to the segment, including the tiny aspect correction from integer canvas sizes.
      const dx = Number(c.path[1]?.[1] ?? 0) - Number(c.path[0][1]);
      const dy = Number(c.path[1]?.[2] ?? 0) - Number(c.path[0][2]);
      const widthScale = Math.hypot(dx, dy) ? (sx * sy * Math.hypot(dx, dy)) / Math.hypot(dx * sx, dy * sy) : sy;
      return {
        ...c,
        path,
        bounds: vectorBounds(path),
        ...(c.thickness !== undefined ? { thickness: c.thickness * widthScale } : {}),
        ...(c.strokeWidth !== undefined ? { strokeWidth: c.strokeWidth * (c.kind === 'label' ? sy : widthScale) } : {}),
      };
    });
    return {
      candidates,
      warnings: result.warnings,
      raster: {
        engine: result.engine,
        profile: settings.profile,
        ocr: settings.ocr,
        region,
        width: result.width,
        height: result.height,
        rasterToSource: matrix,
        mainAxes: result.mainAxes.map(a => ({
          score: a.score,
          degrees:
            (Math.atan2(sy * Math.sin((a.degrees * Math.PI) / 180), sx * Math.cos((a.degrees * Math.PI) / 180)) * 180) /
            Math.PI,
        })),
        ...(settings.symbol ? { symbol: settings.symbol } : {}),
      },
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
