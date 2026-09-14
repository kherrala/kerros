import { createServer, type ServerResponse } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { logImport } from '../scripts/plan-import/logging';
import { validateProject, type ProjectDocument } from '../src/schema';
import { readImportCheckpoint, readImportBudget, type ImportCheckpoint, type ImportBudget } from '../src/import/checkpoint';
import { readImportBrief, type ImportBrief } from '../src/import/brief';
import { readImportInstruction, type ImportInstruction } from '../src/import/instructions';

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
export interface ImportJob {
  id: string;
  input: string;
  output: string;
  instructionsFile: string;
  baseFile?: string;
  briefFile?: string;
  checkpointFile?: string;
  budget?: ImportBudget;
  origin: [number, number, number];
  signal: AbortSignal;
  onInstruction?: (receive: (instruction: ImportInstruction) => void) => () => void;
}
export type ImportWorker = (job: ImportJob, write: (chunk: string) => Promise<void>) => Promise<void>;
interface ServerOptions {
  configured: () => boolean;
  worker: ImportWorker;
  preview?: (bytes: Uint8Array, page: number) => Promise<Uint8Array>;
  maxUploadBytes?: number;
  deadlineMs?: number;
}
const json = (res: ServerResponse, status: number, body: object) => {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
};

/** Local development endpoint. One isolated import at a time; documents never share process state. */
export function createAiImportServer({ configured, worker, preview, maxUploadBytes = MAX_UPLOAD_BYTES, deadlineMs = 15 * 60_000 }: ServerOptions) {
  let busy = false;
  let active: { id: string; pending: ImportInstruction[]; received: Map<string, string>; receive?: (instruction: ImportInstruction) => void } | undefined;
  return createServer(async (req, res) => {
    const path = req.url?.split('?')[0];
    const isPreview = path === '/api/ai-import/preview';
    const instructionJob = path?.match(/^\/api\/ai-import\/([a-zA-Z0-9_-]{1,100})\/instructions$/)?.[1];
    if (path !== '/api/ai-import' && !isPreview && !instructionJob) return json(res, 404, { error: 'Not found.' });
    if (req.method === 'GET' && path === '/api/ai-import') return json(res, 200, { configured: configured(), pdfPreview: !!preview, busy, maxUploadBytes, formats: ['png', 'jpg', 'jpeg', 'webp', 'pdf', 'dwg'] });
    if (req.method !== 'POST') return json(res, 405, { error: 'Use POST to start an import.' });
    // A non-simple header plus same-origin checks stop other websites from spending the local key.
    // Vite preserves the original Host when proxying. This server does not enable cross-origin access.
    let sameOrigin = true;
    try { if (req.headers.origin) sameOrigin = new URL(req.headers.origin).host === req.headers.host; }
    catch { sameOrigin = false; }
    if (!sameOrigin || req.headers['x-kerros-import'] !== '1') return json(res, 403, { error: 'Use the local editor to start this import.' });
    if (instructionJob) {
      const job = active;
      if (!job || job.id !== instructionJob) return json(res, 409, { error: 'This run has ended. The instruction is saved for Continue import.' });
      try {
        const chunks: Buffer[] = [];
        let bytes = 0;
        for await (const chunk of req) {
          bytes += chunk.length;
          if (bytes > 10_000) return json(res, 413, { error: 'Instruction is too large.' });
          chunks.push(Buffer.from(chunk));
        }
        const instruction = readImportInstruction(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        if (active !== job) return json(res, 409, { error: 'This run has ended. The instruction is saved for Continue import.' });
        if (job.received.has(instruction.id)) {
          if (job.received.get(instruction.id) !== instruction.text) throw new Error('Instruction ID already used.');
        } else {
          if (job.received.size >= 20 || JSON.stringify([...job.received.values(), instruction.text]).length > 8000)
            return json(res, 429, { error: 'This run has reached its instruction limit. Stop and continue to send more.' });
          if (job.receive) job.receive(instruction);
          else job.pending.push(instruction);
          job.received.set(instruction.id, instruction.text);
        }
        return json(res, 202, { queued: true, id: instruction.id });
      } catch (e) { return json(res, 400, { error: e instanceof Error ? e.message : 'Invalid instruction.' }); }
    }
    if (isPreview ? !preview : !configured()) return json(res, 503, { error: isPreview ? 'PDF conversion is not enabled by this host.' : 'Add ANTHROPIC_API_KEY to .env.local and restart make up to enable AI import.' });
    if (busy) return json(res, 409, { error: 'Another AI import is running. Cancel it or wait for it to finish.' });
    // Multipart keeps drawings, Unicode instructions and continuation snapshots out of HTTP headers.
    const maxRequestBytes = maxUploadBytes + 10 * 1024 * 1024;
    if (Number(req.headers['content-length'] ?? 0) > maxRequestBytes) return json(res, 413, { error: 'Import request is too large.' });
    busy = true;
    const controller = new AbortController();
    const id = randomUUID();
    const started = Date.now();
    let outcome = 'import_failed';
    let work: string | undefined;
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); req.destroy(); res.destroy(); }, deadlineMs);
    timeout.unref();
    const cancel = () => { if (!res.writableEnded) controller.abort(); };
    res.on('close', cancel);
    try {
      // Bounded buffering also supports chunked browser uploads without trusting Content-Length.
      const chunks: Buffer[] = [];
      let bytes = 0;
      req.setTimeout(60_000, () => { controller.abort(); req.destroy(); });
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > maxRequestBytes) { json(res, 413, { error: 'Choose a file under 25 MB.' }); return; }
        chunks.push(Buffer.from(chunk));
      }
      req.setTimeout(0);
      if (!bytes) return json(res, 400, { error: 'The uploaded file is empty.' });
      let options: { origin: [number, number, number]; instructions: string; base?: ProjectDocument; brief?: ImportBrief; checkpoint?: ImportCheckpoint; budget?: ImportBudget };
      let file: File;
      try {
        const body = await new Request('http://localhost/api/ai-import', { method: 'POST', headers: { 'content-type': req.headers['content-type'] ?? '' }, body: new Uint8Array(Buffer.concat(chunks)) }).formData();
        const upload = body.get('file');
        if (!(upload instanceof File) || !/\.(dwg|pdf|png|jpe?g|webp)$/i.test(upload.name)) throw new Error('Choose a DWG, PDF, PNG, JPEG or WebP file.');
        file = upload;
        if (file.size > maxUploadBytes) { json(res, 413, { error: 'Choose a file under 25 MB.' }); return; }
        if (!file.size) throw new Error('The uploaded file is empty.');
        if (isPreview) {
          if (!/\.pdf$/i.test(file.name)) throw new Error('Choose a PDF reference drawing.');
          const page = Number(body.get('page') ?? 1);
          if (!Number.isSafeInteger(page) || page < 1) throw new Error('Choose a positive page number.');
          const png = await preview!(new Uint8Array(await file.arrayBuffer()), page);
          controller.signal.throwIfAborted();
          res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
          res.end(png); outcome = 'import_completed'; return;
        }
        const metadata = body.get('options');
        if (typeof metadata !== 'string' || metadata.length > 8 * 1024 * 1024) throw new Error('Import options or continuation plan are too large.');
        options = JSON.parse(metadata);
        if (!Array.isArray(options.origin) || options.origin.length !== 3 || !options.origin.every(Number.isFinite) || Math.abs(options.origin[0]) > 180 || Math.abs(options.origin[1]) > 90) throw new Error('Invalid site origin.');
        if (typeof options.instructions !== 'string' || options.instructions.length > 8000) throw new Error('Instructions must be at most 8000 characters.');
        if (options.base) options.base = validateProject(options.base);
        options.brief = readImportBrief(options.brief);
        options.checkpoint = readImportCheckpoint(options.checkpoint);
        if (options.checkpoint && options.checkpoint.projectId !== options.base?.id) throw new Error("Import checkpoint belongs to another project.");
        options.budget = readImportBudget(options.budget);
      } catch (error) { json(res, 400, { error: error instanceof Error ? error.message : 'Invalid import upload.' }); return; }
      controller.signal.throwIfAborted();
      logImport({ event: 'import_started', jobId: id, bytes: file.size, continuation: !!options.base });
      work = await mkdtemp(join(tmpdir(), 'kerros-import-'));
      // Only the allowlisted extension survives; the supplied filename can never choose a path.
      const input = join(work, `source${extname(file.name).toLowerCase()}`);
      const output = join(work, 'project.json');
      const instructionsFile = join(work, 'instructions.txt');
      await writeFile(input, new Uint8Array(await file.arrayBuffer()), { mode: 0o600 });
      await writeFile(instructionsFile, options.instructions, { mode: 0o600 });
      const baseFile = options.base ? join(work, 'base.json') : undefined;
      if (baseFile) await writeFile(baseFile, JSON.stringify(options.base), { mode: 0o600 });
      const briefFile = options.brief ? join(work, 'brief.json') : undefined;
      if (briefFile) await writeFile(briefFile, JSON.stringify(options.brief), { mode: 0o600 });
      const checkpointFile = options.checkpoint ? join(work, 'checkpoint.json') : undefined;
      if (checkpointFile) await writeFile(checkpointFile, JSON.stringify(options.checkpoint), { mode: 0o600 });
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store, no-transform', 'X-Accel-Buffering': 'no' });
      res.flushHeaders();
      const write = async (chunk: string) => {
        controller.signal.throwIfAborted();
        if (!res.write(chunk)) await new Promise<void>((resolve, reject) => {
          const clean = () => { res.off('drain', drain); controller.signal.removeEventListener('abort', abort); };
          const drain = () => { clean(); resolve(); };
          const abort = () => { clean(); reject(new Error('Import cancelled.')); };
          res.once('drain', drain);
          controller.signal.addEventListener('abort', abort, { once: true });
        });
      };
      const instructionState: NonNullable<typeof active> = { id, pending: [], received: new Map() };
      active = instructionState;
      await write(JSON.stringify({ type: 'session', jobId: id }) + '\n');
      await worker({ id, input, output, instructionsFile, baseFile, briefFile, checkpointFile, budget: options.budget, origin: options.origin, signal: controller.signal,
        onInstruction: receive => {
          instructionState.receive = receive;
          for (const instruction of instructionState.pending.splice(0)) receive(instruction);
          return () => { if (active === instructionState) active = undefined; };
        },
      }, write);
      if (active === instructionState) active = undefined;
      outcome = 'import_completed';
      if (!res.destroyed) res.end();
    } catch {
      if (!res.destroyed) {
        const error = timedOut ? 'Import reached the 15 minute limit. Try fewer pages or a smaller region.' : 'The import worker stopped. Check the backend logs and try again.';
        if (!res.headersSent) json(res, 500, { error });
        else res.end(JSON.stringify({ type: 'error', message: error }) + '\n');
      }
    } finally {
      if (active?.id === id) active = undefined;
      clearTimeout(timeout);
      res.off('close', cancel);
      logImport({ event: timedOut ? 'import_timed_out' : controller.signal.aborted ? 'import_cancelled' : outcome, jobId: id, durationMs: Date.now() - started });
      controller.abort();
      if (work) await rm(work, { recursive: true, force: true });
      busy = false;
    }
  });
}
