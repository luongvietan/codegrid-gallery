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
| 7. Critique | `node scripts/rag/critique.mjs ./out/index.html --composition corpus/compositions/studio-site` | a rendered page + a vision model |

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
  `LLM_PROVIDER=deepseek` is a preset for the same transport: it reads
  `DEEPSEEK_API_KEY` and defaults to `deepseek-v4-flash` (the cheap end — 422
  annotations is a lot of calls, and the validate-and-retry loop is what keeps a
  cheaper model's cards clean). `LLM_MODEL=deepseek-v4-pro` for the stronger one;
  step 3's eval is what should decide whether it earns the difference.
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

## The visual feedback loop (step 7)

Every pass before this one reasons about code through *text*. A card claims "the
headline bleeds off both edges" and retrieval simply believes it; nothing has ever
looked at the result. `critique.mjs` renders the assembled page (desktop 1440 and a
real 390px touch phone), hands both screenshots to a vision model, and validates the
answer against `validateCritique` — the same enum-and-retry discipline as every other
LLM step here.

What makes it a loop rather than a review:

- **Findings are addressed, not observed.** Each finding names a slot; the fix plan
  resolves that slot through the composition's `plan.json` to the component that
  produced it and the corpus path of its source. "The hero is too tall" is a review;
  "`src_042`, which you took for the hero, is too tall, source at `corpus/src_042/`"
  is a work order.
- **The verdict cannot lie.** `ship` alongside a blocker finding fails validation and
  is sent back. The pass exists to stop the pipeline from congratulating itself.
- **It gates.** A blocker exits non-zero, so a build loop can refuse to finish.
- **Pages are pre-scrolled before capture.** Most of this corpus is scroll-driven; a
  page that is never scrolled shows its entry state forever and the model would be
  reviewing an empty screen.

Playwright is an **optional** dependency (`npm i playwright && npx playwright install
chromium`) — the repo stays dependency-free, and `--shots a.png,b.png` critiques
images you already have, with no browser at all. `VISION_MODEL` overrides the chat
model, because a strong code model (`qwen3-coder`) usually cannot see; locally,
`ollama pull qwen2.5vl` covers it.

Applying the fixes is deliberately **not** automated: that is a code edit, and a
script doing it blind would be guessing. The loop is render → critique → the agent
edits → render again, until blockers reach zero.

## What the first real run measured

Every step has now run against the live archive at least once. The numbers below
are from that run, not from tests.

| | |
|---|---|
| Ingest | 422/422 projects, 2357 files, 33.8 MB of text, 0 failures, ~13 min |
| Annotate | 422/422 cards, 0 failures |
| Embed | 422 cards in 13s (voyage-3, once the free tier's 3 RPM cap was lifted) |
| Techniques | 422/422 cards mined, 600 techniques, 61 seen in more than one component |
| Retrieval | the intended component in the top 3 for **25/30** corpus-grounded briefs |
| Compose | 5-9 slots planned, filled from the index or sent to fresh code with citations |
| Critique | runs on a live page; needs a model that can see |

Read precision@3 (32%) with care: a brief generated from one page describes *that*
page, so of three results only one can satisfy it, and ~33% is the ceiling rather
than a verdict. Judge verdicts also move run to run — treat all of this as
approximate and never compare two runs by a few points.

Choosing a model, measured on three identical annotate prompts:

| | deepseek-v4-flash | gpt-5.6-luna |
|---|---|---|
| latency per card | 31.4s | 10.1s |
| output tokens | 3624 | 1101 |
| 422-card pass | ~$0.61 | ~$0.81 |
| accepts images | no | yes |

DeepSeek is cheaper; luna is three times faster and is the only one of the two
that can run `critique.mjs` at all. `LLM_PROVIDER=openai LLM_MODEL=gpt-5.6-luna`
switches; the token-field difference between them is handled automatically.

## Still missing

- **No eval for the composer or the critique.** Retrieval is measured; whether a
  composition is *good*, and whether a critique's findings are *right*, is not.
- **The corpus goes stale.** `data/index.json` grows with the daily sync — a
  critique run caught the gallery reporting 430 projects against a 422-card
  corpus. Re-run the ingest to catch up; it resumes and skips what it has.
- **The fix loop does not reach zero blockers.** Five iterations of
  assemble → critique → fix → rebuild on one composition went
  reject/2 → revise/1 → reject/2 → revise/2 → revise/1. Real faults were fixed and
  stayed fixed — broken assets went from 3 to 0 and are verified by counting
  referenced urls against files on disk — but the last blocker is a trade-off,
  not a bug: `overflow: hidden` stops one section's absolutely-positioned content
  painting across the next, and clips content that meant to overflow.
## Reuse against generation, measured

`generate.mjs` writes a slot instead of transplanting one: the model gets the
page's tokens, the slot's intent, and the techniques mined from the corpus —
mechanism, parameter ranges, and a real code excerpt from a component that
exhibits each, cited for syntax and not for markup.

The same composition, same brief, same critique model, built two ways and judged
twice each:

| build | run 1 | run 2 |
|---|---|---|
| 3 components reused + 3 sections written | revise 2/5, **2 blockers** | revise 3/5, **1 blocker** |
| all 7 sections written | revise 3/5, **0 blockers** | revise 3/5, **0 blockers** |

The written page reaches zero blockers on both runs; the hybrid does not, and its
surviving blocker is the same reused component both times. Attribution in the
hybrid run is the same story: every blocker and major landed on a transplanted
component, and the three written sections drew one minor between them.

What the written page still gets wrong is polish — a headline that wraps badly, a
section title clipped at a viewport edge, low-contrast secondary copy. Those are
notes a designer gives; the reused page's faults were closer to "this control is
unusable".

Scope this honestly: one composition, one brief, two runs per build, and a judge
that is not deterministic. It is evidence that generating beats transplanting
*here*, not a benchmark.

### Four briefs, and a different conclusion

Repeating the A/B on three deliberately unlike briefs changed the reading:

| brief | plan | A — components reused | B — all written |
|---|---|---|---|
| dark editorial studio | 3 filled | revise 2/5, 1–2 blockers | revise 3/5, **0 blockers** |
| ceramics shop (bright, commercial) | **0 filled** | **cannot be built** | revise 3/5, 0 blockers |
| developer tool (documentation) | **0 filled** | **cannot be built** | revise 3/5, 1 blocker |
| illustrator portfolio (maximalist) | 2 filled | reject 1/5, 2 blockers | reject 2/5, **2 blockers** |

Generation does not simply win. On the maximalist brief the two tie on blockers.
What actually separates the rows is **domain**: the best available similarity for
an in-domain brief is 0.59–0.69, and for ceramics or a dev tool it is 0.27–0.44 —
below the floor for every slot. This corpus is an archive of dark editorial
awwwards rebuilds. Outside that, there is nothing to reuse, and generation is not
the better path so much as the only one.

The floor is doing its job in those runs, not misfiring: refusing a 0.3 match is
the difference between a page with a wrong section and a page with an honest gap.

### In domain, there is no winner

Out of domain the question answers itself. Repeating the A/B where the index does
have good components — two runs per build, since the judge is not deterministic:

| brief | plan | A — reused | B — all written |
|---|---|---|---|
| photography studio | 6 filled | 1 blocker / 6 findings, 1 blocker / 5 | 1 blocker / 1 finding, 1 blocker / 1 |
| editorial agency | 4 filled | **0 blockers** twice | 0 blockers / 3, **1 blocker** / 1 |
| product launch | 0 filled | (excluded — nothing to compare) | — |

Blockers tie on photography and are marginally *better* for reuse on agency, where
A was stable at zero across both runs and B was not. Generation's real advantage
is total findings: 1 against 5–6.

That advantage is partly confounded. Measuring what is actually on each page:
the photography B page carries more than A (8 sections, 284 nodes, 1749 chars of
text against 4/90/839) and still drew fewer findings, which is a genuine win. The
agency B page carries *less* (896 chars and one visual against 2011 and fourteen),
so some of its quiet is simply less surface to criticise.

That reading was itself an artifact, and supporting React exposed it.

### The tie was an artifact of building fewer sections

Those A builds skipped every React pick — 139 of 430 projects — so "reuse" was
being judged on a half-built page. With React bundling in place, the same
compositions rebuild with more sections, and get **worse**:

| brief | A, React skipped | A, React building | B, all written |
|---|---|---|---|
| photography | 4 sections — 1, 1 blocker | 6 sections — **3, 2** blockers | 8 sections — 1, 1 blocker |
| agency | 2 sections — 0, 0 blockers | 4 sections — **2, 1** blockers | 5 sections — 0, 1 blocker |

Reuse did not improve when it got more to work with. It got worse, because each
additional component brings another finished design onto the page, and the faults
accumulate. Generation now wins in domain as well as out of it — and the earlier
tie was reuse being flattered by a page it could only half fill.

**The default still stands** — reuse above the similarity floor, write below it —
but on weaker grounds than before: it is now a claim about cost and provenance,
not about the result being better. If the measure is blockers, writing every
section wins in all four briefs measured.

That experiment also found a real bug. The planner was shown the inventory of the
**whole** corpus while the query's filters left a tenth of it, so it planned a
footer slot with zero eligible candidates. Inventory is now computed after the
filters — a plan can only ask for what this query can actually supply.
