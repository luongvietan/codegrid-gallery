# CodeGrid RAG — two-index retrieval over the corpus

The ingest harness (`docs/harness/README.md`) gives you every project's source in
`corpus/`. This layer makes that source **retrievable and recomposable** — a design
system, not a copy-paste bin. It is a *harness*, not a fine-tune: you need exact
lookup + controlled recomposition of code that runs verbatim, and the corpus grows.

## Why not embed raw code

Embedding raw code makes syntax dominate semantics — every GSAP file looks alike in
vector space and retrieval is noise. Instead each source gets **one annotation pass**
that produces a natural-language **card** (what it looks like, how it moves, how it's
built). We embed the *card*, and keep the raw code as the payload.

## Two indexes, two jobs

| Index | Table | Job | Retrieval |
|---|---|---|---|
| **Component** | `components` | "Assemble a whole site" | retrieve a section, adapt it |
| **Technique** | `techniques` | "Invent a new site" | retrieve a technique, write fresh code, cite 2–3 examples for exact syntax |

Retrieve only components → you get collage. Retrieve techniques and let the model write
fresh code → you get novelty. `component_techniques` links the two (a technique's
`seen_in`).

## The card (annotation) schema

`scripts/rag/schema.mjs` is the single source of truth; the SQL migration mirrors it
and a test (`schema.test.mjs`) fails if they ever drift. Three rules:

1. **Hard fields are enums, never free text** — enforced by `validateCard` (with a
   retry loop in `annotate.mjs`), not by prompt-begging. Hard fields drive `WHERE`.
2. **Soft tags + `description` + `retrieval_probes` drive the embedding.**
3. **`description` describes the OUTPUT** ("headline bleeds off both edges"), never the
   code ("uses `.hero-wrapper`").

Key fields: `scope` (section/global/overlay — a cursor is **not** a section),
`side_effects` (the anti-Frankenstein field — see the conflict matrix), `design_tokens`
(the normalize pass reads these to force 8 sections into one system), `content_slots`
(`max_chars` so the composer knows a 3-word headline breaks at 12), and
`retrieval_probes` (3–5 phrases a *designer* would type — the single highest-leverage
field for recall, because it matches query-space to query-space).

See `docs/harness/cards/reference-hero.json` and `reference-cursor.json` for two
spec-perfect exemplars (both pass `validateCard`).

## Conflict matrix (enforced at the retriever, via `side_effects`)

| Side effect | Rule |
|---|---|
| `scroll_hijack` | ≤ 1 per site. Two = scroll dies. |
| `own_raf_loop` | Merge into one loop. Many = dropped frames. |
| `body_overflow_lock` | Overlays only. A section locking = page can't scroll. |
| `canvas_fullscreen` | ≤ 1–2. More = GPU dies on weak machines. |
| `scrolltrigger_register` | Many OK, but one GSAP instance + `refresh()` after assembly. |

Plus: `lenis` **and** `locomotive` on one page = reject. These are `WHERE`/exclude
filters (`--exclude-hijack`, `--exclude-lib locomotive`), not composer patches.

## Pipeline

| Step | Command | Needs |
|---|---|---|
| 0. Migrate | `psql < supabase/migrations/0001_codegrid_rag.sql` (or Supabase SQL editor) | a Supabase/Postgres project |
| 1. Annotate | `ANTHROPIC_API_KEY=… node scripts/rag/annotate.mjs --limit 20` | corpus + `@anthropic-ai/sdk` |
| 2. Embed | `VOYAGE_API_KEY=… node scripts/rag/embed.mjs` (add `--supabase` to upsert) | an embedding key |
| 3. **Eval (DB-free)** | `VOYAGE_API_KEY=… node scripts/rag/eval.mjs` | embedded cards on disk |
| 4. Search | `node scripts/rag/search.mjs "dark editorial hero" --type hero --exclude-hijack` | cards (`--supabase` for the RPC) |

Step 3 is the "measure before you index 400" gate: 20 diverse sources
(`node scripts/rag/select-diverse` logic is in `retrieval.mjs`), 10 briefs
(`eval-briefs.sample.json`), top-3 hit rate. **Two failure signals mean fix the schema,
not the model:** near-identical cards (schema lacks discriminating power → tighten
`description` part (a)) or a correct brief that misses (probes use code vocabulary → fix
annotator rule 3). `schema_version` is in the table from v1 so a schema fix is a
re-annotate, not a migration.

## Decisions you should confirm

- **Embedding provider.** Claude has no embeddings endpoint. Default is Voyage
  `voyage-3` (dim **1024**, matches the migration; needs `VOYAGE_API_KEY`). To use
  OpenAI (`text-embedding-3-small`, dim 1536) set `EMBED_PROVIDER=openai` **and** change
  every `vector(1024)` in the migration to `vector(1536)`. Never commit the key — pass
  it as an env var / secret.
- **Where to run.** Annotate/embed need the corpus + API keys, so they run on your
  machine or CI — not inside an egress-restricted sandbox (where R2 is blocked).
- **Which Supabase project.** The migration is a file on purpose — run it against a
  dedicated codegrid project you create, not an unrelated one.

## Not yet built (deliberate next passes)

- **Technique extraction** — a second annotation pass that mines `techniques` rows from
  the components (the "write fresh code" index). The table + join exist; the extractor
  doesn't.
- **Composer + normalize pass** — plan skeleton → retrieve per slot → normalize
  `design_tokens` → merge. This is where Frankenstein is actually prevented.
- **Visual feedback loop** — Playwright screenshot → VLM critique → fix. This is what
  turns the pipeline into an agent; without it you have a demo.
