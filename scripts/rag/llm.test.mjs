import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveLlm, openaiPayload, readChoice } from './llm.mjs';
import { embedConfig, backoffMs } from './provider.mjs';

test('resolveLlm defaults to anthropic claude-opus-4-8', () => {
  assert.deepEqual(resolveLlm({}), { provider: 'anthropic', model: 'claude-opus-4-8' });
});

test('resolveLlm builds an openai-compatible config (Ollama = no key)', () => {
  const cfg = resolveLlm({ LLM_PROVIDER: 'openai', LLM_BASE_URL: 'http://localhost:11434/v1/', LLM_MODEL: 'qwen3-coder' });
  assert.equal(cfg.provider, 'openai');
  assert.equal(cfg.baseUrl, 'http://localhost:11434/v1'); // trailing slash trimmed
  assert.equal(cfg.model, 'qwen3-coder');
  assert.equal(cfg.apiKey, '');
});

test('resolveLlm openai falls back to OPENAI_API_KEY and gpt-4o-mini', () => {
  const cfg = resolveLlm({ LLM_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-x' });
  assert.equal(cfg.baseUrl, 'https://api.openai.com/v1');
  assert.equal(cfg.apiKey, 'sk-x');
  assert.equal(cfg.model, 'gpt-4o-mini');
});

test('resolveLlm: deepseek is the openai transport with its own endpoint and key', () => {
  const cfg = resolveLlm({ LLM_PROVIDER: 'deepseek', DEEPSEEK_API_KEY: 'sk-ds' });
  assert.equal(cfg.provider, 'openai');   // what createChat/visionPayload switch on
  assert.equal(cfg.preset, 'deepseek');
  assert.equal(cfg.baseUrl, 'https://api.deepseek.com/v1');
  assert.equal(cfg.apiKey, 'sk-ds');
  assert.equal(cfg.model, 'deepseek-v4-flash');
  // LLM_MODEL still wins — the account decides which model id is current.
  assert.equal(resolveLlm({ LLM_PROVIDER: 'deepseek', LLM_MODEL: 'deepseek-v4-pro' }).model, 'deepseek-v4-pro');
});

test('readChoice returns the text when there is one', () => {
  assert.equal(readChoice({ choices: [{ message: { content: '{"a":1}' }, finish_reason: 'stop' }] }, 3000), '{"a":1}');
});

test('readChoice blames the reasoning budget when a thinking model returns nothing', () => {
  // The real DeepSeek v4 failure: reasoning_content is billed against max_tokens,
  // so content comes back empty and the JSON parser reported a nonsense cause.
  const body = {
    choices: [{ message: { content: '', reasoning_content: 'thinking...' }, finish_reason: 'length' }],
    usage: { completion_tokens_details: { reasoning_tokens: 2998 } },
  };
  assert.throws(() => readChoice(body, 3000), /budget thinking.*2998.*max_tokens=3000.*raise max_tokens/s);
});

test('readChoice reports finish_reason when the emptiness is not about thinking', () => {
  assert.throws(() => readChoice({ choices: [{ message: { content: '' }, finish_reason: 'content_filter' }] }, 8000),
    /finish_reason=content_filter/);
});

test('resolveLlm rejects an unknown provider', () => {
  assert.throws(() => resolveLlm({ LLM_PROVIDER: 'gemini' }), /Unknown LLM_PROVIDER/);
});

test('openaiPayload has the OpenAI chat shape', () => {
  const p = openaiPayload([{ role: 'user', content: 'hi' }], 'm', 500);
  assert.deepEqual(p, { model: 'm', max_tokens: 500, messages: [{ role: 'user', content: 'hi' }], stream: false });
});

function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) { saved[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; }
  try { return fn(); } finally { for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
}

test('embedConfig: default is voyage 1024, ollama is 1024 (bge-m3), openai is 1536', () => {
  withEnv({ EMBED_PROVIDER: undefined, EMBED_MODEL: undefined }, () => {
    const v = embedConfig();
    assert.equal(v.name, 'voyage'); assert.equal(v.dim, 1024);
  });
  withEnv({ EMBED_PROVIDER: 'ollama', EMBED_MODEL: undefined, OLLAMA_BASE_URL: undefined }, () => {
    const o = embedConfig();
    assert.equal(o.name, 'ollama'); assert.equal(o.dim, 1024);
    assert.equal(o.keyVar, null);
    assert.ok(o.url.endsWith('/v1/embeddings'));
  });
  withEnv({ EMBED_PROVIDER: 'openai' }, () => {
    assert.equal(embedConfig().dim, 1536);
  });
});

test('backoffMs waits in minutes, not seconds, because the limit is per minute', () => {
  // Voyage's free tier is 3 requests/minute — a 1s retry just burns an attempt.
  assert.equal(backoffMs(0), 20000);
  assert.equal(backoffMs(1), 40000);
  assert.equal(backoffMs(9), 60000);      // capped
  assert.equal(backoffMs(0, '5'), 5000);  // server knows better
  assert.equal(backoffMs(0, '9999'), 120000);
  assert.equal(backoffMs(0, 'soon'), 20000); // unparseable header ignored
});

test('embedConfig throws on an unknown provider', () => {
  withEnv({ EMBED_PROVIDER: 'cohere' }, () => {
    assert.throws(() => embedConfig(), /Unknown EMBED_PROVIDER/);
  });
});
