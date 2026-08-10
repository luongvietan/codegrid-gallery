#!/usr/bin/env node
// scripts/rag/critique.mjs — render an assembled page, look at it, write the fix plan.
//
// Every pass before this one reasons about code through text. This one renders the
// result and shows it to a vision model, then routes each finding back to the
// component that produced it (via the composition's plan.json).
//
//   node scripts/rag/critique.mjs ./out/index.html --composition corpus/compositions/studio-site
//   node scripts/rag/critique.mjs https://localhost:3000 --brief "dark editorial studio site"
//   node scripts/rag/critique.mjs --shots desktop.png,mobile.png --brief "..."   # no browser needed
//
// Screenshots need Playwright, which is an OPTIONAL dependency (`npm i playwright`
// + `npx playwright install chromium`) — the repo stays dependency-free, and
// `--shots` lets you critique images you already have, on any machine.
//
// The vision model is provider-agnostic like the rest: VISION_MODEL overrides the
// chat model, because a strong code model (qwen3-coder) usually cannot see.
//   LLM_PROVIDER=openai LLM_BASE_URL=http://localhost:11434/v1 VISION_MODEL=qwen2.5vl \
//     node scripts/rag/critique.mjs ./out/index.html --brief "..."
//
// Exits 1 when the critique contains a blocker, so a build loop can gate on it.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveLlm, createChat, extractJson } from './llm.mjs';
import {
  VIEWPORTS, validateCritique, visionPayload, buildCritiquePrompt,
  mergeFindings, sortFindings, buildFixPlan,
} from './vision.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function parseArgs(argv) {
  const o = { target: null, shots: [], composition: null, brief: '', out: null, prescroll: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--shots') o.shots = argv[++i].split(',').map((s) => path.resolve(s.trim()));
    else if (a === '--composition') o.composition = path.resolve(argv[++i]);
    else if (a === '--brief') o.brief = argv[++i];
    else if (a === '--out') o.out = path.resolve(argv[++i]);
    else if (a === '--no-prescroll') o.prescroll = false;
    else if (a.startsWith('--')) { console.error(`Unknown argument: ${a}`); process.exit(2); }
    else o.target = a;
  }
  return o;
}

const toUrl = (target) => (/^https?:\/\//i.test(target) ? target : pathToFileURL(path.resolve(target)).href);

async function capture(url, outDir, prescroll) {
  let chromium;
  try { ({ chromium } = await import('playwright')); }
  catch {
    throw new Error('Screenshots need Playwright: npm i playwright && npx playwright install chromium\n(or pass --shots a.png,b.png to critique images you already have)');
  }
  const shotsDir = path.join(outDir, 'shots');
  fs.mkdirSync(shotsDir, { recursive: true });
  const browser = await chromium.launch();
  const out = [];
  try {
    for (const [label, viewport] of Object.entries(VIEWPORTS)) {
      const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, ...viewport });
      const page = await context.newPage();
      await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
      await page.evaluate(() => document.fonts?.ready);
      // Most of this corpus is scroll-driven: a page that is never scrolled shows
      // its entry state forever, and the critique would review an empty page.
      if (prescroll) {
        await page.evaluate(async () => {
          const step = window.innerHeight * 0.8;
          for (let y = 0; y < document.body.scrollHeight; y += step) {
            window.scrollTo(0, y);
            await new Promise((r) => setTimeout(r, 250));
          }
          window.scrollTo(0, 0);
          await new Promise((r) => setTimeout(r, 600));
        });
      }
      const file = path.join(shotsDir, `${label}.png`);
      await page.screenshot({ path: file, fullPage: true });
      out.push({ label, file });
      await context.close();
    }
  } finally { await browser.close(); }
  return out;
}

async function askForCritique(chat, prompt, images, slotKeys) {
  const messages = visionPayload(resolveLlm().provider, prompt, images);
  let lastErr = 'unknown';
  for (let i = 0; i < 3; i++) {
    const text = await chat(messages, 16000); // reasoning models bill thinking against this
    let critique;
    try { critique = extractJson(text); } catch (e) {
      lastErr = e.message;
      messages.push({ role: 'assistant', content: text }, { role: 'user', content: `That was not valid JSON (${e.message}). Return ONLY the JSON object.` });
      continue;
    }
    const { ok, errors } = validateCritique(critique, slotKeys);
    if (ok) return critique;
    lastErr = errors.join('; ');
    messages.push({ role: 'assistant', content: text }, { role: 'user', content: `The critique failed validation. Fix ONLY these and return the full corrected JSON:\n- ${errors.join('\n- ')}` });
  }
  throw new Error(`critique validation failed after retries: ${lastErr}`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.target && !opts.shots.length) {
    console.error('Usage: node scripts/rag/critique.mjs <url|file.html> [--composition dir] [--brief "..."] [--shots a.png,b.png] [--out dir]');
    process.exit(2);
  }

  let composition = { picks: [] }, slotKeys = [], brief = opts.brief;
  if (opts.composition) {
    const planFile = path.join(opts.composition, 'plan.json');
    if (!fs.existsSync(planFile)) { console.error(`No plan.json in ${opts.composition} — run compose.mjs first.`); process.exit(1); }
    composition = JSON.parse(fs.readFileSync(planFile, 'utf8'));
    slotKeys = (composition.plan?.slots || []).map((s) => s.key);
    brief = brief || composition.brief || composition.plan?.title || '';
  }
  if (!brief) { console.error('Nothing to review against. Pass --brief "..." or --composition <dir>.'); process.exit(2); }

  const outDir = opts.out || opts.composition || path.join(ROOT, 'corpus', 'critiques', String(Date.now()));
  fs.mkdirSync(outDir, { recursive: true });

  let shots;
  if (opts.shots.length) {
    shots = opts.shots.map((file) => ({ label: path.basename(file, path.extname(file)), file }));
  } else {
    console.log(`Rendering ${opts.target} at ${Object.keys(VIEWPORTS).join(' + ')}...`);
    shots = await capture(toUrl(opts.target), outDir, opts.prescroll);
  }
  const images = shots.map(({ label, file }) => {
    if (!fs.existsSync(file)) { console.error(`No such screenshot: ${file}`); process.exit(1); }
    const ext = path.extname(file).toLowerCase();
    return { label, media_type: ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'image/png', base64: fs.readFileSync(file).toString('base64') };
  });

  const llm = resolveLlm();
  const visionModel = process.env.VISION_MODEL || llm.model;
  if (llm.provider === 'anthropic' && !process.env.ANTHROPIC_API_KEY) { console.error('Set ANTHROPIC_API_KEY, or point LLM_PROVIDER=openai at a local VLM (VISION_MODEL=qwen2.5vl).'); process.exit(1); }
  let chat;
  try { chat = await createChat({ ...llm, model: visionModel }); } catch (e) { console.error(e.message); process.exit(1); }
  console.log(`Reviewing ${images.length} screenshot(s) with ${llm.provider}:${visionModel}...`);

  const raw = await askForCritique(chat, buildCritiquePrompt(brief, slotKeys), images, slotKeys);
  const critique = { ...raw, findings: sortFindings(mergeFindings(raw.findings)) };

  fs.writeFileSync(path.join(outDir, 'CRITIQUE.md'), buildFixPlan(critique, composition, brief));
  fs.writeFileSync(path.join(outDir, 'critique.json'), JSON.stringify({ brief, shots: shots.map((s) => s.file), ...critique }, null, 2));

  const blockers = critique.findings.filter((f) => f.severity === 'blocker').length;
  console.log(`\n${critique.verdict} · ${critique.score}/5 · ${critique.findings.length} finding(s), ${blockers} blocker(s)`);
  for (const f of critique.findings) console.log(`  [${f.severity}] ${f.slot ?? 'page'} — ${f.what}`);
  console.log(`\nWrote ${path.relative(ROOT, path.join(outDir, 'CRITIQUE.md'))}`);
  if (blockers) process.exit(1); // so a build loop can gate on "no blockers"
}

main().catch((e) => { console.error(`[FATAL] ${e.message}`); process.exit(1); });
