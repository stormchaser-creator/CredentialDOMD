// Finding M4: the CME sessions list must not turn a long transcript into a
// failed scan. Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  scanWithSessionsFallback, scanRequestBody, validateResponse, wantsSessions, isCutOffReply,
  CME_SESSIONS_PROMPT, SYSTEM_PROMPT, MAX_SCAN_SESSIONS, MAX_SCAN_SESSION_TITLE,
  SESSIONS_SKIPPED_NOTE, SESSIONS_TRUNCATED_NOTE,
} from '../src/utils/scannerCore.js';

const reply = (obj, finishReason = 'STOP') => ({ candidates: [{ finishReason, content: { parts: [{ text: JSON.stringify(obj) }] } }] });
const cutOff = () => ({ candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: '{"documentType":"cme","extracted":{"sessions":[{"title":"Sess' }] } }] });
const hasSessions = (body) => body.systemInstruction.parts.some(p => p.text === CME_SESSIONS_PROMPT);
const stub = (...replies) => {
  const bodies = [];
  const send = async (body) => { bodies.push(body); return replies.shift(); };
  return { send, bodies };
};
const cme = { documentType: 'cme', confidence: 'high', extracted: { name: 'Sample Neuro Meeting 2026', hours: 12, completionDate: '2026-03-14' }, notes: '' };
const parts = [{ text: 'synthetic transcript' }];

test('cut off with sessions requested: retried once without them, record still scans', async () => {
  const { send, bodies } = stub(cutOff(), reply(cme));
  const result = await scanWithSessionsFallback(send, { degreeType: 'MD', parts });
  assert.equal(bodies.length, 2);
  assert.equal(hasSessions(bodies[0]), true);
  assert.equal(hasSessions(bodies[1]), false);
  assert.equal(bodies[1].systemInstruction.parts[0].text, SYSTEM_PROMPT('MD', []));
  assert.equal(result.documentType, 'cme');
  assert.equal(result.extracted.hours, 12);
  assert.equal(result.sessionsSkipped, true);
  assert.match(result.notes, new RegExp(SESSIONS_SKIPPED_NOTE.slice(0, 30)));
  assert.equal(result.extracted.sessions, undefined);
});

test('normal reply: one call, sessions kept, no note', async () => {
  const withSessions = { ...cme, extracted: { ...cme.extracted, sessions: [{ title: 'Opioid Prescribing Update', hours: 1, topics: [] }] } };
  const { send, bodies } = stub(reply(withSessions));
  const result = await scanWithSessionsFallback(send, { degreeType: 'DO', parts });
  assert.equal(bodies.length, 1);
  assert.equal(hasSessions(bodies[0]), true);
  assert.equal(result.extracted.sessions.length, 1);
  assert.equal(result.sessionsSkipped, undefined);
  assert.equal(result.notes, '');
});

test('cut off without sessions requested: the error stands, no retry', async () => {
  const { send, bodies } = stub(cutOff());
  await assert.rejects(scanWithSessionsFallback(send, { degreeType: 'MD', parts, expectedType: 'license' }), /cut off/);
  assert.equal(bodies.length, 1);
  assert.equal(hasSessions(bodies[0]), false);
});

test('cut off twice: the second error reaches the caller', async () => {
  const { send, bodies } = stub(cutOff(), cutOff());
  await assert.rejects(scanWithSessionsFallback(send, { parts }), /cut off/);
  assert.equal(bodies.length, 2);
});

test('only CME or unclassified scans ask for sessions', () => {
  assert.equal(wantsSessions(undefined), true);
  assert.equal(wantsSessions(null), true);
  assert.equal(wantsSessions('cme'), true);
  for (const t of ['license', 'receipt', 'travel', 'insurance']) {
    assert.equal(wantsSessions(t), false);
    assert.equal(hasSessions(scanRequestBody({ degreeType: 'MD', parts, expectedType: t })), false);
  }
  assert.equal(hasSessions(scanRequestBody({ degreeType: 'MD', parts })), true);
  assert.equal(isCutOffReply(cutOff()), true);
  assert.equal(isCutOffReply(reply(cme)), false);
});

test('a non-CME reading drops any sessions the model returned', () => {
  const r = validateResponse({ documentType: 'license', confidence: 'high', extracted: { state: 'CO', sessions: [{ title: 'x' }], sessionsTruncated: true } });
  assert.equal(r.extracted.sessions, undefined);
  assert.equal(r.extracted.sessionsTruncated, undefined);
});

test('the sessions list is capped, titles cut, and a capped list says so', () => {
  const long = 'Session on Pain Management '.repeat(10);
  const sessions = Array.from({ length: 150 }, (_, i) => ({ title: `${i + 1} ${long}`, hours: 0.5, topics: [] }));
  const r = validateResponse({ documentType: 'cme', confidence: 'high', extracted: { name: 'Sample Meeting', sessions }, notes: '' });
  assert.equal(r.extracted.sessions.length, MAX_SCAN_SESSIONS);
  assert.ok(r.extracted.sessions.every(s => s.title.length <= MAX_SCAN_SESSION_TITLE));
  assert.equal(r.sessionsTruncated, true);
  assert.equal(r.extracted.sessionsTruncated, undefined, 'never a field on the record');
  assert.match(r.notes, /first 60 sessions/);
  const flagged = validateResponse({ documentType: 'cme', confidence: 'high', extracted: { name: 'M', sessions: sessions.slice(0, 3), sessionsTruncated: true } });
  assert.equal(flagged.sessionsTruncated, true);
  assert.equal(flagged.notes, SESSIONS_TRUNCATED_NOTE);
});

test('the sessions prompt caps the list and has no em dash', () => {
  assert.match(CME_SESSIONS_PROMPT, /at most 60/);
  assert.match(CME_SESSIONS_PROMPT, /"sessionsTruncated": true/);
  for (const t of [CME_SESSIONS_PROMPT, SESSIONS_SKIPPED_NOTE, SESSIONS_TRUNCATED_NOTE]) assert.doesNotMatch(t, /—/);
});
