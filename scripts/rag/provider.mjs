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

/** Embed an array of strings. Batches of 64; throws with a clear message if the key is missing. */
export async function embedBatch(texts) {
  const c = embedConfig();
  const key = c.keyVar ? process.env[c.keyVar] : null;
  if (c.keyVar && !key) throw new Error(`Set ${c.keyVar} for EMBED_PROVIDER=${c.name}`);
  const out = [];
  for (let i = 0; i < texts.length; i += 64) {
    const chunk = texts.slice(i, i + 64);
    const resp = await fetch(c.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify({ model: c.model, input: chunk }),
    });
    if (!resp.ok) throw new Error(`${c.name} embeddings HTTP ${resp.status}: ${await resp.text()}`);
    const json = await resp.json();
    for (const d of json.data) out.push(d.embedding);
  }
  return out;
}
