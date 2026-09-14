import modelSchema from './modelSchema.json';
import type { AiToolSpec } from './aiImport';

type Schema = { [key: string]: unknown };
const definitions = modelSchema.definitions as Record<string, Schema>;
const variants = modelSchema.mutation.anyOf;
const dereference = (ref: string) => definitions[ref.slice('#/$defs/'.length)];
const kind = (variant: { $ref: string }) =>
  (dereference(variant.$ref).properties as Record<string, { const?: string }>).kind.const!;
export const MUTATION_KINDS = variants.map(kind);
export const DEFAULT_MUTATION_KINDS = [
  'addBarrier',
  'drawBarrier',
  'drawBoundary',
  'patchBarrier',
  'encloseRoom',
  'removeBarrier',
];

export function readMutationKinds(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    !value.length ||
    value.length > MUTATION_KINDS.length ||
    value.some(k => typeof k !== 'string' || !MUTATION_KINDS.includes(k))
  )
    throw new Error('Choose mutation kinds from the available catalog.');
  return [...new Set(value)] as string[];
}

/** Preserve the generated schemas verbatim, but send only definitions reachable from the
 * requested mutations. Every core operation remains discoverable without paying for all
 * object/roof/navigation/lighting fields on every geometry turn. */
export function mutationTool(kinds: string[]): AiToolSpec {
  const selected = new Set(readMutationKinds(kinds));
  const anyOf = variants.filter(v => selected.has(kind(v)));
  const needed: Record<string, Schema> = {};
  const visit = (value: unknown) => {
    if (!value || typeof value !== 'object') return;
    if ('$ref' in value && typeof value.$ref === 'string') {
      const name = value.$ref.slice('#/$defs/'.length);
      if (!needed[name]) {
        needed[name] = dereference(value.$ref);
        visit(needed[name]);
      }
    }
    for (const child of Object.values(value)) visit(child);
  };
  visit(anyOf);
  return {
    name: 'apply_mutations',
    description:
      'Apply mutations atomically through the full core validation. Nothing changes on refusal. Outcomes contain generated IDs. Use select_mutation_tools to load other operations from the complete catalog; inspect_document retrieves current IDs.',
    inputSchema: {
      type: 'object',
      $defs: needed,
      properties: {
        mutations: { type: 'array', maxItems: 100, items: { anyOf } },
        reset: { type: 'boolean', description: 'Discard the working document. Never use for a continuation.' },
      },
      required: ['mutations'],
      additionalProperties: false,
    },
  };
}

export const selectMutationTools: AiToolSpec = {
  name: 'select_mutation_tools',
  description:
    'Load the exact schemas for the next editing task, replacing the current mutation selection. All core operations are available in this catalog. Select only the few needed now; their full nested fields appear in apply_mutations on the NEXT turn. No model changes.',
  inputSchema: {
    type: 'object',
    properties: {
      kinds: {
        type: 'array',
        items: { type: 'string', enum: MUTATION_KINDS },
        minItems: 1,
        maxItems: MUTATION_KINDS.length,
      },
    },
    required: ['kinds'],
    additionalProperties: false,
  },
};
