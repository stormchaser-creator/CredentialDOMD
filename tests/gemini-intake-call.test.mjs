// The first reader (supabase/functions/_shared/geminiIntakeCall.mjs): what is
// sent to Gemini, how its reply is handed back for readModelReply, and what a
// failure says. Network-free: fetch is a stub.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  callGeminiIntake, geminiErrorWhy, geminiIntakeConfig, geminiIntakeRequest, GEMINI_INTAKE_MODEL,
} from '../supabase/functions/_shared/geminiIntakeCall.mjs';
import { GEMINI_MODEL } from '../supabase/functions/_shared/app/utils/geminiModel.js';
import { buildUnderstandingRequest, readModelReply, UNDERSTANDING_SCHEMA } from '../supabase/functions/_shared/intakeUnderstanding.mjs';

const KEY = 'AIza-test-key-not-real';
const BASE = 'https://generativelanguage.googleapis.com';
const config = geminiIntakeConfig({ key: KEY, base: BASE });
const request = buildUnderstandingRequest({ subject: 'Fwd: BLS card', sender: { name: 'Casey', address: 'casey@clinic.example' }, message: 'Please send your BLS card.' });
const READING = { intent: 'request', asks: [{ quote: 'Please send your BLS card.', kind: 'bls', who: 'physician' }], attachments: [], summary: 'a BLS card', confidence: 'high', records: [] };

function fakeDb() {
  const usage = [];
  return { usage, from: () => ({ insert: async (row) => { usage.push(row); return { error: null }; } }) };
}
const reply = (body, status = 200) => async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const answer = (text, finishReason = 'STOP', extra = {}) => ({
  candidates: [{ finishReason, content: { role: 'model', parts: [{ text: 'thinking...', thought: true }, { text }] } }],
  usageMetadata: { promptTokenCount: 2000, candidatesTokenCount: 300, thoughtsTokenCount: 50 },
  modelVersion: GEMINI_MODEL,
  ...extra,
});

test('config: the key is required; the default model is the scanner\'s own Flash model; only a Gemini model name is taken', () => {
  assert.equal(GEMINI_INTAKE_MODEL, GEMINI_MODEL);
  assert.deepEqual(config, { key: KEY, model: GEMINI_MODEL, base: BASE });
  assert.equal(geminiIntakeConfig({ key: '', base: BASE }), null);
  assert.equal(geminiIntakeConfig({ key: KEY }), null, 'the base is the caller\'s GEMINI_API_BASE override');
  assert.equal(geminiIntakeConfig({ key: KEY, base: BASE, model: 'gemini-2.5-flash' }).model, 'gemini-2.5-flash');
  assert.equal(geminiIntakeConfig({ key: KEY, base: BASE, model: '../../evil' }), null, 'nothing but a model name goes into the URL');
  assert.equal(geminiIntakeConfig({ key: KEY, base: BASE, model: 'claude-opus-5' }), null);
  assert.equal(geminiIntakeConfig({ key: KEY, base: 'http://127.0.0.1:9/gemini/' }).base, 'http://127.0.0.1:9/gemini');
});

test('request: the same system prompt, user turn and JSON schema as the Anthropic call, in structured-output mode', () => {
  const body = geminiIntakeRequest(request);
  assert.deepEqual(body.systemInstruction, { parts: [{ text: request.system[0].text }] });
  assert.deepEqual(body.contents, [{ role: 'user', parts: [{ text: request.messages[0].content }] }]);
  assert.equal(body.generationConfig.responseMimeType, 'application/json');
  assert.deepEqual(body.generationConfig.responseJsonSchema, UNDERSTANDING_SCHEMA);
  assert.equal(body.generationConfig.thinkingConfig.thinkingLevel, 'LOW');
  assert.ok(body.generationConfig.maxOutputTokens > 0);
  for (const k of ['model', 'thinking', 'output_config', 'system', 'messages']) assert.ok(!(k in body), `${k} is Anthropic's, not sent`);
});

test('a structured reply comes back Messages-shaped for readModelReply, thoughts left out, and is metered and costed', async () => {
  const db = fakeDb();
  const sent = [];
  const fetchImpl = async (url, init) => { sent.push({ url, init }); return reply(answer(JSON.stringify(READING)))(); };
  const r = await callGeminiIntake({ config, request, db, profileId: 'p1', promptChars: 99, timeoutMs: 5000, fetchImpl });
  assert.equal(r.ok, true);
  assert.equal(sent[0].url, `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`);
  assert.doesNotMatch(sent[0].url, /key=/, 'the key goes in a header, never the URL');
  assert.equal(sent[0].init.headers['x-goog-api-key'], KEY);
  const read = readModelReply(r.message);
  assert.equal(read.ok, true);
  assert.deepEqual(read.value, READING);
  assert.equal(db.usage.length, 1);
  const u = db.usage[0];
  assert.deepEqual([u.user_id, u.path, u.provider, u.model, u.prompt_chars, u.ok, u.status, u.input_tokens, u.output_tokens, u.thinking_tokens],
    ['p1', `models/${GEMINI_MODEL}:generateContent`, 'gemini', GEMINI_MODEL, 99, true, 200, 2000, 300, 50]);
  assert.ok(u.cost_usd > 0, 'priced like a scan');
  assert.equal(r.costUsd, u.cost_usd);
});

test('a reply cut off at its token limit, a safety stop, a blocked prompt and prose all fail readModelReply', async () => {
  const run = async (body) => readModelReply((await callGeminiIntake({ config, request, timeoutMs: 5000, fetchImpl: reply(body) })).message);
  assert.deepEqual(await run(answer('{"intent":"req', 'MAX_TOKENS')), { ok: false, why: 'the reply was cut off' });
  assert.deepEqual(await run(answer('', 'SAFETY')), { ok: false, why: 'the model declined' });
  assert.deepEqual(await run({ promptFeedback: { blockReason: 'SAFETY' } }), { ok: false, why: 'the model declined' });
  assert.deepEqual(await run(answer('Sure! Here is the JSON:')), { ok: false, why: 'the reply is not JSON' });
});

test('an error Gemini answered with says its status and message, and never the key or a link', async () => {
  const db = fakeDb();
  const r = await callGeminiIntake({
    config, request, db, profileId: 'p1', timeoutMs: 5000,
    fetchImpl: reply({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: `Quota exceeded for ${KEY}, see https://ai.google.dev/gemini-api/docs/rate-limits` } }, 429),
  });
  assert.equal(r.ok, false);
  assert.equal(r.status, 429);
  assert.equal(r.why, 'Gemini answered 429 (RESOURCE_EXHAUSTED: Quota exceeded for , see)');
  assert.doesNotMatch(r.why, /AIza|https?:/);
  assert.deepEqual(db.usage.map((u) => [u.ok, u.status, u.cost_usd]), [[false, 429, null]]);
  assert.equal(geminiErrorWhy(null), '');
  assert.equal(geminiErrorWhy({ error: { code: 400, status: 'INVALID_ARGUMENT', message: 'API key not valid. Please pass a valid API key.' } }), 'INVALID_ARGUMENT: API key not valid. Please pass a valid API key.');
});

test('a call that never answers times out, one that cannot connect is unreachable, and neither has a status', async () => {
  const hang = (_url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))));
  const t = await callGeminiIntake({ config, request, timeoutMs: 30, minMs: 1, fetchImpl: hang });
  assert.deepEqual(t, { ok: false, why: 'Gemini timed out', status: null });
  const u = await callGeminiIntake({ config, request, timeoutMs: 1000, fetchImpl: async () => { throw new TypeError(`fetch failed ${KEY}`); } });
  assert.deepEqual(u, { ok: false, why: 'Gemini was unreachable', status: null });
});

test('not configured, or too little time left: no call is made', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return reply(answer(JSON.stringify(READING)))(); };
  assert.deepEqual(await callGeminiIntake({ config: null, request, timeoutMs: 5000, fetchImpl }), { ok: false, why: 'Gemini not configured', status: null });
  assert.deepEqual(await callGeminiIntake({ config, request, timeoutMs: 5000, minMs: 2000, deadline: Date.now() + 500, fetchImpl }), { ok: false, why: 'Gemini: time budget spent', status: null });
  assert.equal(calls, 0);
});
