import { validateProject, type AiImportAdapter } from '@kerros/editor/host';
import { readImportCheckpoint, readImportPause, readImportBudget } from '../src/import/checkpoint';
import { readTokenUsage } from '../src/import/usage';
import { readAnalysisPreview } from '../src/import/analysisPreview';
import { readImportInstruction } from '../src/import/instructions';

/** Reads NDJSON across arbitrary network/UTF-8 chunk boundaries; snapshots are checked before display. */
export function createAiImportAdapter(url: string): AiImportAdapter {
  return {
    async sendInstruction(jobId, instruction) {
      if (!/^[a-zA-Z0-9_-]{1,100}$/.test(jobId)) throw new Error('Invalid import job.');
      const response = await fetch(`${url}/${jobId}/instructions`, {
        method: 'POST',
        headers: { 'X-Kerros-Import': '1', 'Content-Type': 'application/json' },
        body: JSON.stringify(readImportInstruction(instruction)),
      });
      if (!response.ok)
        throw new Error(
          (await response.json().catch(() => ({}))).error ??
            'Could not queue instructions. They remain saved for continuation.',
        );
    },
    async run(file, options) {
      const status = await fetch(url, { signal: options.signal });
      if (!status.ok) throw new Error('AI import backend is unavailable. Start it with make up.');
      if (!(await status.json()).configured)
        throw new Error('Add ANTHROPIC_API_KEY to .env.local and restart make up to enable AI import.');
      const body = new FormData();
      body.set('file', file);
      body.set(
        'options',
        JSON.stringify({
          origin: [options.origin[0], options.origin[1], options.origin[2] ?? 0],
          instructions: options.instructions,
          brief: options.brief,
          base: options.base,
          checkpoint: options.checkpoint,
          budget: readImportBudget(options.budget),
        }),
      );
      const response = await fetch(url, {
        method: 'POST',
        body,
        signal: options.signal,
        headers: { 'X-Kerros-Import': '1' },
      });
      if (!response.ok)
        throw new Error((await response.json().catch(() => ({}))).error ?? `Import failed (${response.status}).`);
      if (!response.body) throw new Error('The backend did not return an import stream.');
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let pending = '';
      let result: ReturnType<typeof validateProject> | undefined;
      const accept = async (line: string) => {
        if (!line.trim()) return;
        const event = JSON.parse(line);
        if (event.type === 'error') throw new Error(event.message || 'Import failed.');
        if (event.type === 'session') {
          if (typeof event.jobId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(event.jobId))
            throw new Error('Invalid import job.');
          await options.onSession?.(event.jobId);
        }
        if (event.type === 'text' || event.type === 'tool' || event.type === 'status') {
          if (typeof event.detail !== 'string') throw new Error('Invalid import progress message.');
          await options.onProgress({ type: event.type, detail: event.detail });
        } else if (event.type === 'usage') await options.onUsage?.(readTokenUsage(event.usage));
        else if (event.type === 'analysis') await options.onAnalysis?.(readAnalysisPreview(event.preview));
        else if (event.type === 'checkpoint') {
          const state = readImportCheckpoint(event.checkpoint);
          if (!state) throw new Error('Missing import checkpoint.');
          await options.onCheckpoint?.(state);
        } else if (event.type === 'document') await options.onDocument(validateProject(event.document));
        else if (event.type === 'done') {
          if (event.checkpoint) await options.onCheckpoint?.(readImportCheckpoint(event.checkpoint)!);
          if (event.pause) await options.onPause?.(readImportPause(event.pause)!);
          if (event.usage) await options.onUsage?.(readTokenUsage(event.usage));
          result = validateProject(event.document);
        }
      };
      try {
        while (true) {
          const { value, done } = await reader.read();
          pending += decoder.decode(value, { stream: !done });
          if (pending.length > 32 * 1024 * 1024) throw new Error('Import snapshot exceeded the supported size.');
          let end: number;
          while ((end = pending.indexOf('\n')) >= 0) {
            await accept(pending.slice(0, end));
            pending = pending.slice(end + 1);
          }
          if (done) break;
        }
        await accept(pending);
        options.signal.throwIfAborted();
        if (!result)
          throw new Error(
            'The import stream ended before completion. Accepted changes are saved; continue the import when ready.',
          );
        return result;
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    },
  };
}

export function createPdfDrawingAdapter(url: string) {
  return {
    async render(file: File, page: number): Promise<Blob> {
      const body = new FormData();
      body.set('file', file);
      body.set('page', String(page));
      const response = await fetch(`${url}/preview`, { method: 'POST', body, headers: { 'X-Kerros-Import': '1' } });
      if (!response.ok)
        throw new Error(
          (await response.json().catch(() => ({}))).error ?? 'PDF conversion failed. Start the backend with make up.',
        );
      if (!response.headers.get('content-type')?.startsWith('image/png'))
        throw new Error('The backend did not return a PNG drawing.');
      return response.blob();
    },
  };
}
