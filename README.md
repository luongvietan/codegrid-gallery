# CodeGrid Gallery

CodeGrid Gallery indexes downloadable web templates and renders the preview mode supported by each package.

## Getting Started

Install dependencies and start the development server:

```bash
npm ci
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

## Preview modes

- **HTML:** legacy HTML packages keep using the source ZIP and Service Worker preview path.
- **Static:** eligible Vite (vanilla or React) and Create React App packages are built once in an isolated container. Their content-addressed artifacts are uploaded to R2 and loaded directly by the gallery without fetching the source ZIP.
- **Runtime required:** `runtime-required` means the package cannot use a ready HTML/static artifact. Next.js and browser-based WebContainer execution are intentionally deferred to the next phase.

Run all preview-pipeline tests with:

```bash
npm run test:pipeline
```

## Preview backfill

Use the manual GitHub Actions workflow **preview-backfill** to generate preview metadata and static artifacts for existing records. Set `limit` to an integer from 1 through 10; it defaults to 3 so each run stays within the available CI budget. The workflow commits changed `data/index.json` metadata automatically.

The workflow reads the `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY` repository secrets; its R2 endpoint and bucket are fixed in the workflow. Daily sync additionally needs `DISCORD_TOKEN`. For a local backfill, load the R2 variables listed in `.env.example` into the shell environment without committing private values.

## Next phase

The next plan is a Next.js static-export attempt. It will reuse the existing preview manifest, content-addressed artifact uploader, static loader, classifier, proxy, and preview-selection UI instead of duplicating them.
