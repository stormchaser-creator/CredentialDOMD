// The free reader (supabase/functions/_shared/workersAiCall.mjs): what is
// sent to Cloudflare Workers AI, how its reply is handed back for
// readModelReply, and what a failure says. Network-free: fetch is a stub.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  callWorkersAi, workersAiConfig, workersAiErrorWhy, workersAiRequest, WORKERS_AI_MODEL,
} from '../supabase/functions/_shared/workersAiCall.mjs';
import { buildUnderstandingRequest, readModelReply, UNDERSTANDING_SCHEMA } from '../supabase/functions/_shared/intakeUnderstanding.mjs';

const ACCOUNT = '0123456789abcdef0123456789abcdef';
const TOKEN = 'cf-test-token-not-real';
const config = workersAiConfig({ accountId: ACCOUNT, token: TOKEN });
const request = buildUnderstandingRequest({ subject: 'Fwd: BLS card', sender: { name: 'Casey', address: 'casey@clinic.example' }, message: 'Please send your BLS card.' });
const READING = { intent: 'request', asks: [{ quote: 'Please send your BLS card.', kind: 'bls', who: 'physician' }], attachments: [], summary: 'a BLS card', confidence: 'high', records: [] };

function fakeDb() {
  const usage = [];
  return { usage, from: () => ({ insert: async (row) => { usage.push(row); return { error: null }; } }) };
}
const reply = (body, status = 200) => async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('config: a 32-hex account id, a token and a model name are required; the default model is Llama 3.3 70B', () => {
  assert.deepEqual(config, { accountId: ACCOUNT, token: TOKEN, model: WORKERS_AI_MODEL });
  assert.equal(WORKERS_AI_MODEL, '@cf/meta/llama-3.3-70b-instruct-fp8-fast');
  assert.equal(workersAiConfig({ accountId: '', token: TOKEN }), null);
  assert.equal(workersAiConfig({ accountId: ACCOUNT, token: '' }), null);
  assert.equal(workersAiConfig({ accountId: '../../evil', token: TOKEN }), null, 'nothing but an account id goes into the URL');
  assert.equal(workersAiConfig({ accountId: ACCOUNT, token: TOKEN, model: '@cf/x/../../y' }), null);
  assert.equal(workersAiConfig({ accountId: ACCOUNT, token: TOKEN, model: '@cf/qwen/qwen2.5-coder-32b-instruct' }).model, '@cf/qwen/qwen2.5-coder-32b-instruct');
});

test('request: the same system prompt, user turn and JSON schema as the Anthropic call, at temperature 0', () => {
  const body = workersAiRequest(request);
  assert.equal(body.messages[0].role, 'system');
  assert.ok(body.messages[0].content.startsWith(request.system[0].text));
  assert.match(body.messages[0].content, /JSON object only/);
  assert.deepEqual(body.messages[1], { role: 'user', content: request.messages[0].content });
  assert.deepEqual(body.response_format, { type: 'json_schema', json_schema: UNDERSTANDING_SCHEMA });
  assert.equal(body.temperature, 0);
  assert.ok(body.max_tokens > 0);
  for (const k of ['model', 'thinking', 'output_config', 'system']) assert.ok(!(k in body), `${k} is Anthropic's, not sent`);
});

test('a reply parsed by JSON mode comes back as a Messages-shaped reply readModelReply accepts, and is metered', async () => {
  const db = fakeDb();
  const sent = [];
  const fetchImpl = async (url, init) => { sent.push({ url, init }); return reply({ success: true, errors: [], result: { response: READING, usage: { prompt_tokens: 2100, completion_tokens: 300 } } })(); };
  const r = await callWorkersAi({ config, request, db, profileId: 'p1', promptChars: 99, timeoutMs: 5000, fetchImpl });
  assert.equal(r.ok, true);
  assert.equal(sent[0].url, `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/ai/run/${WORKERS_AI_MODEL}`);
  assert.equal(sent[0].init.headers.Authorization, `Bearer ${TOKEN}`);
  const read = readModelReply(r.message);
  assert.equal(read.ok, true);
  assert.deepEqual(read.value, READING);
  assert.deepEqual(db.usage, [{ user_id: 'p1', path: 'ai/run', provider: 'cloudflare', model: WORKERS_AI_MODEL, prompt_chars: 99, ok: true, status: 200, input_tokens: 2100, output_tokens: 300 }]);
});

test('a reply as a string, or in the OpenAI-style choices shape, reads the same; one cut off at its length is a cut-off reply', async () => {
  const asString = await callWorkersAi({ config, request, timeoutMs: 5000, fetchImpl: reply({ success: true, result: { response: JSON.stringify(READING) } }) });
  assert.equal(readModelReply(asString.message).ok, true);
  const choices = await callWorkersAi({ config, request, timeoutMs: 5000, fetchImpl: reply({ success: true, result: { choices: [{ message: { content: JSON.stringify(READING) }, finish_reason: 'stop' }] } }) });
  assert.equal(readModelReply(choices.message).ok, true);
  const cut = await callWorkersAi({ config, request, timeoutMs: 5000, fetchImpl: reply({ success: true, result: { choices: [{ message: { content: '{"intent":"req' }, finish_reason: 'length' }] } }) });
  assert.deepEqual(readModelReply(cut.message), { ok: false, why: 'the reply was cut off' });
  const prose = await callWorkersAi({ config, request, timeoutMs: 5000, fetchImpl: reply({ success: true, result: { response: 'Sure! Here is the JSON:' } }) });
  assert.deepEqual(readModelReply(prose.message), { ok: false, why: 'the reply is not JSON' });
});

test('an error Workers AI answered with says its status, code and message, and never the token or a link', async () => {
  const db = fakeDb();
  const r = await callWorkersAi({
    config, request, db, profileId: 'p1', timeoutMs: 5000,
    fetchImpl: reply({ success: false, errors: [{ code: 4006, message: `you have used up your daily free allocation of 10,000 neurons, see https://dash.cloudflare.com/x ${'a'.repeat(40)}` }], result: null }, 429),
  });
  assert.equal(r.ok, false);
  assert.equal(r.status, 429);
  assert.equal(r.why, 'Workers AI answered 429 (4006: you have used up your daily free allocation of 10,000 neurons, see)');
  assert.doesNotMatch(r.why, /https?:|aaaa/);
  assert.deepEqual(db.usage.map((u) => [u.ok, u.status]), [[false, 429]]);
  assert.equal(workersAiErrorWhy(null), '');
  assert.equal(workersAiErrorWhy({ errors: [{ code: 10000, message: 'Authentication error' }] }), '10000: Authentication error');
});

test('a call that never answers times out, one that cannot connect is unreachable, and neither has a status', async () => {
  const hang = (_url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))));
  const t = await callWorkersAi({ config, request, timeoutMs: 30, minMs: 1, fetchImpl: hang });
  assert.deepEqual(t, { ok: false, why: 'Workers AI timed out', status: null });
  const u = await callWorkersAi({ config, request, timeoutMs: 1000, fetchImpl: async () => { throw new TypeError(`fetch failed https://x/${TOKEN}`); } });
  assert.deepEqual(u, { ok: false, why: 'Workers AI was unreachable', status: null });
});

test('not configured, or too little time left: no call is made', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return reply({ success: true, result: { response: READING } })(); };
  assert.deepEqual(await callWorkersAi({ config: null, request, timeoutMs: 5000, fetchImpl }), { ok: false, why: 'Workers AI not configured', status: null });
  assert.deepEqual(await callWorkersAi({ config, request, timeoutMs: 5000, minMs: 2000, deadline: Date.now() + 500, fetchImpl }), { ok: false, why: 'Workers AI: time budget spent', status: null });
  assert.equal(calls, 0);
});
