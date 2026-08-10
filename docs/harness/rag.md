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
| 0. Migrate | `psql < supabase/migrations/0001_codegrid_rag.sql`, then `0002_search_techniques.sql` | a Supabase/Postgres project |
| 1. Annotate | `ANTHROPIC_API_KEY=… node scripts/rag/annotate.mjs --limit 20` | corpus + `@anthropic-ai/sdk` |
| 2. Embed | `VOYAGE_API_KEY=… node scripts/rag/embed.mjs` (add `--supabase` to upsert) | an embedding key |
| 3. **Eval (DB-free)** | `VOYAGE_API_KEY=… node scripts/rag/eval.mjs` | embedded cards on disk |
| 4. Search | `node scripts/rag/search.mjs "dark editorial hero" --type hero --exclude-hijack` | cards (`--supabase` for the RPC) |
| 5. Techniques | `node scripts/rag/extract-techniques.mjs` → `embed.mjs --techniques` → `search.mjs "…" --techniques` | cards + the same keys |
| 6. Compose | `node scripts/rag/compose.mjs "dark editorial studio site"` | embedded cards (+ techniques) |

## The technique pass (step 5)

`extract-techniques.mjs` reads the component cards and mines the *mechanisms* out of
them — "staggered char reveal", "pinned section with scrubbed timeline" — into
`corpus/techniques/index.json`, then `component_techniques` links each back to the
components that exhibit it (`seen_in`).

Three decisions carry the whole pass:

- **Sequential, not concurrent.** Every call is handed the vocabulary mined so far
  and told to reuse a name verbatim when it matches. Run four workers in parallel and
  the same technique gets four names — the index multiplies instead of converging.
  Convergence *is* the product here, so the pass trades wall-clock for it.
- **Prose is first-writer-wins; evidence accumulates.** `name`/`mechanism`/
  `description` are frozen by the first card that mines a technique — they are what
  gets embedded, so letting card #40 rewrite them would silently invalidate the
  stored vector. `animation_libs`, `variations`, `retrieval_probes`, `seen_in`, and
  `params` merge across every sighting; numeric params widen into `[min, max]`
  ranges, which is the form the composer actually needs ("stagger lives between
  0.02 and 0.05").
- **Same validate-and-retry loop as the annotator.** Off-enum libs, fewer than 3
  probes, nested `params` objects — all rejected client-side and fed back as errors,
  so a weak free model still produces clean rows.

Checkpointed after every card: re-running skips what is already mined (`--force` redoes).

Retrieval filters on the stack only (`--lib`, `--exclude-lib`). A technique has no
`scope` or `comp_type` on purpose — that absence is exactly why it transfers to
content it was never written for.

### Run it 100% free / local (no API keys, no rate limits)

The pipeline is a **batch job**, not an interactive coding agent — so "free agent" here
means a **free model endpoint**, not Cline/Antigravity. Both LLM steps take any
OpenAI-compatible endpoint; the strongest free option is [Ollama](https://ollama.com)
running a code model locally (unlimited, private). Voyage/OpenAI stay the default; these
env vars swap in the free path.

```bash
# one-time: install Ollama, then pull a code model + an embedding model
ollama pull qwen3-coder        # annotator (strong open code model)
ollama pull bge-m3             # embeddings, dim 1024 (matches the migration)

# annotate with the local model (no ANTHROPIC_API_KEY, no @anthropic-ai/sdk needed)
LLM_PROVIDER=openai LLM_BASE_URL=http://localhost:11434/v1 LLM_MODEL=qwen3-coder \
  node scripts/rag/annotate.mjs --limit 20

# mine techniques with the same local model (same flags — one shared LLM layer)
LLM_PROVIDER=openai LLM_BASE_URL=http://localhost:11434/v1 LLM_MODEL=qwen3-coder \
  node scripts/rag/extract-techniques.mjs

# embed + eval with the local embedding model
EMBED_PROVIDER=ollama node scripts/rag/embed.mjs
EMBED_PROVIDER=ollama node scripts/rag/embed.mjs --techniques
EMBED_PROVIDER=ollama node scripts/rag/eval.mjs
```

No local GPU? Use a hosted free tier instead — same flags, different endpoint:

```bash
# annotate via OpenRouter free models (rate-limited)
LLM_PROVIDER=openai LLM_BASE_URL=https://openrouter.ai/api/v1 \
  LLM_API_KEY=sk-or-... LLM_MODEL=qwen/qwen3-coder:free node scripts/rag/annotate.mjs
```

`validateCard` + the retry loop matter most here: a weaker free model that emits an
off-enum value gets rejected and re-prompted, so the cards stay clean regardless of model.

Step 3 is the "measure before you index 400" gate: 20 diverse sources
(`node scripts/rag/select-diverse` logic is in `retrieval.mjs`), 10 briefs
(`eval-briefs.sample.json`), top-3 hit rate. **Two failure signals mean fix the schema,
not the model:** near-identical cards (schema lacks discriminating power → tighten
`description` part (a)) or a correct brief that misses (probes use code vocabulary → fix
annotator rule 3). `schema_version` is in the table from v1 so a schema fix is a
re-annotate, not a migration.

## Decisions you should confirm

- **Embedding provider.** Claude has no embeddings endpoint. Default is Voyage
  `voyage-3` (dim **1024**, matches the migration; needs `VOYAGE_API_KEY`).
  `EMBED_PROVIDER=ollama` uses local `bge-m3` (dim 1024, free); `EMBED_PROVIDER=openai`
  uses `text-embedding-3-small` (dim 1536 — then change every `vector(1024)` in the
  migration to `vector(1536)`). Never commit the key — pass it as an env var / secret.
- **LLM provider (annotate).** Default Anthropic `claude-opus-4-8`. For a free run set
  `LLM_PROVIDER=openai` + `LLM_BASE_URL`/`LLM_MODEL` at any OpenAI-compatible endpoint
  (Ollama local, OpenRouter free, DashScope). See "Run it 100% free / local" above.
- **Where to run.** Annotate/embed need the corpus + API keys, so they run on your
  machine or CI — not inside an egress-restricted sandbox (where R2 is blocked).
- **Which Supabase project.** The migration is a file on purpose — run it against a
  dedicated codegrid project you create, not an unrelated one.

## The composer (step 6)

`compose.mjs` turns a brief into a page: plan skeleton (LLM, validated against the
same enums) → retrieve per slot → **budget** → **normalize** → `BUILD.md` + `plan.json`
under `corpus/compositions/<title>/`. It emits *decisions*, not a finished site — the
code merge is left to the agent that reads the brief, and every decision is auditable,
including the rejections.

Two mechanisms do the anti-Frankenstein work, and they are the reason this is not
just "retrieve eight sections and concatenate":

- **The budget is spent in slot order** (`admit` / `planSelection`). The conflict
  matrix is enforced *at selection*: if the hero already owns `scroll_hijack`, the
  best-matching work grid that also hijacks scroll is rejected and the next-best
  compatible one is taken instead. There is no patch for "two components both own
  the scroll", so nothing conflicting is ever admitted. Top-down order is deliberate —
  the page's identity is set above the fold, so early slots get first claim.
- **One anchor, seven rewrites** (`normalizeTokens`). The first section pick's
  `design_tokens` become the page's; every other component gets an explicit
  `from → to` map for colors, font families, type sizes (snapped to the canonical
  scale), and spacing. Nothing is averaged — an averaged type scale belongs to no
  design. Where the anchor is silent, the first later pick that speaks fills the gap.

What survives selection but still needs hand-merging (several rAF loops, several
ScrollTrigger registrations, stacked fixed layers) becomes an explicit **After
assembly** checklist rather than a silent bug.

A slot with no admissible component is **not** force-filled. It is listed under
*Write these fresh* with its top techniques and their `seen_in` components — which
is exactly the job the technique index exists for.

`--plan file.json` skips the LLM planner (also how the pass is smoke-tested offline).
The composer is DB-free: it reads cards and techniques from disk, no Supabase needed.

## Not yet built (deliberate next passes)

- **Visual feedback loop** — Playwright screenshot → VLM critique → fix. This is what
  turns the pipeline into an agent; without it you have a demo.
