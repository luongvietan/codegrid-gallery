#!/usr/bin/env node
// scripts/rag/embed.mjs — embed each card's (description + retrieval_probes) and
// write the vector back into the card JSON on disk (ready for the DB-free eval).
// With --supabase, also upsert cards+vectors into the components table.
//
//   OPENAI_API_KEY=... node scripts/rag/embed.mjs
//   OPENAI_API_KEY=... SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
//     node scripts/rag/embed.mjs --supabase       # needs: npm i @supabase/supabase-js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { embeddingText } from './schema.mjs';
import { embedBatch, embedConfig } from './provider.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function parseArgs(argv) {
  const o = { corpus: path.join(ROOT, 'corpus'), supabase: false, force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--supabase') o.supabase = true;
    else if (a === '--force') o.force = true;
    else if (a === '--corpus') o.corpus = path.resolve(argv[++i]);
    else { console.error(`Unknown argument: ${a}`); process.exit(2); }
  }
  return o;
}

const COLUMNS = ['id', 'source_path', 'origin_site', 'loc', 'schema_version', 'annotator_model',
  'scope', 'comp_type', 'framework', 'animation_libs', 'css_approach', 'needs_webgl',
  'asset_types', 'side_effects', 'aesthetic', 'motion_character', 'density', 'color_mood',
  'description', 'retrieval_probes', 'dom_root', 'entry_point', 'design_tokens',
  'content_slots', 'responsive', 'coupling', 'code'];

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const cardsDir = path.join(opts.corpus, 'cards');
  if (!fs.existsSync(cardsDir)) { console.error(`No cards. Run: node scripts/rag/annotate.mjs`); process.exit(1); }
  const cfg = embedConfig();
  const files = fs.readdirSync(cardsDir).filter((f) => f.endsWith('.json'));

  const toEmbed = [];
  for (const f of files) {
    const card = JSON.parse(fs.readFileSync(path.join(cardsDir, f), 'utf8'));
    if (!opts.force && Array.isArray(card.embedding) && card.embedding.length === cfg.dim) continue;
    toEmbed.push({ file: f, card });
  }
  console.log(`Embedding ${toEmbed.length}/${files.length} card(s) with ${cfg.name}:${cfg.model} (dim ${cfg.dim})`);

  for (let i = 0; i < toEmbed.length; i += 64) {
    const batch = toEmbed.slice(i, i + 64);
    const vecs = await embedBatch(batch.map((b) => embeddingText(b.card)));
    batch.forEach((b, j) => {
      b.card.embedding = vecs[j];
      fs.writeFileSync(path.join(cardsDir, b.file), JSON.stringify(b.card, null, 2));
    });
    console.log(`  ${Math.min(i + 64, toEmbed.length)}/${toEmbed.length}`);
  }

  if (opts.supabase) {
    const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) { console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY for --supabase'); process.exit(1); }
    let createClient;
    try { ({ createClient } = await import('@supabase/supabase-js')); }
    catch { console.error('Run: npm i @supabase/supabase-js'); process.exit(1); }
    const supabase = createClient(url, key);
    const rows = files.map((f) => {
      const card = JSON.parse(fs.readFileSync(path.join(cardsDir, f), 'utf8'));
      const row = {};
      for (const c of COLUMNS) row[c] = card[c] ?? null;
      row.embedding = card.embedding ?? null; // pgvector parses the JSON array
      return row;
    });
    for (let i = 0; i < rows.length; i += 100) {
      const { error } = await supabase.from('components').upsert(rows.slice(i, i + 100), { onConflict: 'id' });
      if (error) { console.error(`Supabase upsert failed: ${error.message}`); process.exit(1); }
      console.log(`  upserted ${Math.min(i + 100, rows.length)}/${rows.length}`);
    }
  }
  console.log('Done. Next: node scripts/rag/eval.mjs   (or search.mjs)');
}

main().catch((e) => { console.error(`[FATAL] ${e.message}`); process.exit(1); });
