// scripts/rag/provider.mjs — embedding provider (dependency-free via fetch).
// Claude has NO embeddings endpoint, so the embedding model is a separate provider.
// Default: Voyage voyage-3 (dim 1024, matches the SQL migration).
// Swap with EMBED_PROVIDER=openai (text-embedding-3-small, dim 1536 — also change
// vector(1024) in supabase/migrations/0001_codegrid_rag.sql to vector(1536)).
const CONFIG = {
  openai: { url: 'https://api.openai.com/v1/embeddings', model: process.env.EMBED_MODEL || 'text-embedding-3-small', keyVar: 'OPENAI_API_KEY', dim: 1536 },
  voyage: { url: 'https://api.voyageai.com/v1/embeddings', model: process.env.EMBED_MODEL || 'voyage-3', keyVar: 'VOYAGE_API_KEY', dim: 1024 },
  // Free + local: `ollama pull bge-m3` (dim 1024, matches the migration). No key.
  ollama: { url: `${(process.env.OLLAMA_BASE_URL || 'http://localhost:11434/v1').replace(/\/+$/, '')}/embeddings`, model: process.env.EMBED_MODEL || 'bge-m3', keyVar: null, dim: 1024 },
};

export function embedConfig() {
  const name = process.env.EMBED_PROVIDER || 'voyage';
  const c = CONFIG[name];
  if (!c) throw new Error(`Unknown EMBED_PROVIDER "${name}" (openai|voyage)`);
  return { name, ...c };
}

/**
 * How long to wait after a 429. Honours Retry-After when the server sends one,
 * otherwise backs off 20s/40s/60s — Voyage's free tier is 3 requests per MINUTE,
 * so second-scale backoff just burns the retries. Pure — unit-tested.
 */
export function backoffMs(attempt, retryAfterHeader) {
  const secs = Number(retryAfterHeader);
  if (Number.isFinite(secs) && secs > 0) return Math.min(secs, 120) * 1000;
  return Math.min(20000 * (attempt + 1), 60000);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Embed an array of strings, in batches, retrying rate limits.
 * EMBED_BATCH defaults to 32: the free tier caps tokens-per-minute as well as
 * requests, and a batch of 64 cards lands right on that ceiling.
 */
export async function embedBatch(texts, { onWait } = {}) {
  const c = embedConfig();
  const key = c.keyVar ? process.env[c.keyVar] : null;
  if (c.keyVar && !key) throw new Error(`Set ${c.keyVar} for EMBED_PROVIDER=${c.name}`);
  const size = Math.max(1, +process.env.EMBED_BATCH || 32);
  const out = [];
  for (let i = 0; i < texts.length; i += size) {
    const chunk = texts.slice(i, i + size);
    let lastBody = '';
    let embedded = null;
    for (let attempt = 0; attempt < 5 && !embedded; attempt++) {
      const resp = await fetch(c.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
        body: JSON.stringify({ model: c.model, input: chunk }),
      });
      if (resp.ok) { embedded = (await resp.json()).data.map((d) => d.embedding); break; }
      lastBody = await resp.text();
      if (resp.status !== 429) throw new Error(`${c.name} embeddings HTTP ${resp.status}: ${lastBody}`);
      const wait = backoffMs(attempt, resp.headers.get('retry-after'));
      onWait?.(wait, attempt);
      await sleep(wait);
    }
    if (!embedded) throw new Error(`${c.name} embeddings: still rate-limited after 5 attempts. ${lastBody.slice(0, 200)}`);
    out.push(...embedded);
  }
  return out;
}
