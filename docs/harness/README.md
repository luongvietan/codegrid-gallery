# Code-ingest harness — "learn 100% of the gallery code"

The gallery (`app/page.tsx` → `data/index.json`) lists **422 projects** — every code
snippet CodeGrid has shared. The projects themselves are not in this repo: each is a
`CODE.zip` served from the public R2 bucket (`NEXT_PUBLIC_ASSET_BASE`, see
`.env.example`), which the browser downloads and unzips on demand (`lib/zip.ts`,
`components/tabs/CodeTab.tsx`).

This harness pulls **all** of that source down into one place so an AI agent (Claude Code,
or any tool) can read, search, and learn from 100% of it offline — turning "code shown in
a website" into a local, grep-able knowledge base.

## What it produces

Running the ingest builds a `corpus/` directory (git-ignored — it's large and derived):

```
corpus/
  <project-id>/…              # every source file from that project's CODE.zip,
                              #   minus node_modules / build output / binaries
  <project-id>/.ingest.json   # per-project record (files, langs, entry, skipped)
  manifest.json               # machine-readable index of every project + file
  search-index.jsonl          # one line per source file (id, path, lang, type)
  CORPUS.md                   # human overview: totals, languages, project table
  AGENTS.md                   # how an AI agent should navigate + learn from the corpus
```

## Pipeline

| Step | Command | What it does |
|---|---|---|
| 0. Plan (offline) | `npm run ingest:plan` | Reads `data/index.json`, prints the full 422-project download plan + total size, writes `corpus/PLAN.json`. No network — a dry run of the whole thing. |
| 1. Ingest | `npm run ingest` | Downloads every `CODE.zip`, extracts source into `corpus/<id>/`, writes the manifest/index/docs. Resumable + retrying + concurrent. |
| 2. Search | `npm run corpus:query -- "gsap scrolltrigger"` | Ranked full-text search across the whole corpus (offline). Filters: `--type html\|react\|nextjs`, `--lang CSS`, `--limit N`. |
| 3. Learn (optional) | `npm run learn` | Uses Claude (`claude-opus-4-8`) to write a `LEARNED.md` per project — a pre-digested "what this teaches" note. Requires `npm i @anthropic-ai/sdk` + `ANTHROPIC_API_KEY`. |

Useful flags on `ingest`: `--limit N` (first N projects — good smoke test), `--force`
(re-ingest), `--concurrency N` (default 6), `--base <url>` / `--out <dir>`.

## Where to run it

The R2 bucket must be reachable from wherever ingest runs.

- **Locally** — `npm run ingest` on your machine. ~3.5 GB of zips download; the extracted
  text corpus is far smaller (node_modules and binaries are skipped).
- **CI** — a GitHub Actions job can run the ingest and upload `corpus/` as a build
  artifact. (Note: some sandboxes — including Claude Code on the web — block the R2 domain
  by egress policy; there `ingest:plan` and the tests still run, but the download does not.)

## How an agent "learns" from it

Once `corpus/` exists, point Claude Code (or any agent) at it and read
`corpus/AGENTS.md`. The short version:

1. **Find before reading** — `npm run corpus:query -- "sticky cursor"` or `rg -n <pattern> corpus/`.
2. **Read the real files** under `corpus/<id>/` — that's the source of truth, not memory.
3. **Check `corpus/manifest.json`** for per-project languages, entry file, and counts.
4. If you ran step 3, skim `corpus/<id>/LEARNED.md` for a fast summary, then verify against source.

## Design notes

- **Zero runtime dependencies.** ZIP extraction is hand-rolled (`scripts/ingest-lib.mjs`,
  EOCD/central-directory walk + `zlib.inflateRaw`), matching the existing dependency-free
  `scripts/sync-lib.mjs`. Only the optional `learn` step needs a package (`@anthropic-ai/sdk`).
- **Safety.** Zip entries are path-checked (`safeRelPath`) so a malicious archive can't
  escape `corpus/<id>/` (zip-slip). Verified by `scripts/ingest.test.mjs`.
- **Tested offline.** `npm test` covers URL building, file classification, a stored+deflate
  ZIP round-trip, the extract→disk→manifest→docs pipeline, the zip-slip guard, and the
  search scorer — all without network. Real downloads are validated by `ingest:plan`.
- **Consistent with the repo.** Pure helpers in `*-lib.mjs`, tests in `*-lib.test.mjs`,
  I/O in the orchestrator — same shape as the daily-sync harness in `scripts/`.

## Files

```
scripts/ingest-lib.mjs        # pure helpers: URLs, file classification, ZIP extraction, manifest math
scripts/ingest-lib.test.mjs   # unit tests for the above
scripts/ingest.mjs            # orchestrator: download + extract + index (+ offline `plan` mode)
scripts/ingest.test.mjs       # offline end-to-end test (synthetic zips → corpus)
scripts/corpus-query.mjs      # offline ranked search over the corpus
scripts/corpus-query.test.mjs # unit tests for the search scorer
scripts/learn.mjs             # optional: Claude-written per-project LEARNED.md
```
