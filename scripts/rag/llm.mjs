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
    };
  }
  throw new Error(`Unknown LLM_PROVIDER "${provider}" (anthropic|openai)`);
}

/** OpenAI-compatible chat body. Pure — unit-tested. */
export function openaiPayload(messages, model, maxTokens) {
  return { model, max_tokens: maxTokens, messages, stream: false };
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
  return async (messages, maxTokens) => {
    const resp = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}) },
      body: JSON.stringify(openaiPayload(messages, cfg.model, maxTokens)),
    });
    if (!resp.ok) throw new Error(`LLM HTTP ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
    const j = await resp.json();
    return j.choices?.[0]?.message?.content ?? '';
  };
}
