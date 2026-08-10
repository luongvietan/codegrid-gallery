// scripts/rag/judge.mjs
// Relevance judging for the eval — the metric that survives a growing corpus.
//
// hit@3 against a single expected id was fine at 20 cards and became misleading
// at 422: "a photo grid that animates in on scroll" has a dozen equally right
// answers among 120 galleries, so scoring against one arbitrary pick made the
// number FALL as the corpus (and the results) got better. Precision@k asks the
// only question the composer actually cares about — of what came back, how much
// could I use? — and needs no gold set to maintain.
//
// Pure (the LLM arrives as an injected `chat`), so it is unit-tested offline.
import { extractJson } from './llm.mjs';

const MAX_DESC = 700;

export function buildJudgePrompt(query, cards) {
  const list = cards.map((c) => `--- id: ${c.id}\ntype: ${c.comp_type}\n${String(c.description || '').slice(0, MAX_DESC)}`).join('\n');
  return `A designer searched a component library with this brief. For EACH candidate below, decide whether it is RELEVANT — would this designer be able to use it for what they asked for?

BRIEF: ${query}

Return ONLY one JSON object: {"verdicts":[{"id","relevant","why"}, ...]} with exactly one entry per candidate id, in the order given.

RULES:
1. "relevant" is a boolean. Judge the FIT TO THE BRIEF, not the quality of the component.
2. Be strict about the thing asked for and lenient about everything else. A brief asking for a fullscreen menu is satisfied by any fullscreen menu — the specific colours, copy and brand of the demo do not matter, because those get replaced on reuse.
3. Wrong kind of component = not relevant, however good it is (a pricing table cannot answer a request for a hero).
4. "why": one short clause IN ENGLISH. Name the deciding feature. (Observed drift: a model asked for a terse reason may answer in its own first language, which makes the eval log unreadable to everyone else on the team.)

CANDIDATES:
${list}`;
}

export function validateVerdicts(obj, ids) {
  const errors = [];
  const verdicts = obj?.verdicts;
  if (!Array.isArray(verdicts)) return { ok: false, errors: ['verdicts: must be an array'] };

  const seen = new Set();
  verdicts.forEach((v, i) => {
    const at = `verdicts[${i}]`;
    if (v == null || typeof v !== 'object') { errors.push(`${at}: not an object`); return; }
    if (!ids.includes(v.id)) errors.push(`${at}.id: "${v.id}" was not one of the candidates`);
    else if (seen.has(v.id)) errors.push(`${at}.id: "${v.id}" judged twice`);
    else seen.add(v.id);
    if (typeof v.relevant !== 'boolean') errors.push(`${at}.relevant: must be a boolean (true/false), got ${JSON.stringify(v.relevant)}`);
    if (typeof v.why !== 'string' || !v.why.trim()) errors.push(`${at}.why: must be a non-empty string`);
  });
  const missing = ids.filter((id) => !seen.has(id));
  if (missing.length) errors.push(`missing a verdict for: ${missing.join(', ')}`);
  return { ok: errors.length === 0, errors };
}

/** Judge one brief's results, with the same validate-and-retry loop as every
 *  other LLM step here — a judge that skips half the candidates is not a metric. */
export async function judgeBrief(chat, query, cards, attempts = 3) {
  const ids = cards.map((c) => c.id);
  const messages = [{ role: 'user', content: buildJudgePrompt(query, cards) }];
  let lastErr = 'unknown';
  for (let i = 0; i < attempts; i++) {
    const text = await chat(messages, 4000);
    let obj;
    try { obj = extractJson(text); } catch (e) {
      lastErr = e.message;
      messages.push({ role: 'assistant', content: text }, { role: 'user', content: `That was not valid JSON (${e.message}). Return ONLY the JSON object.` });
      continue;
    }
    const { ok, errors } = validateVerdicts(obj, ids);
    if (ok) return ids.map((id) => obj.verdicts.find((v) => v.id === id));
    lastErr = errors.join('; ');
    messages.push({ role: 'assistant', content: text }, { role: 'user', content: `Fix ONLY these and return the full corrected JSON:\n- ${errors.join('\n- ')}` });
  }
  throw new Error(`judge validation failed after retries: ${lastErr}`);
}

export function precisionAt(verdicts) {
  if (!verdicts.length) return 0;
  return verdicts.filter((v) => v.relevant).length / verdicts.length;
}

/**
 * Two numbers, because they answer different questions:
 *   meanPrecision — how much of a result page is usable (ranking quality).
 *   anyRelevant   — how often the composer gets ANYTHING it can fill a slot with.
 * A slot only needs one good component, so `shutouts` is the failure that hurts.
 */
export function summarize(results) {
  const precisions = results.map((r) => precisionAt(r.verdicts));
  const anyRelevant = results.filter((r) => r.verdicts.some((v) => v.relevant)).length;
  return {
    briefs: results.length,
    meanPrecision: precisions.reduce((a, b) => a + b, 0) / (results.length || 1),
    anyRelevant,
    shutouts: results.length - anyRelevant,
  };
}
