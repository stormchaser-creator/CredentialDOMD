// Topic suggestions per CME session (src/utils/topicSuggest.js), the scanner
// check that keeps them off the whole record, and where the session list is
// kept. Synthetic titles only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  suggestTopicsForTitle, normalizeCmeSessions, sessionTopicSuggestions, normalizeCmeScan, cmeSessionsOf, CME_SESSIONS_FIELD,
} from '../src/utils/topicSuggest.js';
import { validateResponse, scanRequestBody, CME_SESSIONS_PROMPT, SYSTEM_PROMPT } from '../src/utils/scannerCore.js';
import { cmeEntryFromScan } from '../src/utils/scanShape.js';
import { splitScanned } from '../src/utils/scanSplit.js';
import { SECTION_FIELDS } from '../src/utils/sectionFields.js';
import { CME_TOPICS } from '../src/constants/cmeTopics.js';

const topics = (title) => suggestTopicsForTitle(title).map(s => s.topic);

const STIMULANT_TITLE = 'Neurologic Complications of Intoxication and Withdrawal Syndromes Associated With Tobacco/Vaping, Psychostimulants, Gabapentinoids, Sedatives/Hypnotics, and Inhalants';

test('the addiction session of a conference names substance use and controlled substances, with the words as the reason', () => {
  const s = suggestTopicsForTitle(STIMULANT_TITLE);
  assert.deepEqual(s.map(x => x.topic), ['Controlled Substances', 'Substance Use Disorders']);
  assert.match(s.find(x => x.topic === 'Substance Use Disorders').reason, /"Intoxication"/);
  assert.match(s.find(x => x.topic === 'Controlled Substances').reason, /"Psychostimulants"/);
});

test('keyword map: each family lands on its topic', () => {
  assert.deepEqual(topics('Management of Chronic Pain'), ['Pain Management']);
  assert.deepEqual(topics('Safe Opioid Prescribing in the Postoperative Patient'), ['Opioid Prescribing']);
  assert.ok(topics('Opioid Use Disorder: Starting Buprenorphine in Clinic').includes('Substance Use Disorders'));
  assert.ok(topics('Opioid Use Disorder: Starting Buprenorphine in Clinic').includes('Opioid Prescribing'));
  assert.deepEqual(topics('Schedule II Drugs and the Risk of Addiction'), ['Controlled Substances', 'Substance Use Disorders']);
  assert.deepEqual(topics('Benzodiazepine Tapering'), ['Controlled Substances']);
  assert.deepEqual(topics('Stimulants for Adult ADHD'), ['Controlled Substances']);
  assert.deepEqual(topics('Addiction Medicine Update'), ['Substance Use Disorders']);
  assert.deepEqual(topics('Hospice Referral and Advance Care Planning'), ['End-of-Life Care']);
  assert.deepEqual(topics('Palliative Care for Glioblastoma'), ['Palliative Care']);
  assert.deepEqual(topics('Ethical Dilemmas in Surgical Consent'), ['Ethics']);
  assert.deepEqual(topics('Implicit Bias in Clinical Decisions'), ['Implicit Bias']);
  assert.deepEqual(topics('Risk Management for Proceduralists'), ['Risk Management']);
  assert.deepEqual(topics('Suicide Risk Screening'), ['Suicide Prevention']);
  assert.deepEqual(topics('Recognizing Human Trafficking in the ED'), ['Human Trafficking']);
  assert.deepEqual(topics('HIV PrEP Basics'), ['HIV/AIDS']);
  assert.deepEqual(topics('Telehealth Visits That Work'), ['Telemedicine']);
});

test('weak words do not tag', () => {
  for (const t of [
    'Selection Bias in Observational Trials', 'Alcohol Septal Ablation Outcomes', 'Spinal Epidural Infections',
    'Deep Brain Stimulation Programming', 'Cortical Spreading Depression and Migraine', 'Respiratory Depression After Anesthesia',
    'Hearing Aids and Cognitive Decline', 'Opening Remarks', '', null,
  ]) assert.deepEqual(topics(t), [], String(t));
});

test('withdrawal of care is end of life, not addiction', () => {
  assert.deepEqual(topics('Withdrawal of Life-Sustaining Treatment in Severe TBI'), ['End-of-Life Care']);
});

test('every suggestion is a topic from the fixed list, in its order, once', () => {
  const s = suggestTopicsForTitle('Opioids, Pain, Pain Again, Ethics and Palliative Care at the End of Life');
  for (const x of s) assert.ok(CME_TOPICS.includes(x.topic));
  assert.deepEqual(s.map(x => x.topic), [...new Set(s.map(x => x.topic))]);
  const idx = s.map(x => CME_TOPICS.indexOf(x.topic));
  assert.deepEqual(idx, [...idx].sort((a, b) => a - b));
});

test('sessions: a scan topic off the list is dropped, a title topic is always offered, a scan-only topic says so', () => {
  const list = normalizeCmeSessions([
    { title: 'Management of Chronic Pain', hours: '1.0', topics: ['Made Up Topic', 'General / No Specific Topic'] },
    { title: 'Updates in Stroke Imaging', hours: 1.5, topics: ['Ethics'] },
    { title: '   ', hours: 2 },
    'not a session',
  ]);
  assert.equal(list.length, 2);
  assert.deepEqual(list[0], { title: 'Management of Chronic Pain', hours: 1, topics: [{ topic: 'Pain Management', reason: 'Title says "Pain"', source: 'title' }] });
  assert.deepEqual(list[1].topics, [{ topic: 'Ethics', reason: 'Read from the document by the scan', source: 'scan' }]);
  // Stored lists read back the same.
  assert.deepEqual(normalizeCmeSessions(list), list);
});

test('suggestions sum the hours of the sessions that triggered each topic', () => {
  const s = sessionTopicSuggestions(normalizeCmeSessions([
    { title: STIMULANT_TITLE, hours: 1.5 },
    { title: 'Opioid Use Disorder in Pregnancy', hours: 1 },
    { title: 'Management of Chronic Pain', hours: 0.75 },
    { title: 'Pain After Spine Surgery' },
  ]));
  const sud = s.find(x => x.topic === 'Substance Use Disorders');
  assert.equal(sud.hours, 2.5);
  assert.deepEqual(sud.sessions.map(x => x.title), [STIMULANT_TITLE, 'Opioid Use Disorder in Pregnancy']);
  const pain = s.find(x => x.topic === 'Pain Management');
  assert.equal(pain.hours, 0.75, 'a session with no printed hours adds none');
  assert.equal(pain.sessions.length, 2);
});

test('scanner: a transcript keeps its sessions and no session topic is put on the whole record', () => {
  const r = validateResponse({
    documentType: 'cme', confidence: 'high',
    extracted: {
      title: 'Synthetic Osteopathic Annual Convention 2026', category: 'AOA Category 1-A', hours: 60, date: '2026-10-20',
      topics: ['Substance Use Disorders', 'Pain Management', 'Ethics'],
      sessions: [
        { title: STIMULANT_TITLE, hours: 1.5, topics: ['Substance Use Disorders'] },
        { title: 'Management of Chronic Pain', hours: 1, topics: [] },
      ],
    },
  });
  assert.deepEqual(r.extracted.topics, ['Ethics'], 'Ethics came from elsewhere on the certificate, as before');
  assert.equal(r.extracted.sessions.length, 2);
  assert.deepEqual(r.extracted.sessions[0].topics.map(t => t.topic), ['Controlled Substances', 'Substance Use Disorders']);
});

test('scanner: a topic the activity title itself names stays on the record', () => {
  const r = normalizeCmeScan({ title: 'Pain Management Summit', topics: ['Pain Management'], sessions: [{ title: 'Management of Chronic Pain', hours: 1 }] });
  assert.deepEqual(r.topics, ['Pain Management']);
});

test('scanner: a single certificate with no sessions is unchanged', () => {
  const ex = { title: 'Opioid Safety', hours: 2, topics: ['Opioid Prescribing'] };
  assert.equal(normalizeCmeScan(ex), ex);
  assert.deepEqual(validateResponse({ documentType: 'cme', confidence: 'high', extracted: { ...ex } }).extracted, ex);
  assert.deepEqual(normalizeCmeScan({ ...ex, sessions: [] }), ex, 'an empty list is dropped');
  assert.deepEqual(normalizeCmeScan({ ...ex, sessions: 'none' }), ex);
});

test('the sessions instruction rides as its own system part; the main prompt keeps its exact text', () => {
  const body = scanRequestBody({ degreeType: 'DO', parts: [{ text: 'x' }] });
  assert.equal(body.systemInstruction.parts.length, 2);
  assert.equal(body.systemInstruction.parts[0].text, SYSTEM_PROMPT('DO', []));
  assert.equal(body.systemInstruction.parts[1].text, CME_SESSIONS_PROMPT);
  assert.match(CME_SESSIONS_PROMPT, /extracted\.sessions/);
  assert.doesNotMatch(CME_SESSIONS_PROMPT, /—/);
});

test('saving a scan keeps the sessions in customFields, never as a column', () => {
  const sessions = normalizeCmeSessions([{ title: 'Management of Chronic Pain', hours: 1 }]);
  const e = cmeEntryFromScan({ title: 'T', hours: 60, topics: ['Pain Management'], sessions, pharmacologyHours: '2' });
  assert.ok(!('sessions' in e));
  assert.deepEqual(e.customFields[CME_SESSIONS_FIELD], sessions);
  assert.equal(e.customFields['Pharmacology Hours'], '2');
  assert.deepEqual(cmeSessionsOf(e), sessions);
  assert.deepEqual(cmeEntryFromScan({ title: 'T', sessions: [] }), { title: 'T' });
  assert.deepEqual(cmeSessionsOf({}), []);
});

test('an attached or emailed transcript keeps its sessions whole, not as "[object Object]" text', () => {
  const { placed, extras } = splitScanned({ title: 'T', hours: 60, sessions: [{ title: 'Management of Chronic Pain', hours: 1 }] }, SECTION_FIELDS.cme);
  assert.ok(!('sessions' in placed));
  assert.equal(extras[CME_SESSIONS_FIELD][0].title, 'Management of Chronic Pain');
  assert.equal(extras[CME_SESSIONS_FIELD][0].topics[0].topic, 'Pain Management');
});

// ── The review card's "Suggested topics" ──
const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('..', import.meta.url));
const bundled = await build({
  stdin: { contents: 'export {default, PendingSessionTopics} from "./src/components/shared/SessionTopicSuggestions.jsx";', resolveDir: root, loader: 'jsx' },
  bundle: true, define: { 'import.meta.env': '{}' }, platform: 'node', format: 'cjs', write: false, jsx: 'automatic', external: ['react', 'react/jsx-runtime'], logLevel: 'silent',
  plugins: [{ name: 'fixture', setup(b) {
    b.onResolve({ filter: /context\/AppContext$/ }, () => ({ path: 'context', namespace: 'fixture' }));
    b.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export const useApp = () => ({ isDesktop: false, theme: { text: "#111", textMuted: "#666", textDim: "#888", border: "#aaa", accent: "#2a7" } });' }));
  } }],
});
const mod = { exports: {} };
new Function('require', 'module', 'exports', bundled.outputFiles[0].text)(require, mod, mod.exports);
const Suggestions = mod.exports.default;
const Pending = mod.exports.PendingSessionTopics;

test('the card names each topic with the session that triggered it, and only accepted topics read as on', () => {
  const sessions = normalizeCmeSessions([{ title: STIMULANT_TITLE, hours: 1.5 }, { title: 'Management of Chronic Pain', hours: 1 }, { title: 'Stroke Imaging Update', hours: 1 }]);
  const html = renderToStaticMarkup(React.createElement(Suggestions, { sessions, topics: ['Pain Management'], onToggle() {}, onAcceptAll() {} }));
  assert.match(html, /Suggested topics/);
  assert.match(html, /Substance Use Disorders: 1\.5 h/);
  assert.match(html, /1\.5 h from .{1,8}Neurologic Complications of Intoxication/);
  assert.match(html, /aria-pressed="true"[^>]*>✓ Pain Management/);
  assert.match(html, /aria-pressed="false"[^>]*>\+ Substance Use Disorders/);
  assert.match(html, /All 3 sessions/);
  assert.match(html, /Stroke Imaging Update/);
  assert.equal(renderToStaticMarkup(React.createElement(Suggestions, { sessions: [], topics: [], onToggle() {} })), '');
});

test('docs@ intake files the transcript with its sessions in custom fields and only the record-level topics', async () => {
  const { builtInFields } = await import('../supabase/functions/_shared/intakeFiling.mjs');
  const scan = validateResponse({ documentType: 'cme', confidence: 'high', extracted: {
    title: 'Synthetic Annual Convention', category: 'AOA Category 1-A', hours: 60, date: '2026-10-20',
    topics: ['Substance Use Disorders'], sessions: [{ title: STIMULANT_TITLE, hours: 1.5, topics: ['Substance Use Disorders'] }],
  } });
  const { placed, extras } = builtInFields('cme', scan.extracted);
  assert.deepEqual(placed.topics, [], 'a session topic waits for the physician');
  assert.ok(!('sessions' in placed));
  assert.equal(extras[CME_SESSIONS_FIELD][0].hours, 1.5);
});

test('a saved card points to session topics not on it yet, and says nothing once they are', () => {
  const record = { customFields: { [CME_SESSIONS_FIELD]: normalizeCmeSessions([{ title: STIMULANT_TITLE, hours: 1.5 }]) } };
  const html = renderToStaticMarkup(React.createElement(Pending, { record, topics: [], onReview() {} }));
  assert.match(html, /2 suggested topics from its sessions: Controlled Substances, Substance Use Disorders\. Review/);
  assert.equal(renderToStaticMarkup(React.createElement(Pending, { record, topics: ['Controlled Substances', 'Substance Use Disorders'], onReview() {} })), '');
  assert.equal(renderToStaticMarkup(React.createElement(Pending, { record: {}, topics: [], onReview() {} })), '');
});
