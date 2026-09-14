import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { analysisSvg, validateSourceAnalysis, ANALYSIS_MAX_BYTES, type SourceAnalysis } from './analysis';

/** Change whenever extraction semantics change. Content-addressed files survive new runs/reloads. */
export const ANALYSIS_VERSION = 'raster-3';
export const sourceHash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
export class AnalysisStore {
  private pending = new Map<string, Promise<SourceAnalysis>>();
  constructor(
    private hash: string,
    private directory?: string,
  ) {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('Invalid source hash.');
  }
  get(page: number, build: (id: string) => Promise<SourceAnalysis>, variant = ''): Promise<SourceAnalysis> {
    if (!Number.isInteger(page) || page < 1 || page > 20) throw new Error('Choose a source page from 1 to 20.');
    const key = `${page}:${variant}`;
    const current = this.pending.get(key);
    if (current) return current;
    const request = this.load(page, build, variant).catch(error => {
      this.pending.delete(key);
      throw error;
    });
    this.pending.set(key, request);
    return request;
  }
  private async load(page: number, build: (id: string) => Promise<SourceAnalysis>, variant: string) {
    const id = `${ANALYSIS_VERSION}-${this.hash}-p${page}${variant ? '-' + sourceHash(Buffer.from(variant)).slice(0, 20) : ''}`;
    const file = this.directory ? join(this.directory, `${id}.json`) : undefined;
    if (file) {
      try {
        if ((await stat(file)).size > ANALYSIS_MAX_BYTES) throw new Error('Oversized cache.');
        const cached = validateSourceAnalysis(JSON.parse(await readFile(file, 'utf8')));
        if (cached.id === id && cached.sourceHash === this.hash && cached.page === page) return cached;
      } catch {
        /* Missing, old or invalid artifact: regenerate from the original source. */
      }
    }
    const artifact = validateSourceAnalysis(await build(id));
    if (artifact.sourceHash !== this.hash || artifact.id !== id || artifact.page !== page)
      throw new Error('Analysis does not match the requested source.');
    if (file) {
      await mkdir(this.directory!, { recursive: true, mode: 0o700 });
      const temporary = `${file}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(artifact), { mode: 0o600 });
      await rename(temporary, file);
      await writeFile(join(this.directory!, `${id}.svg`), analysisSvg(artifact), { mode: 0o600 });
    }
    return artifact;
  }
}
