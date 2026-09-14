import { afterEach, expect, it, vi } from 'vitest';
import { once } from 'node:events';
import { readFile, access } from 'node:fs/promises';
import { dirname, basename } from 'node:path';
import { emptyProject, geoOrigin } from '../src/schema';
import { createAiImportServer, type ImportWorker } from './aiImportServer';
import type { ImportCheckpoint } from '../src/import/checkpoint';

const servers: ReturnType<typeof createAiImportServer>[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }))); });
async function start(worker: ImportWorker, configured = true, maxUploadBytes?: number, preview?: (bytes: Uint8Array, page: number) => Promise<Uint8Array>) {
  const server = createAiImportServer({ configured: () => configured, worker, maxUploadBytes, preview });
  servers.push(server); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return `http://127.0.0.1:${(server.address() as { port: number }).port}/api/ai-import`;
}
const headers = () => ({ 'X-Kerros-Import': '1' });
const upload = (data = 'drawing', filename = '../../unsafe/plan.pdf', base?: unknown) => {
  const form = new FormData();
  form.set('file', new File([data], filename));
  form.set('options', JSON.stringify({ origin: [24, 60, 0], instructions: 'Use page 2', base }));
  return form;
};
const post = (url: string, init: RequestInit = {}) => fetch(url, { method: 'POST', headers: headers(), body: upload(), ...init });

it('converts PDF reference pages without a Claude key and keeps preview validation separate', async () => {
  const worker = vi.fn<ImportWorker>();
  const preview = vi.fn(async (bytes: Uint8Array, page: number) => {
    expect(new TextDecoder().decode(bytes)).toBe('drawing'); expect(page).toBe(2);
    return new Uint8Array([137, 80, 78, 71]);
  });
  const url = await start(worker, false, 25, preview);
  const body = upload(); body.delete('options'); body.set('page', '2');
  const response = await post(`${url}/preview`, { body });
  expect(response.status).toBe(200); expect(response.headers.get('content-type')).toBe('image/png');
  expect(worker).not.toHaveBeenCalled(); expect(preview).toHaveBeenCalledOnce();
  body.set('page', '0'); expect((await post(`${url}/preview`, { body })).status).toBe(400);
  body.set('page', '2');
  expect((await post(`${url}/preview`, { body, headers: { ...headers(), Origin: 'https://example.com' } })).status).toBe(403);
  expect((await post(url)).status).toBe(503);
});

it('streams changes before completion, excludes concurrent jobs, and removes uploaded files', async () => {
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  let directory = '';
  const url = await start(async (job, write) => {
    directory = dirname(job.input);
    expect(basename(job.input)).toBe('source.pdf');
    expect(await readFile(job.input, 'utf8')).toBe('drawing');
    expect(await readFile(job.instructionsFile, 'utf8')).toBe('Use page 2');
    await write('{"type":"text","detail":"Inspecting page 2"}\n');
    await gate;
    await write('{"type":"done"}\n');
  });
  const response = await post(url);
  expect(response.status).toBe(200);
  const reader = response.body!.getReader();
  let initial = '';
  while (!initial.includes('Inspecting page 2')) { const part = await reader.read(); if (part.done) break; initial += new TextDecoder().decode(part.value); }
  expect(initial).toContain('Inspecting page 2');
  expect((await post(url)).status).toBe(409);
  release();
  let rest = ''; while (true) { const part = await reader.read(); if (part.done) break; rest += new TextDecoder().decode(part.value); }
  expect(rest).toContain('done');
  await expect.poll(async () => { try { await access(directory); return true; } catch { return false; } }).toBe(false);
});

it('aborts the worker when the browser cancels', async () => {
  let aborted = false;
  const url = await start(async (job, write) => {
    const stopped = new Promise<void>(resolve => job.signal.addEventListener('abort', () => { aborted = true; resolve(); }, { once: true }));
    await write('{"type":"text","detail":"Working"}\n'); await stopped;
  });
  const controller = new AbortController();
  const response = await post(url, { signal: controller.signal });
  await response.body!.getReader().read();
  controller.abort();
  await expect.poll(() => aborted).toBe(true);
  await expect.poll(async () => (await (await fetch(url)).json()).busy).toBe(false);
});

it('reports missing configuration without starting a worker', async () => {
  const worker = vi.fn<ImportWorker>(); const url = await start(worker, false);
  expect(await (await fetch(url)).json()).toMatchObject({ configured: false });
  expect((await post(url)).status).toBe(503);
  expect(worker).not.toHaveBeenCalled();
});

it('rejects unsupported input, oversized uploads and cross-origin spending attempts', async () => {
  const worker = vi.fn<ImportWorker>(); const url = await start(worker, true, 10);
  expect((await post(url, { body: upload('more than ten bytes') })).status).toBe(413);
  expect((await post(url, { headers: { ...headers(), Origin: 'https://unrelated.example' } })).status).toBe(403);
  expect((await post(url, { headers: {} })).status).toBe(403);
  expect((await post(url, { body: upload('x', 'run.sh') })).status).toBe(400);
  expect((await post(url, { body: upload('') })).status).toBe(400);
  expect(worker).not.toHaveBeenCalled();
});

it('validates and passes continuation geometry to the isolated worker', async () => {
  const base = emptyProject(geoOrigin([24, 60]), 'Saved draft');
  let received = '';
  const url = await start(async (job, write) => {
    expect(job.baseFile).toBeDefined();
    received = JSON.parse(await readFile(job.baseFile!, 'utf8')).name;
    await write('{"type":"done"}\n');
  });
  const invalid = await post(url, { body: upload('image', 'plan.png', { broken: true }) });
  expect(invalid.status).toBe(400);
  await invalid.text();
  const response = await post(url, { body: upload('image', 'plan.png', base) });
  expect(response.status).toBe(200); await response.text();
  expect(received).toBe('Saved draft');
});

it('passes the validated import template to the worker and rejects invalid scale inputs', async () => {
  let received: unknown;
  const url = await start(async (job, write) => {
    received = JSON.parse(await readFile(job.briefFile!, 'utf8'));
    await write('{"type":"done"}\n');
  });
  const form = upload();
  const brief = { buildingType: 'house', floorCount: 2, widthMetres: 20, footprintAreaM2: 150 };
  form.set('options', JSON.stringify({ origin: [24, 60, 0], instructions: '', brief }));
  const response = await post(url, { body: form });
  await response.text();
  expect(received).toEqual(brief);
  await expect.poll(async () => (await (await fetch(url)).json()).busy).toBe(false);
  form.set('options', JSON.stringify({ origin: [24, 60, 0], instructions: '', brief: { widthMetres: -20 } }));
  expect((await post(url, { body: form })).status).toBe(400);
});

it('passes bounded semantic checkpoints and explicit budgets to the worker, rejecting a foreign project', async () => {
  const base = emptyProject(geoOrigin([24,60]));
  const checkpoint: ImportCheckpoint = { version:1, projectId:base.id, phase:'build', notes:'Next doors', sourcePlan:'Exterior complete',
    mutationKinds:['addObject'], analysis:[], lastAssistantText:'', lastToolReport:'', calibration:{metresPerUnit:0.02,basis:'User width'} };
  const url = await start(async (job,write) => {
    expect(JSON.parse(await readFile(job.checkpointFile!, 'utf8'))).toEqual(checkpoint);
    expect(job.budget).toEqual({inputTokens:100_000,outputTokens:12_000,maxTurns:80});
    await write(JSON.stringify({type:'done',document:base,checkpoint,pause:{reason:'input-budget',message:'Saved'}})+'\n');
  });
  const form = upload();
  const options = { origin:[24,60,0],instructions:'',base,checkpoint,budget:{inputTokens:100_000,outputTokens:12_000,maxTurns:80} };
  form.set('options',JSON.stringify(options));
  const response = await post(url,{body:form});
  expect(response.status).toBe(200);
  expect(await response.text()).toContain('input-budget');
  await expect.poll(async () => (await (await fetch(url)).json()).busy).toBe(false);
  form.set('options',JSON.stringify({...options,checkpoint:{...checkpoint,projectId:'another-project'}}));
  expect((await post(url,{body:form})).status).toBe(400);
  form.set('options',JSON.stringify({...options,budget:{inputTokens:Infinity,outputTokens:12000}}));
  expect((await post(url,{body:form})).status).toBe(400);
});

it('queues only bounded same-origin instructions for the active job, without starting another worker', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => {release = resolve;});
  const received: unknown[] = [];
  const worker = vi.fn<ImportWorker>(async (job,write) => {
    const detach = job.onInstruction!(m => received.push(m));
    await gate;
    detach();
    await write('{"type":"done"}\n');
  });
  const url = await start(worker);
  const response = await post(url);
  const reader = response.body!.getReader();
  const event = JSON.parse(new TextDecoder().decode((await reader.read()).value).trim());
  expect(event.type).toBe('session');
  const commandUrl = `${url}/${event.jobId}/instructions`;
  const command = {id:'message-1',text:'Keep the kitchen open.'};
  const send = (body = command, urlOverride = commandUrl, origin?: string) => fetch(urlOverride,{method:'POST',headers:{...headers(),'Content-Type':'application/json',...(origin ? {Origin:origin} : {})},body:JSON.stringify(body)});
  expect((await send(command,commandUrl,'https://unrelated.example')).status).toBe(403);
  expect((await send(command,`${url}/wrong/instructions`)).status).toBe(409);
  expect((await send({id:'bad',text:'x'.repeat(2001)})).status).toBe(400);
  expect((await send()).status).toBe(202);
  expect((await send()).status).toBe(202);
  expect(received).toEqual([command]);
  expect(worker).toHaveBeenCalledOnce();
  release();
  while (!(await reader.read()).done) { /* consume completion */ }
  expect((await send()).status).toBe(409);
});
