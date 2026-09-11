// Apply a mutation script to a Kerros document — the write side of the plan-import toolkit.
//
//   npx vite-node scripts/plan-import/apply.ts -- script.json --out doc.json --svg doc.svg
//
// The script file is JSON: { name?, origin?: [lng,lat,bearing?], base?: "doc.json",
// mutations: Mutation[] }. Without `base` the mutations run against a fresh single-floor project at
// `origin` (default: Helsinki). Everything goes through applyMutations, so the run is atomic: the
// output document exists only if every mutation applied and every validity rule passed — the same
// guarantee the editor gives, which is what makes this safe to hand to an AI agent.
//
// --svg renders the RESULT (walls, spaces, openings, labels) so the outcome can be compared
// against a rendering of the source drawing by eye — human or vision-model.
import { readFileSync, writeFileSync } from 'node:fs';
import { applyMutations, emptyProject, geoOrigin, type Mutation, type ProjectDocument } from '../../src/schema';
import { documentSvg } from '../../src/import';

const args = process.argv.slice(2).filter(a => a !== '--');
const input = args.find(a => !a.startsWith('--'));
const opt = (name: string, fallback?: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? (args[i + 1] ?? fallback) : fallback;
};
if (!input) {
  console.error('usage: apply.ts <script.json> [--out doc.json] [--svg doc.svg]');
  process.exit(2);
}

interface Script {
  name?: string;
  origin?: [number, number, number?];
  base?: string;
  mutations: Mutation[];
}
const script: Script = JSON.parse(readFileSync(input, 'utf8'));
const base: ProjectDocument = script.base
  ? JSON.parse(readFileSync(script.base, 'utf8'))
  : emptyProject(geoOrigin(script.origin ? [script.origin[0], script.origin[1]] : [24.938, 60.169], script.origin?.[2]), script.name ?? 'Imported plan');

const result = applyMutations(base, script.mutations ?? []);
if (!result.ok) {
  console.error(`REFUSED: ${result.error}`);
  process.exit(1);
}
const doc = result.project;
console.log(
  `ok: ${script.mutations.length} mutations -> ${doc.objects.length} objects, ${doc.barriers.length} barriers, ` +
    `${doc.zones?.length ?? 0} zones, ${doc.portals?.length ?? 0} portals`,
);
for (const [i, o] of (result.outcomes ?? []).entries())
  if (o !== undefined) console.log(`  #${i} ${script.mutations[i].kind}: ${typeof o === 'object' ? ((o as { id?: string }).id ?? JSON.stringify(o)) : o}`);

const out = opt('out');
if (out) {
  writeFileSync(out, JSON.stringify(doc, null, 1));
  console.log(`document -> ${out}`);
}

const svgPath = opt('svg');
if (svgPath) {
  writeFileSync(svgPath, documentSvg(doc));
  console.log(`render -> ${svgPath}`);
}
