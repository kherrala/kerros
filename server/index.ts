import { loadImportEnv } from '../scripts/plan-import/env';
import { createAiImportServer } from './aiImportServer';
import { runImportWorker } from './worker';
import { renderPdfDrawing } from '../src/server';

loadImportEnv();
const port = Number(process.env.KERROS_API_PORT || 3001);
const host = process.env.KERROS_API_HOST || '127.0.0.1';
const server = createAiImportServer({ configured: () => Boolean(process.env.ANTHROPIC_API_KEY), worker: runImportWorker, preview: renderPdfDrawing });
server.listen(port, host, () => console.log(`AI import backend listening on ${host}:${port}; Claude key ${process.env.ANTHROPIC_API_KEY ? 'configured' : 'not configured'}.`));
