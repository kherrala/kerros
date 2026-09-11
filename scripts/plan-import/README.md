# plan-import — DWG → Kerros tooling, human- and agent-operable

Convert architectural CAD drawings into Kerros documents. Every command works standalone for a
person; together they are the tool surface for an AI import agent (`agent.ts`).

Requires [LibreDWG](https://www.gnu.org/software/libredwg/) for DWG parsing: `brew install libredwg`.

## The pipeline

```sh
# 1. What's in the drawing? Per-layer census, bounding boxes.
node scripts/plan-import/extract.mjs plan.dwg --expand --units m --stats

# 2. Pull a slice as normalized JSON (coordinates in metres, INSERTs flattened).
node scripts/plan-import/extract.mjs plan.dwg --expand --units m \
  --layers '^(12_|27_|55_)' --out slice.json

# 3. Look at it (SVG, or PNG via the repo's Playwright).
node scripts/plan-import/render.mjs slice.json --legend --png slice.png

# 4. Author the Kerros document as a Mutation[] script — atomic, validated, rendered.
npx vite-node scripts/plan-import/apply.ts -- script.json --out doc.json --svg doc.svg
```

`extract.mjs` understands the Vertex BD structure common to Finnish prefab drawings: the plan lives
in blocks of real-millimetre geometry INSERTed at plot scale, on semantically named layers
(`12_ULKOPINTA` exterior faces, `27_OVET` doors, `55_HUONETUNNUKSET` room labels, …). `--expand`
flattens the INSERT tree into one frame; `--units m` converts via `--plot-scale` (default 1:50).

## Where the logic lives

The conversion itself is the `@kerros/import` module (`src/import/`): `importPlanEntities` for the
deterministic path, `runAiPlanImport` + the provider-agnostic tool loop for the AI path. These
scripts are a *host* — they supply what the module deliberately leaves to hosts: LibreDWG
extraction, Playwright rasterization, and (for the agent) the Anthropic provider and credentials.
The reference application is another host: its import dialog's CAD plan tab feeds the same
`importPlanEntities` through the editor's transactional commit.

## The agent

```sh
# Put ANTHROPIC_API_KEY=... in .env.local (gitignored), then:
npx vite-node scripts/plan-import/agent.ts -- plan.dwg --out imported.json
```

Claude (Opus 4.8) drives the module's tool loop: inspect layers → render to *see* the plan →
extract walls/labels/openings → propose `Mutation[]` scripts → `render_document` and compare
against the source visually. Two properties make this safe:

- **Every write is a transaction.** Scripts go through `applyMutations`, so a hallucinated or
  geometrically invalid script is refused with the reason and the document is untouched — the agent
  reads the refusal and revises. The saved document is valid at every point in the run.
- **Verification is visual and closed-loop.** The agent renders both the source drawing and its own
  output as images and compares them, the same way a person would.

`--origin lng,lat,bearing` sets the geo anchor (default Helsinki); `--max-turns` caps the loop.
