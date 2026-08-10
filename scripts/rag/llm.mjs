// scripts/rag/llm.mjs — provider-agnostic chat for the annotate step.
// Default: Anthropic (claude-opus-4-8, paid). For a FREE run, point it at any
// OpenAI-compatible endpoint — Ollama (local, unlimited, no key), OpenRouter
// (free models), Alibaba DashScope-compat, LM Studio, etc.
//
//   # Free + local (recommended for batch-annotating 400 sources):
//   LLM_PROVIDER=openai LLM_BASE_URL=http://localhost:11434/v1 LLM_MODEL=qwen3-coder \
//     node scripts/rag/annotate.mjs
//
//   # Free via OpenRouter:
//   LLM_PROVIDER=openai LLM_BASE_URL=https://openrouter.ai/api/v1 \
//     LLM_API_KEY=sk-or-... LLM_MODEL=qwen/qwen3-coder:free node scripts/rag/annotate.mjs

/** Pull the one JSON object out of a model reply (fence, prose, or both). Pure. */
export function extractJson(text) {
  const t = String(text ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  const s = t.indexOf('{'), e = t.lastIndexOf('}');
  if (s === -1 || e === -1 || e < s) throw new Error('no JSON object in response');
  return JSON.parse(t.slice(s, e + 1));
}

/** Resolve LLM config from env. Pure (env in, config out) — unit-tested. */
export function resolveLlm(env = process.env) {
  const provider = env.LLM_PROVIDER || 'anthropic';
  if (provider === 'anthropic') {
    return { provider, model: env.LLM_MODEL || 'claude-opus-4-8' };
  }
  if (provider === 'openai') {
    return {
      provider,
      baseUrl: (env.LLM_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, ''),
      apiKey: env.LLM_API_KEY || env.OPENAI_API_KEY || '',
      model: env.LLM_MODEL || 'gpt-4o-mini',
      reasoningEffort: env.LLM_REASONING_EFFORT || '',
    };
  }
  // DeepSeek is OpenAI-compatible, so it is the openai transport with its own
  // endpoint + key var. `preset` records where the defaults came from; `provider`
  // stays "openai" because that is what createChat and visionPayload switch on.
  if (provider === 'deepseek') {
    return {
      provider: 'openai',
      preset: 'deepseek',
      baseUrl: (env.LLM_BASE_URL || 'https://api.deepseek.com/v1').replace(/\/+$/, ''),
      apiKey: env.DEEPSEEK_API_KEY || env.LLM_API_KEY || '',
      // Verified against GET /models: the account exposes deepseek-v4-flash and
      // deepseek-v4-pro. Flash is the batch default — 422 annotations is a lot of
      // calls, and validateCard's retry loop exists precisely so a cheaper model
      // still yields clean cards. Step 3's eval is what should decide if pro is
      // worth it: LLM_MODEL=deepseek-v4-pro.
      model: env.LLM_MODEL || 'deepseek-v4-flash',
      reasoningEffort: env.LLM_REASONING_EFFORT || '',
    };
  }
  throw new Error(`Unknown LLM_PROVIDER "${provider}" (anthropic|openai|deepseek)`);
}

/** OpenAI-compatible chat body. Pure — unit-tested.
 *  `reasoningEffort` is the cost lever on thinking models: DeepSeek v4 spends
 *  thousands of tokens reasoning per annotation, which over 422 sources is real
 *  money and real latency. Omitted unless asked for, so plain models are unaffected. */
export function openaiPayload(messages, model, maxTokens, reasoningEffort = '', tokenField = 'max_tokens') {
  const body = { model, [tokenField]: maxTokens, messages, stream: false };
  if (reasoningEffort) body.reasoning_effort = reasoningEffort;
  return body;
}

/**
 * Newer OpenAI models reject `max_tokens` outright and name their replacement in
 * the error. Rather than keep a list of which model wants which field — a list
 * that is wrong the day a model ships — read the instruction out of the refusal.
 */
export function tokenFieldFromError(message) {
  const m = /use '?(max_completion_tokens|max_tokens)'? instead/i.exec(String(message ?? ''));
  return m ? m[1] : null;
}

/**
 * Read the text out of an OpenAI-compatible response, and FAIL LOUDLY when there
 * is none. On a reasoning model (DeepSeek v4, o-series) `reasoning_content` is
 * billed against the same max_tokens budget, so a budget that looks generous can
 * be entirely consumed thinking — leaving content empty. That surfaced as the
 * useless "no JSON object in response" three retries later; this names it.
 */
export function readChoice(json, maxTokens) {
  const choice = json?.choices?.[0];
  const text = choice?.message?.content ?? '';
  if (text.trim()) return text;
  const reasoning = json?.usage?.completion_tokens_details?.reasoning_tokens;
  const why = choice?.finish_reason === 'length' || (reasoning && maxTokens && reasoning >= maxTokens * 0.8)
    ? `the model spent its whole budget thinking (${reasoning} reasoning tokens of max_tokens=${maxTokens}) — raise max_tokens`
    : `finish_reason=${choice?.finish_reason ?? 'unknown'}`;
  throw new Error(`empty response from the model: ${why}`);
}

/** Build a `chat(messages, maxTokens) -> text` function for the resolved provider. */
export async function createChat(cfg) {
  if (cfg.provider === 'anthropic') {
    let Anthropic;
    try { ({ default: Anthropic } = await import('@anthropic-ai/sdk')); }
    catch { throw new Error('Run: npm i @anthropic-ai/sdk  (or set LLM_PROVIDER=openai for a free/local endpoint)'); }
    const client = new Anthropic();
    return async (messages, maxTokens) => {
      const r = await client.messages.create({ model: cfg.model, max_tokens: maxTokens, messages });
      return r.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    };
  }
  // openai-compatible (Ollama / OpenRouter / DashScope / LM Studio / OpenAI)
  // Learned once per chat, not per call: the first refusal tells us which token
  // field this model wants, and every later call uses it.
  let tokenField = cfg.tokenField || 'max_tokens';
  const post = (messages, maxTokens) => fetch(`${cfg.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}) },
    body: JSON.stringify(openaiPayload(messages, cfg.model, maxTokens, cfg.reasoningEffort, tokenField)),
  });
  return async (messages, maxTokens) => {
    let resp = await post(messages, maxTokens);
    if (!resp.ok) {
      const body = await resp.text();
      const wanted = tokenFieldFromError(body);
      if (!wanted || wanted === tokenField) throw new Error(`LLM HTTP ${resp.status}: ${body.slice(0, 300)}`);
      tokenField = wanted;
      resp = await post(messages, maxTokens);
      if (!resp.ok) throw new Error(`LLM HTTP ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
    }
    return readChoice(await resp.json(), maxTokens);
  };
}
