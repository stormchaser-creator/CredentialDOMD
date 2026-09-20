import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { writeFile, unlink, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { computeCompliance } from '../src/utils/compliance.js';
import { CA_GERIATRIC_FIELD, OHIO_PAIN_CLINIC_FIELD } from '../src/utils/conditionalCme.js';
import { cmeReviewSummary, cmeAssessmentLabel, totalHoursLabel, topicRecordLabel, needsPriorCompletionReview } from '../src/utils/cmePresentation.js';
import { jurisdictionEvidence } from '../src/utils/assistantEvidence.js';

const expiry = '2028-01-31';
const row = (hours, topics = [], date = '2026-08-01', category = 'AMA PRA Category 1') => ({ id: randomUUID(), title: 'Synthetic course', hours, topics, date, category });
const caEntries = [row(130.5), row(12, ['Pain Management'], '2020-01-01')];
const ca = (answers = {}, degree = 'MD', entries = caEntries) => computeCompliance(entries, 'CA', degree, { licenseExpiration: expiry, topicApplicability: answers });
const oh = (hours = 50, answer) => computeCompliance([row(hours, ['Ethics'])], 'OH', 'MD', { licenseExpiration: expiry, topicApplicability: { [OHIO_PAIN_CLINIC_FIELD]: answer } });
const temp = new URL(`.cme-presentation-${randomUUID()}.tmp.mjs`, import.meta.url);
const built = await build({
  stdin: { contents: 'export { default as Summary } from "../src/components/shared/CmeReviewSummary.jsx"; export { default as Conditional } from "../src/components/shared/ConditionalCmeTopics.jsx";', resolveDir: new URL('.', import.meta.url).pathname },
  bundle: true, write: false, platform: 'node', format: 'esm', jsx: 'automatic', external: ['react', 'react/jsx-runtime'], logLevel: 'silent',
  plugins: [{ name: 'test-context', setup(b) {
    b.onResolve({ filter: /context\/AppContext$/ }, () => ({ path: 'context', namespace: 'test' }));
    b.onLoad({ filter: /.*/, namespace: 'test' }, () => ({ contents: 'export const useApp = () => globalThis.__cmePresentationContext;', loader: 'js' }));
  } }],
});
await writeFile(temp, built.outputFiles[0].text);
const { Summary, Conditional } = await import(temp.href);
const renderSummary = (stateComps, dates = true) => renderToStaticMarkup(React.createElement(Summary, { stateComps, credentialDatesCurrent: dates, theme: {} }));
function collect(element, type, result = []) {
  if (!element || typeof element !== 'object') return result;
  if (Array.isArray(element)) { element.forEach(c => collect(c, type, result)); return result; }
  if (element.type === type) result.push(element);
  collect(element.props?.children, type, result);
  return result;
}
try {
  test('CA total met plus unknown applicability shows confirmation, without invented shortfall or all-clear', () => {
    const comp = ca();
    assert.equal(totalHoursLabel(comp), 'Total logged: 130.5/50h');
    assert.match(cmeAssessmentLabel(comp), /Confirm whether/);
    assert.deepEqual(cmeReviewSummary([{ st: 'CA', comp }]), { records: [], confirmation: ['CA'] });
    const html = renderSummary([{ st: 'CA', comp }]);
    assert.match(html, /CME confirmation needed: CA/);
    assert.match(html, /Credential dates current/);
    assert.doesNotMatch(html, /behind|All credentials current|records to review|compliant/i);
  });
  test('far-future known gap plus unknown rule preserve both facts without implying overdue', () => {
    const comp = oh(10);
    assert.deepEqual(cmeReviewSummary([{ st: 'OH', comp }]), { records: ['OH'], confirmation: ['OH'] });
    const html = renderSummary([{ st: 'OH', comp }]);
    assert.match(html, /CME records to review: OH/);
    assert.match(html, /CME confirmation needed: OH/);
    assert.doesNotMatch(html, /behind|overdue/i);
    assert.match(cmeAssessmentLabel(comp), /Recorded CME gaps.*applicability also/);
  });
  test('California actual applicable topic deficit remains even when total is130.5', () => {
    const comp = ca({ [CA_GERIATRIC_FIELD]: 'Yes' });
    assert.match(cmeAssessmentLabel(comp), /Recorded CME gaps/);
    assert.deepEqual(cmeReviewSummary([{ st: 'CA', comp }]), { records: ['CA'], confirmation: [] });
    assert.equal(topicRecordLabel(comp.topicResults.find(t => t.topic === 'Geriatric Medicine')), 'Geriatric Medicine: 0/10h recorded');
  });
  test('unknown MD/DO cannot become green all-clear or asserted MD gap', () => {
    const comp = ca({}, '');
    assert.match(cmeAssessmentLabel(comp), /Confirm MD or DO.*provisional/);
    assert.deepEqual(cmeReviewSummary([{ st: 'CA', comp }]), { records: [], confirmation: ['CA'] });
  });
  test('mixed state summary separates gap, applicability and expiry independently', () => {
    const stateComps = [{ st: 'CA', comp: ca({ [CA_GERIATRIC_FIELD]: 'Yes' }) }, { st: 'OH', comp: oh() }];
    const html = renderSummary(stateComps, false);
    assert.match(html, /records to review: CA/);
    assert.match(html, /confirmation needed: OH/);
    assert.doesNotMatch(html, /Credential dates current/);
  });
  test('prior completion copy is evidence-based and lifetime records are preserved', () => {
    const comp = ca({ [CA_GERIATRIC_FIELD]: 'No' });
    assert.equal(needsPriorCompletionReview(comp), false);
    const missing = ca({ [CA_GERIATRIC_FIELD]: 'No' }, 'MD', [row(130.5)]);
    assert.equal(needsPriorCompletionReview(missing), true);
    assert.match(topicRecordLabel(missing.topicResults.find(t => t.topic === 'Pain Management')), /0\/12h recorded \(one-time\)/);
    assert.match(topicRecordLabel({ topic: 'Other checklist', checklist: true, met: false }), /completion not recorded/);
  });
  test('provider guidance is visible, sourced and has no answer or completed marker', () => {
    globalThis.__cmePresentationContext = { data: { licenses: [] }, theme: {} };
    const comp = ca();
    const html = renderToStaticMarkup(React.createElement(Conditional, { comp: { ...comp, conditionalTopics: [] } }));
    assert.match(html, /Implicit Bias: provider \/ course guidance/);
    assert.match(html, /leginfo.legislature.ca.gov/);
    assert.doesNotMatch(html, /<select|completed|required topic|missing|0\//i);
  });
  test('actual conditional control starts unknown and saves only explicit license answer, retaining other data', () => {
    const license = { id: 'synthetic-ca', type: 'State Medical License', state: 'CA', expirationDate: expiry, customFields: { unrelated: 'retain' } };
    const before = JSON.stringify(license);
    const calls = [];
    globalThis.__cmePresentationContext = { data: { licenses: [license] }, theme: {}, editItem: (...args) => calls.push(args) };
    const comp = ca();
    const tree = Conditional({ comp });
    const [select] = collect(tree, 'select');
    assert.ok(select);
    assert.equal(select.props.value, '');
    assert.match(select.props['aria-label'], /general internist|family/i);
    assert.equal(calls.length, 0, 'rendering must not attest anything');
    select.props.onChange({ target: { value: 'No' } });
    assert.equal(calls[0][0], 'licenses');
    assert.deepEqual(calls[0][1], { ...license, customFields: { unrelated: 'retain', [CA_GERIATRIC_FIELD]: 'No' } });
    assert.equal(JSON.stringify(license), before);
  });
  test('Vera retains provider classification and DO effective date', () => {
    for (const degree of ['MD', 'DO']) {
      const rule = jurisdictionEvidence('CA', degree).rules[0];
      assert.equal(rule.topics.find(t => t.topic === 'Implicit Bias').classification, 'provider_course_guidance');
      assert.equal(rule.topics.find(t => t.topic === 'Geriatric Medicine').classification, 'personal_requirement');
      if (degree === 'DO') assert.equal(rule.topics.find(t => t.topic === 'Geriatric Medicine').effectiveFrom, '2025-10-01');
    }
  });
  test('phone and desktop use the same tested summary; cards use recorded-hour labels', async () => {
    const source = await readFile(new URL('../src/App.jsx', import.meta.url), 'utf8');
    assert.equal(source.match(/<CmeReviewSummary stateComps=/g)?.length, 2);
    assert.equal(source.match(/pending=\{cmeSummary.confirmation.length > 0\}/g)?.length, 2);
    assert.ok(source.includes('{totalHoursLabel(comp)}'));
    assert.ok(source.includes('{topicRecordLabel(t)}'));
    assert.doesNotMatch(source, /CME behind:|All credentials current/);
  });
} finally {
  await unlink(temp);
  delete globalThis.__cmePresentationContext;
}
