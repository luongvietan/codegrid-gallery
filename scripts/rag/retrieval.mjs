// scripts/rag/retrieval.mjs
// Pure retrieval logic: diversity sampling for the eval set, cosine ranking for
// the DB-free local eval, filter application (hard WHERE re-expressed in JS),
// and the arg mapping for the Supabase RPC. No I/O — unit-tested.

/** Greedy max-diversity pick: bucket by (comp_type|framework|lib|aesthetic) and
 *  round-robin one per bucket until n. Deterministic (input order breaks ties). */
export function selectDiverse(cards, n) {
  const sig = (c) =>
    `${c.comp_type}|${c.framework}|${(c.animation_libs || [])[0] || 'none'}|${(c.aesthetic || [])[0] || '-'}`;
  const buckets = new Map();
  for (const c of cards) {
    const k = sig(c);
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(c);
  }
  const queues = [...buckets.values()];
  const picked = [];
  let progress = true;
  while (picked.length < n && progress) {
    progress = false;
    for (const q of queues) {
      if (!q.length) continue;
      picked.push(q.shift());
      progress = true;
      if (picked.length >= n) break;
    }
  }
  return picked;
}

export function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return -1;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (na === 0 || nb === 0) return -1;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Apply the hard filters (the SQL WHERE clause, re-expressed for the local eval).
 *  A card passes only if every constraint holds — this is where stack/side-effect
 *  conflicts are rejected at the retriever tier, not patched later by the composer. */
export function applyFilters(card, f = {}) {
  if (f.scope && card.scope !== f.scope) return false;
  if (f.compType && card.comp_type !== f.compType) return false;
  const overlaps = (arr, list) => Array.isArray(arr) && arr.some((x) => list.includes(x));
  if (f.aesthetic && f.aesthetic.length && !overlaps(card.aesthetic, f.aesthetic)) return false;
  if (f.excludeSideEffects && f.excludeSideEffects.length && overlaps(card.side_effects, f.excludeSideEffects)) return false;
  if (f.excludeAnimLibs && f.excludeAnimLibs.length && overlaps(card.animation_libs, f.excludeAnimLibs)) return false;
  return true;
}

/** DB-free ranking: filter, then order by cosine(query, card.embedding), top `limit`. */
export function rankLocal(cards, queryEmbedding, f = {}, limit = 5) {
  return cards
    .filter((c) => applyFilters(c, f))
    .map((c) => ({ card: c, sim: cosine(queryEmbedding, c.embedding) }))
    .sort((a, b) => b.sim - a.sim)
    .slice(0, limit);
}

/** Map a brief's filter object to the Supabase RPC argument names (null = skip). */
export function buildRpcArgs(f = {}, limit = 5) {
  return {
    f_scope: f.scope ?? null,
    f_comp_type: f.compType ?? null,
    f_aesthetic: f.aesthetic && f.aesthetic.length ? f.aesthetic : null,
    f_exclude_side_effects: f.excludeSideEffects && f.excludeSideEffects.length ? f.excludeSideEffects : null,
    f_exclude_anim_libs: f.excludeAnimLibs && f.excludeAnimLibs.length ? f.excludeAnimLibs : null,
    match_limit: f.limit ?? limit,
  };
}

/** Did the expected id land in the top-k? Used by the eval harness. */
export function topKHit(ranked, expectId, k = 3) {
  return ranked.slice(0, k).some((r) => (r.card ? r.card.id : r.id) === expectId);
}
