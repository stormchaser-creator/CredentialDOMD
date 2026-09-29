// Mock AI providers (Anthropic Messages, Gemini generateContent) and the
// lab's operator-alert capture (Telegram).
//
// Default: MOCKED. Every call gets a canned answer in the provider's own shape,
// or the next scripted answer (POST /qa/ai/next). Nothing leaves the machine.
//
// QA_AI=real forwards calls to the real provider with a key from the
// environment (QA_ANTHROPIC_API_KEY / QA_GEMINI_API_KEY; never from the local
// app_secrets, which only ever hold placeholders), under a hard daily cap:
// QA_AI_DAILY_CAP requests per UTC day (default 20, at most 200) and
// max_tokens / maxOutputTokens clamped to QA_AI_MAX_OUTPUT_TOKENS (default 1024).
// Past the cap the mock answers 429 in the provider's format.
import { randomAlnum } from '../lib/lab-secrets.mjs';
import { HttpError, json, readBody, readJson } from './http.mjs';

const REAL = { anthropic: 'https://api.anthropic.com', gemini: 'https://generativelanguage.googleapis.com' };
const CANNED = 'QA lab mock AI response. The lab does not call a real model unless QA_AI=real is set.';
const estimateTokens = (text) => Math.max(1, Math.ceil(String(text || '').length / 4));

export function aiSettings(env = process.env) {
  const cap = Math.min(Math.max(Number.parseInt(env.QA_AI_DAILY_CAP || '20', 10) || 0, 0), 200);
  const maxOut = Math.min(Math.max(Number.parseInt(env.QA_AI_MAX_OUTPUT_TOKENS || '1024', 10) || 1024, 16), 4096);
  return { real: env.QA_AI === 'real', cap, maxOut, keys: { anthropic: env.QA_ANTHROPIC_API_KEY || '', gemini: env.QA_GEMINI_API_KEY || '' } };
}

export function createAiMock({ store, secrets, settings = aiSettings(), log = console.log }) {
  const S = () => store.state.ai;
  const day = () => new Date().toISOString().slice(0, 10);
  const record = (entry) => store.update((s) => { s.ai.calls.unshift({ at: new Date().toISOString(), ...entry }); s.ai.calls.length = Math.min(s.ai.calls.length, 300); });
  const nextScripted = (provider) => {
    const i = S().script.findIndex((x) => x.provider === provider);
    if (i < 0) return null;
    const [item] = S().script.splice(i, 1);
    store.save();
    return item.response;
  };

  function spend(provider) {
    const today = day();
    const used = S().usage[today] || 0;
    if (used >= settings.cap) {
      throw new HttpError(429, 'QA lab daily AI cap reached', provider === 'anthropic'
        ? { type: 'error', error: { type: 'rate_limit_error', message: `QA lab daily cap of ${settings.cap} real AI calls reached` } }
        : { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: `QA lab daily cap of ${settings.cap} real AI calls reached` } });
    }
    store.update((s) => { s.ai.usage = { [today]: used + 1 }; });
  }

  async function forward(provider, pathAndQuery, bodyText, headers) {
    if (!settings.keys[provider]) throw new HttpError(503, `QA_AI=real needs QA_${provider.toUpperCase()}_API_KEY`);
    spend(provider);
    const r = await fetch(`${REAL[provider]}${pathAndQuery}`, { method: 'POST', headers, body: bodyText, signal: AbortSignal.timeout(120000) });
    return { status: r.status, text: await r.text() };
  }

  // Anthropic Messages API.
  async function anthropic(req, res, { url }, count = false) {
    if (!req.headers['x-api-key'] && !req.headers.authorization) throw new HttpError(401, 'missing key', { type: 'error', error: { type: 'authentication_error', message: 'x-api-key header is required' } });
    const raw = await readBody(req);
    let body;
    try { body = JSON.parse(raw); } catch { throw new HttpError(400, 'bad JSON', { type: 'error', error: { type: 'invalid_request_error', message: 'invalid JSON' } }); }
    const inputTokens = estimateTokens(JSON.stringify([body.system, body.messages, body.tools]));
    if (settings.real) {
      if (!count && Number.isInteger(body.max_tokens)) body.max_tokens = Math.min(body.max_tokens, settings.maxOut);
      const headers = { 'content-type': 'application/json', 'x-api-key': settings.keys.anthropic, 'anthropic-version': req.headers['anthropic-version'] || '2023-06-01' };
      if (req.headers['anthropic-beta']) headers['anthropic-beta'] = req.headers['anthropic-beta'];
      const up = await forward('anthropic', url.pathname.replace(/^\/anthropic/, ''), JSON.stringify(body), headers);
      record({ provider: 'anthropic', mode: 'real', model: body.model, status: up.status, count });
      return json(res, up.status, JSON.parse(up.text || '{}'));
    }
    if (count) { record({ provider: 'anthropic', mode: 'mock', model: body.model, count: true }); return json(res, 200, { input_tokens: inputTokens }); }
    const scripted = nextScripted('anthropic');
    const content = scripted?.content || [{ type: 'text', text: scripted?.text || CANNED }];
    const out = { id: `msg_qalab${randomAlnum(20)}`, type: 'message', role: 'assistant', model: body.model || 'mock', content, stop_reason: scripted?.stop_reason || (content.some((c) => c.type === 'tool_use') ? 'tool_use' : 'end_turn'), stop_sequence: null,
      usage: { input_tokens: inputTokens, output_tokens: estimateTokens(JSON.stringify(content)), cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } };
    record({ provider: 'anthropic', mode: 'mock', model: body.model, scripted: !!scripted });
    json(res, 200, out, { 'request-id': `req_qalab${randomAlnum(16)}` });
  }

  // Gemini generateContent / countTokens (path: /gemini/v1beta/models/<model>:<method>?key=...).
  async function gemini(req, res, { url }) {
    const m = /^\/gemini\/(v1beta|v1)\/models\/([^/:]+):(generateContent|countTokens)$/.exec(url.pathname);
    if (!m) throw new HttpError(404, 'unknown Gemini method', { error: { code: 404, status: 'NOT_FOUND', message: 'Method not found' } });
    if (!url.searchParams.get('key') && !req.headers['x-goog-api-key']) throw new HttpError(403, 'missing key', { error: { code: 403, status: 'PERMISSION_DENIED', message: 'Method doesn\'t allow unregistered callers' } });
    const raw = await readBody(req);
    let body;
    try { body = raw ? JSON.parse(raw) : {}; } catch { throw new HttpError(400, 'bad JSON', { error: { code: 400, status: 'INVALID_ARGUMENT', message: 'Invalid JSON payload' } }); }
    const [, version, model, method] = m;
    const promptTokens = estimateTokens(JSON.stringify(body.contents || body.generateContentRequest?.contents || ''));
    if (settings.real) {
      if (method === 'generateContent' && body.generationConfig) body.generationConfig.maxOutputTokens = Math.min(body.generationConfig.maxOutputTokens || settings.maxOut, settings.maxOut);
      const up = await forward('gemini', `/${version}/models/${model}:${method}?key=${encodeURIComponent(settings.keys.gemini)}`, JSON.stringify(body), { 'content-type': 'application/json' });
      record({ provider: 'gemini', mode: 'real', model, method, status: up.status });
      return json(res, up.status, JSON.parse(up.text || '{}'));
    }
    record({ provider: 'gemini', mode: 'mock', model, method });
    if (method === 'countTokens') return json(res, 200, { totalTokens: promptTokens });
    const scripted = nextScripted('gemini');
    const wantsJson = body.generationConfig?.responseMimeType === 'application/json';
    const text = scripted?.text ?? (scripted?.json !== undefined ? JSON.stringify(scripted.json) : wantsJson ? '{}' : CANNED);
    const out = { candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP', index: 0 }],
      usageMetadata: { promptTokenCount: promptTokens, candidatesTokenCount: estimateTokens(text), totalTokenCount: promptTokens + estimateTokens(text) }, modelVersion: model, responseId: randomAlnum(16) };
    json(res, 200, out);
  }

  // Telegram Bot API (operator alerts): captured, never sent.
  async function telegram(req, res, { params }) {
    if (params.token !== `bot${secrets.telegram.botToken}`) return json(res, 401, { ok: false, error_code: 401, description: 'Unauthorized' });
    const body = await readJson(req);
    const message = { message_id: store.state.telegram.length + 1, chat: { id: body.chat_id }, text: body.text, date: Math.floor(Date.now() / 1000) };
    store.update((s) => { s.telegram.unshift({ at: new Date().toISOString(), ...message }); s.telegram.length = Math.min(s.telegram.length, 300); });
    log(`telegram: operator alert captured: ${String(body.text).slice(0, 80)}`);
    json(res, 200, { ok: true, result: message });
  }

  function routes(router) {
    router.add('POST', '/anthropic/v1/messages', (req, res, ctx) => anthropic(req, res, ctx));
    router.add('POST', '/anthropic/v1/messages/count_tokens', (req, res, ctx) => anthropic(req, res, ctx, true));
    router.add('POST', '/gemini/v1beta/models/:call', (req, res, ctx) => gemini(req, res, ctx));
    router.add('POST', '/gemini/v1/models/:call', (req, res, ctx) => gemini(req, res, ctx));
    router.add('POST', '/telegram/:token/sendMessage', telegram);
    router.add('GET', '/qa/ai', (req, res) => json(res, 200, { mode: settings.real ? 'real' : 'mock', dailyCap: settings.cap, usedToday: S().usage[day()] || 0, maxOutputTokens: settings.maxOut, queued: S().script.length, calls: S().calls }));
    router.add('POST', '/qa/ai/next', async (req, res) => {
      const body = await readJson(req);
      if (!['anthropic', 'gemini'].includes(body.provider) || !body.response || typeof body.response !== 'object') throw new HttpError(400, 'give { provider: "anthropic"|"gemini", response: { text } | { json } | { content } }');
      store.update((s) => { s.ai.script.push({ provider: body.provider, response: body.response }); });
      json(res, 201, { queued: S().script.length });
    });
    router.add('DELETE', '/qa/ai/next', (req, res) => { store.update((s) => { s.ai.script = []; }); json(res, 200, { queued: 0 }); });
    router.add('GET', '/qa/telegram', (req, res) => json(res, 200, { messages: store.state.telegram }));
  }
  return { routes, settings };
}
