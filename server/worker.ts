import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import type { ImportWorker } from './aiImportServer';
import { logImport } from '../scripts/plan-import/logging';

export const runImportWorker: ImportWorker = async (job, write) => {
  job.signal.throwIfAborted();
  const child = spawn(process.execPath, [
    resolve('node_modules/vite-node/vite-node.mjs'), resolve('scripts/plan-import/agent.ts'), '--', job.input,
    '--out', job.output, '--origin', job.origin.join(','), '--max-turns', String(job.budget?.maxTurns ?? 40), '--events', '--instructions-file', job.instructionsFile,
    ...(job.baseFile ? ['--base', job.baseFile] : []),
    ...(job.briefFile ? ['--brief-file', job.briefFile] : []),
    ...(job.checkpointFile ? ['--checkpoint-file', job.checkpointFile] : []),
    ...(job.budget ? ['--max-input-tokens', String(job.budget.inputTokens), '--max-output-tokens', String(job.budget.outputTokens)] : []),
  ], { stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
  // An instruction accepted just as the worker exits remains pending in the browser until
  // its checkpoint acknowledges it. A closed stdin must not crash the API process.
  child.stdin.on('error', () => {});
  const detachInstructions = job.onInstruction?.(instruction => {
    if (child.stdin.destroyed || child.exitCode !== null) throw new Error('Import run has ended.');
    child.stdin.write(JSON.stringify(instruction) + '\n');
  });
  child.stdout.setEncoding('utf8');
  let forceKill: ReturnType<typeof setTimeout> | undefined;
  const kill = (signal: NodeJS.Signals) => {
    if (!child.pid) return;
    try { process.platform === 'win32' ? child.kill(signal) : process.kill(-child.pid, signal); } catch { /* already exited */ }
  };
  const cancel = () => { kill('SIGTERM'); forceKill = setTimeout(() => kill('SIGKILL'), 2000); forceKill.unref(); };
  job.signal.addEventListener('abort', cancel, { once: true });
  const finished = new Promise<number | null>((resolveExit, reject) => { child.once('error', reject); child.once('close', resolveExit); });
  // Observe a launch failure immediately, even before stdout is read.
  void finished.catch(() => {});
  child.stderr.setEncoding('utf8');
  let pendingLog = '';
  child.stderr.on('data', (chunk: string) => {
    pendingLog += chunk;
    let newline: number;
    while ((newline = pendingLog.indexOf('\n')) >= 0) {
      const line = pendingLog.slice(0, newline);
      pendingLog = pendingLog.slice(newline + 1);
      try {
        const record = JSON.parse(line);
        if (record?.component === 'ai-import') logImport({ ...record, jobId: job.id });
      } catch { /* Never forward raw third-party/SDK diagnostics. */ }
    }
    if (pendingLog.length > 64_000) pendingLog = '';
  });
  try {
    for await (const chunk of child.stdout) await write(chunk.toString());
    const code = await finished;
    if (code !== 0 && !job.signal.aborted) throw new Error('Import worker exited unsuccessfully.');
  } finally {
    detachInstructions?.();
    child.stdin.end();
    job.signal.removeEventListener('abort', cancel);
    if (child.exitCode === null) kill('SIGKILL');
    await finished.catch(() => {});
    if (forceKill) clearTimeout(forceKill);
  }
};
