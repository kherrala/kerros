export interface ImportInstruction {
  id: string;
  text: string;
}
export function readImportInstruction(value: unknown): ImportInstruction {
  const m = value as ImportInstruction;
  if (
    !m ||
    typeof m.id !== 'string' ||
    !/^[a-zA-Z0-9_-]{1,100}$/.test(m.id) ||
    typeof m.text !== 'string' ||
    !m.text.trim() ||
    m.text.length > 2000
  )
    throw new Error('Instructions must contain 1–2,000 characters and a valid message ID.');
  return { id: m.id, text: m.text.trim() };
}
/** Keep the latest human steering separately from model-authored notes. */
export function mergeImportInstructions(...groups: ImportInstruction[][]): ImportInstruction[] {
  const merged = [
    ...new Map(
      groups
        .flat()
        .map(readImportInstruction)
        .map(m => [m.id, m]),
    ).values(),
  ];
  while (merged.length > 20 || JSON.stringify(merged).length > 8000) merged.shift();
  return merged;
}
