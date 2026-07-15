import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveLlm, openaiPayload } from './llm.mjs';
import { embedConfig } from './provider.mjs';

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

test('embedConfig throws on an unknown provider', () => {
  withEnv({ EMBED_PROVIDER: 'cohere' }, () => {
    assert.throws(() => embedConfig(), /Unknown EMBED_PROVIDER/);
  });
});
