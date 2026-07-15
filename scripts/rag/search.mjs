#!/usr/bin/env node
// scripts/rag/search.mjs — ad-hoc hybrid retrieval for one brief.
// Local (DB-free, cosine over disk cards) by default; --supabase calls the RPC.
//
//   OPENAI_API_KEY=... node scripts/rag/search.mjs "dark editorial hero, text reveals on scroll" \
//     --scope section --type hero --exclude-hijack --exclude-lib locomotive
//   ... --supabase   (needs SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY, npm i @supabase/supabase-js)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { embedBatch, embedConfig } from './provider.mjs';
import { rankLocal, buildRpcArgs } from './retrieval.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function parseArgs(argv) {
  const o = { corpus: path.join(ROOT, 'corpus'), terms: [], filters: {}, limit: 5, supabase: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--scope') o.filters.scope = argv[++i];
    else if (a === '--type') o.filters.compType = argv[++i];
    else if (a === '--aesthetic') o.filters.aesthetic = argv[++i].split(',');
    else if (a === '--exclude-hijack') o.filters.excludeSideEffects = [...(o.filters.excludeSideEffects || []), 'scroll_hijack'];
    else if (a === '--exclude-lib') o.filters.excludeAnimLibs = [...(o.filters.excludeAnimLibs || []), ...argv[++i].split(',')];
    else if (a === '--limit') o.limit = Math.max(1, +argv[++i] || 5);
    else if (a === '--supabase') o.supabase = true;
    else if (a === '--corpus') o.corpus = path.resolve(argv[++i]);
    else o.terms.push(a);
  }
  return o;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const query = opts.terms.join(' ').trim();
  if (!query) { console.error('Usage: node scripts/rag/search.mjs "<brief>" [--scope] [--type] [--aesthetic a,b] [--exclude-hijack] [--exclude-lib x,y] [--supabase]'); process.exit(2); }
  const [qvec] = await embedBatch([query]);

  let results;
  if (opts.supabase) {
    const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) { console.error('Set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY'); process.exit(1); }
    let createClient;
    try { ({ createClient } = await import('@supabase/supabase-js')); } catch { console.error('Run: npm i @supabase/supabase-js'); process.exit(1); }
    const supabase = createClient(url, key);
    const { data, error } = await supabase.rpc('search_components', { query_embedding: qvec, ...buildRpcArgs(opts.filters, opts.limit) });
    if (error) { console.error(`RPC failed: ${error.message}`); process.exit(1); }
    results = data.map((r) => ({ card: r, sim: r.sim }));
  } else {
    const cardsDir = path.join(opts.corpus, 'cards');
    const cfg = embedConfig();
    const cards = fs.existsSync(cardsDir)
      ? fs.readdirSync(cardsDir).filter((f) => f.endsWith('.json'))
        .map((f) => JSON.parse(fs.readFileSync(path.join(cardsDir, f), 'utf8')))
        .filter((c) => Array.isArray(c.embedding) && c.embedding.length === cfg.dim)
      : [];
    if (!cards.length) { console.error('No embedded cards. Run annotate.mjs + embed.mjs, or use --supabase.'); process.exit(1); }
    results = rankLocal(cards, qvec, opts.filters, opts.limit);
  }

  console.log(`"${query}" — top ${results.length}:\n`);
  for (const r of results) {
    const c = r.card;
    console.log(`  ${c.id}  ${c.comp_type}  sim=${(r.sim ?? 0).toFixed(3)}`);
    if (c.description) console.log(`      ${c.description.slice(0, 140)}`);
  }
}

main().catch((e) => { console.error(`[FATAL] ${e.message}`); process.exit(1); });
