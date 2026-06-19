# Daily auto-sync of new CodeGrid posts via GitHub Actions

**Date:** 2026-06-19
**Status:** Approved (design)
**Repo:** `luongvietan/codegrid-gallery` (public, default branch `master`, Vercel-linked)

## Goal

Keep the live (Vercel) gallery automatically up to date with new CodeGrid Discord
posts on a daily schedule, with no manual steps — except occasionally refreshing the
Discord token (see Limitations). A run must be **incremental**: it processes only posts
that aren't already published, never re-downloading the full back-catalog.

## Context

The current (manual) pipeline:

1. `dl/download_codegrid.py` (in the non-git `D:\codegrid_downloads` folder) fetches all
   channel messages, downloads `CODE.zip` + thumbnail + video per post into
   `<date>_<title>/` folders, writes `manifest.json`. Incremental only because it sees
   **local** files (`file_is_valid` skips ones already present).
2. `build-index.mjs` scans those folders, reads each zip's central directory, classifies
   (`html` / `react` / `nextjs`), and writes `_viewer/index.json`.
3. That index is copied to the gallery repo's `data/index.json` (imported statically by
   `app/page.tsx`).
4. Project asset folders are uploaded to the **public** R2 bucket; the gallery resolves
   assets as `NEXT_PUBLIC_ASSET_BASE/<folder>/<filename>` (`lib/assets.ts`).
5. Pushing `data/index.json` to `master` triggers Vercel's production deploy.

Key constraints discovered:

- `D:\codegrid_downloads` is **not** a git repo; the downloader scripts are not on GitHub.
- The gallery repo is **public**; the Discord token must live only in GitHub Secrets.
- GitHub cloud runners are **ephemeral** — no local files — so the existing
  local-file-based incrementality does not work there.
- `data/index.json` already stores a `msgId` for every published project. It is therefore
  a ready-made ledger of "what's done", and the Discord API supports `?after=<msgId>` to
  return only newer messages.

## Decisions

- **Run environment:** GitHub **cloud** runner (`ubuntu-latest`), fully hands-off. User
  accepts the Discord user-token risk (ToS / possible account flag) and periodic token
  refresh.
- **Incrementality:** Approach A — **msgId-diff**. Use `data/index.json` as the ledger and
  Discord `?after=` to fetch only new posts. Process only posts not already indexed.
- **Location:** everything in the gallery repo. A push there is already a deploy.
- **Language:** Node-only (Node 18+ has global `fetch`). The `aws` CLI is preinstalled on
  `ubuntu-latest`, so R2 uploads shell out to `aws s3 cp` (no new npm dependency).

## File layout (added to the gallery repo)

```
.github/workflows/daily-sync.yml   # cron + manual trigger, runs the script, commits
scripts/
  lib-zip.mjs        # zip-listing + classify + pickEntryHtml + folder/slug/title helpers
  ci-sync.mjs        # orchestrator
  ci-sync.test.mjs   # unit tests for the pure logic
data/index.json      # updated in place
docs/superpowers/specs/2026-06-19-daily-ci-sync-design.md   # this spec
```

`lib-zip.mjs` holds logic lifted verbatim from `build-index.mjs` so the two stay
consistent: `listZipEntries(buf)`, `classify(names)`, `pickEntryHtml(names)`,
`prettyTitle(folder)`, `slug(folder)`. (The standalone `build-index.mjs` stays usable
locally and may import the same module later; not required for this work.)

## `ci-sync.mjs` algorithm

Inputs from env: `DISCORD_TOKEN`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, plus
non-secret `CHANNEL_ID`, `R2_ENDPOINT`, `R2_BUCKET`.

1. **Load ledger.** Read `data/index.json`. Build `knownMsgIds = Set(projects[].msgId)`
   and `newestMsgId = max(msgId)` (Discord ids are sortable as BigInt snowflakes).
2. **Fetch new messages.** `GET https://discord.com/api/v9/channels/<CHANNEL_ID>/messages?limit=100&after=<newestMsgId>`
   with header `Authorization: <DISCORD_TOKEN>`.
   - 429 → wait `retry_after`, retry.
   - 401/403 → print a clear "token invalid/expired — refresh DISCORD_TOKEN secret" and
     exit non-zero.
   - If exactly 100 returned, log a warning (back-catalog gap larger than one page; not
     expected at daily cadence) and proceed with what was returned.
3. **Select candidates.** Keep messages that (a) have at least one `.zip` attachment and
   (b) whose `id` is not in `knownMsgIds`. (Mirrors `build-index.mjs`, which indexes only
   zip-bearing folders.)
4. **Per candidate (oldest first):**
   a. Derive folder name with the **exact** existing rule:
      `title = sanitize(firstBoldText)[:60]`; `date = timestamp[:10]`;
      `folder = title ? `${date}_${title}` : `${date}_${id}``,
      where `sanitize` replaces `[<>:"/\|?*]` with `_` and trims.
   b. Download each zip/image/video attachment to a temp dir created with
      `fs.mkdtemp()` under the OS temp dir (outside the repo, so `git status` stays clean).
   c. Upload that folder to R2:
      `aws s3 cp tmp/<folder> s3://<R2_BUCKET>/<folder> --recursive --endpoint-url <R2_ENDPOINT>`
      (creds via `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` env, `AWS_DEFAULT_REGION=auto`).
   d. **Verify** with `aws s3 ls s3://<R2_BUCKET>/<folder>/` that all expected objects are
      present. On any failure, exit non-zero **before** modifying the index (so nothing
      partial is committed; the post stays "unknown" and is retried next run).
   e. Read the downloaded zip → `classify()` + `pickEntryHtml()`. Build the index entry:
      ```
      { id: slug(folder), folder, title: prettyTitle(folder), type,
        date, author, msgId: id,
        thumbnail: <first image filename|null>,
        video: <first video filename|null>,
        zip: <zip filename>, entryHtml,
        media: { images:[{url,filename,size}], videos:[...], zips:[...] } }
      ```
      `media` mirrors the Discord attachment metadata (same shape the local pipeline
      produces; the Discord URLs are short-lived and only a fallback — the gallery serves
      assets from R2).
5. **Merge & write.** Append new entries to `projects`, sort by `folder.localeCompare`,
   recompute `counts` (tally by `type`) and `generatedAt = new Date().toISOString()`,
   write `data/index.json` (minified, matching `build-index.mjs`: `JSON.stringify(obj)`).
6. **Signal.** Print a summary and set a `changed=true` output (e.g. via
   `$GITHUB_OUTPUT`) iff at least one entry was added.

## Workflow `daily-sync.yml`

```yaml
name: daily-sync
on:
  schedule:
    - cron: "0 6 * * *"        # 06:00 UTC = 13:00 Vietnam, daily
  workflow_dispatch: {}         # manual "Run workflow" button
permissions:
  contents: write               # commit + push via GITHUB_TOKEN
concurrency:
  group: daily-sync
  cancel-in-progress: false
jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - name: Sync new posts
        id: sync
        env:
          DISCORD_TOKEN:        ${{ secrets.DISCORD_TOKEN }}
          R2_ACCESS_KEY_ID:     ${{ secrets.R2_ACCESS_KEY_ID }}
          R2_SECRET_ACCESS_KEY: ${{ secrets.R2_SECRET_ACCESS_KEY }}
          CHANNEL_ID:  "1048241543477215275"
          R2_ENDPOINT: "https://c43c4f2af4941428dc86d37bffcb7800.r2.cloudflarestorage.com"
          R2_BUCKET:   "codegrid-gallery"
        run: node scripts/ci-sync.mjs
      - name: Commit & push if changed
        if: steps.sync.outputs.changed == 'true'
        run: |
          git config user.name  "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"
          git add data/index.json
          git commit -m "data: auto-sync new CodeGrid post(s)"
          git push
```

A push from `GITHUB_TOKEN` does **not** re-trigger Actions (no loop), so there's no need —
and indeed it would be harmful — to add `[skip ci]`: **Vercel also honors `[skip ci]`** and
would skip the deploy. The plain push fires Vercel's GitHub integration → production deploy.

## Failure handling & idempotency

- R2 upload + verify happens **before** an entry enters the index; the commit happens only
  after every new post's assets are confirmed. A crash mid-run → no commit → clean retry.
- Token failure → non-zero exit → GitHub's default **failed-workflow email** to the repo
  owner. That email is the signal to refresh the `DISCORD_TOKEN` secret.
- `workflow_dispatch` lets you force a run on demand (initial test, or after a token
  refresh).

## Secrets & config

| Name | Where | Value |
|---|---|---|
| `DISCORD_TOKEN` | GH Secret | Discord user token |
| `R2_ACCESS_KEY_ID` | GH Secret | R2 access key |
| `R2_SECRET_ACCESS_KEY` | GH Secret | R2 secret key |
| `CHANNEL_ID` | workflow `env` | `1048241543477215275` |
| `R2_ENDPOINT` | workflow `env` | `https://c43c4f2af4941428dc86d37bffcb7800.r2.cloudflarestorage.com` |
| `R2_BUCKET` | workflow `env` | `codegrid-gallery` |

## Testing

`scripts/ci-sync.test.mjs` (node:test, like `lib/assets.test.ts`) covers the pure logic:

- folder-name derivation from a sample Discord message (bold-title extraction, sanitize,
  60-char cap, no-title fallback to msgId);
- `classify()` on representative file-name lists (next.config → nextjs, package.json →
  react, otherwise html);
- `pickEntryHtml()` selection (prefers shallow `index.html`, excludes `__MACOSX/`);
- index merge: dedupe by `msgId`, sort by folder, recompute counts.

Network/R2 I/O is validated via a real `workflow_dispatch` run, not mocked. Run tests with
`node --test scripts/`.

## Known limitations

- **User-token risk:** automated access from datacenter IPs may get the Discord account
  flagged/banned; the token will need periodic manual refresh in GH Secrets.
- **Discord URL expiry:** the `media[].url` Discord links expire (~24h); they are only a
  fallback, so this is acceptable (R2 is the real source).
- **GitHub cron drift:** scheduled runs can be delayed during peak load; daily timing is
  approximate. Auto-disable after 60 days of repo inactivity does not apply (the repo
  commits whenever there's a new post).

## Out of scope (YAGNI)

- Backfilling/repairing old entries, deleting unpublished posts, or reconciling the
  416-vs-415 R2/index drift noted earlier.
- Migrating the local `D:\codegrid_downloads` flow into the repo (the manual flow still
  works as-is; only the CI path is added here).
- Bot-token migration, self-hosted runners, or Slack/Discord success notifications.
