const EVENTS = new Set([
  'import_started', 'import_completed', 'import_failed', 'import_cancelled', 'import_timed_out',
  'context_complete', 'turn_start', 'turn_complete', 'turn_error', 'tool_start', 'tool_complete', 'tool_error', 'tool_refused',
  'usage', 'document_saved', 'worker_started', 'worker_completed', 'worker_failed',
]);
const TOOLS = new Set(['analyse_source', 'find_similar_symbols', 'calibrate_source', 'query_candidates', 'inspect_candidate', 'render_analysis_overlay', 'set_import_notes', 'list_layers', 'extract', 'render', 'preview_candidate_edits', 'apply_candidate_edits', 'select_mutation_tools', 'apply_mutations', 'inspect_document', 'render_document', 'unknown']);
/** Allowlisted metadata only: never persist prompts, tool arguments, documents or SDK errors. */
export function importLogRecord(fields: Record<string, unknown>): Record<string, unknown> | undefined {
  if (typeof fields.event !== 'string' || !EVENTS.has(fields.event)) return;
  const record: Record<string, unknown> = { component: 'ai-import', event: fields.event };
  if (typeof fields.jobId === 'string' && /^[\da-f-]{36}$/.test(fields.jobId)) record.jobId = fields.jobId;
  if (typeof fields.tool === 'string' && TOOLS.has(fields.tool)) record.tool = fields.tool;
  for (const key of ['estimatedTokens', 'contextLimit', 'turn', 'turns', 'mutations', 'durationMs', 'objects', 'barriers', 'floors', 'bytes', 'status', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']) {
    if (Number.isSafeInteger(fields[key]) && (fields[key] as number) >= 0) record[key] = fields[key];
  }
  if (typeof fields.compacted === 'boolean') record.compacted = fields.compacted;
  if (typeof fields.continuation === 'boolean') record.continuation = fields.continuation;
  return record;
}
export function logImport(fields: Record<string, unknown>, write = (line: string) => { process.stderr.write(line); }) {
  const record = importLogRecord(fields);
  if (record) write(JSON.stringify({ time: new Date().toISOString(), ...record }) + '\n');
}
