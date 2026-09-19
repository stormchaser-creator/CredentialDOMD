import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { calculationEvidence, jurisdictionEvidence, renewalEvidence, savedReferenceContext, mentionedJurisdictions, evidenceForTurn } from '../../src/utils/assistantEvidence.js';
import { STATE_REQS } from '../../src/constants/stateRequirements.js';
import { VERA_SOURCES, VERA_SOURCE_VERSION } from '../../supabase/functions/_shared/veraSourceRegistry.mjs';

test('recorded dates and effective-date unknowns are not converted to current verification', () => {
  const ref = jurisdictionEvidence('CA', 'MD').rules[0];
  assert.equal(ref.recordedReview, STATE_REQS.CA.md.verified);
  assert.equal(ref.currentVerification, 'not_performed');
  assert.equal(ref.effectiveFrom, null);
  assert.equal(ref.effectiveThrough, null);
  assert.equal(ref.reviewStatus, 'not_revalidated_for_this_answer');
  const specific = ref.topics.find(t => t.topic === 'Pain Management');
  assert.equal(specific.sourceScope, 'topic_specific_reference');
  assert.equal(specific.recordedReview, null);
  const inherited = ref.topics.find(t => t.topic === 'Geriatric Medicine');
  assert.equal(inherited.url, ref.url);
  assert.equal(inherited.sourceScope, 'inherited_rule_reference_not_topic_verification');
});

test('unknown degree exposes both actual variants, never the default 50-hour rule', () => {
  const ref = jurisdictionEvidence('AZ');
  assert.equal(ref.degreeSelectionNeeded, true);
  assert.deepEqual(ref.rules.map(r => r.degree), ['MD', 'DO']);
  assert.equal(ref.rules[1].reviewStatus, 'needs_independent_review');
  assert.equal(jurisdictionEvidence('ZZ', 'DO'), null);
  for (const state of ['VT', 'WA', 'MO']) assert.ok(jurisdictionEvidence(state, 'MD').rules.every(r => r.reviewStatus === 'needs_independent_review'));
});

test('New York zero general hours preserves mandatory topics and old upcoming notices remain unconfirmed', () => {
  const ny = jurisdictionEvidence('NY', 'MD').rules[0];
  assert.equal(ny.savedGeneralHours, 0);
  assert.ok(ny.topics.length > 0);
  const pa = jurisdictionEvidence('PA', 'MD').rules[0];
  assert.ok(pa.changeNotices.length);
  assert.ok(pa.changeNotices.every(n => n.status === 'timing_and_enactment_need_check'));
});

test('historical, future and unanchored calculations retain exact dates without legal approval', () => {
  const comp = { state: 'OH', windowStart: new Date(2022, 9, 1), windowEnd: new Date(2024, 8, 30), windowSource: 'custom', windowAnchored: true,
    conditionalTopics: [{ topic: 'Pain', applicability: 'unknown', condition: { description: 'Clinic care' } }] };
  const e = calculationEvidence(comp, 'DO', '2026-09-19');
  assert.deepEqual(e.countingWindow, { start: '2022-10-01', end: '2024-09-30', source: 'custom', licenseAnchored: true, status: 'historical', overrideIgnored: false });
  assert.equal(e.legalComplianceDetermination, false);
  assert.equal(e.historicalRuleCoverage, 'not_established');
  assert.equal(e.conditionalApplicability[0].applicability, 'unknown');
  assert.equal(calculationEvidence({ ...comp, windowAnchored: false }, 'MD', '2026-09-19').countingWindow.status, 'unanchored');
  assert.equal(calculationEvidence({ ...comp, windowStart: new Date(2027, 0, 1), windowEnd: new Date(2028, 0, 1) }, 'MD', '2026-09-19').countingWindow.status, 'future');
});

test('renewal routes separate DO from MD; undated fee/step amounts never enter authoritative context', () => {
  const az = renewalEvidence('AZ', 'DO');
  assert.equal(new URL(az.portal).hostname, 'azdo.gov');
  assert.equal(az.fee, null);
  assert.ok(az.sourceUrls.length);
  assert.equal(az.currentVerification, 'not_performed');
  assert.ok(!az.steps.join(' ').includes('$'));
  assert.equal(renewalEvidence('AZ', null).alternativeDOBoard.url, 'https://azdo.gov/');
  assert.equal(renewalEvidence('CT', 'DO').alternativeDOBoard, null);
  assert.equal(renewalEvidence('ZZ', 'MD'), null);
});

test('local routing supports untracked states without changing saved ownership or leaking private fields into references', () => {
  const history = [{ role: 'user', text: 'For another physician, what does an Arizona DO need? Also New York.' }];
  assert.deepEqual(mentionedJurisdictions(history), ['AZ', 'NY']);
  const snapshot = { physician: { name: 'PRIVATE NAME', degree: 'MD', states: ['OH'], npi: 'SECRET-NPI' }, licenses: [{ number: 'PRIVATE-LICENSE' }] };
  const result = evidenceForTurn(snapshot, history);
  assert.deepEqual(result.physician.states, ['OH']);
  assert.deepEqual(Object.keys(result.referenceEvidence.jurisdictions), ['OH', 'AZ', 'NY']);
  assert.deepEqual(result.referenceEvidence.jurisdictions.AZ.rules.map(r => r.degree), ['MD', 'DO']);
  assert.ok(!JSON.stringify(result.referenceEvidence).includes('PRIVATE'));
  assert.ok(!JSON.stringify(result.referenceEvidence).includes('SECRET-NPI'));
  assert.equal(result.referenceEvidence.liveRetrieval, 'not_performed');
  assert.equal(savedReferenceContext(['ZZ'], 'MD').jurisdictions.ZZ, undefined);
});

test('actual snapshot, both provider payloads and existing action response use the evidence contract without tools', async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const sourceRequests = [];
  const context = vm.createContext({ console, URL, Date, AbortController, AbortSignal, TextEncoder, TextDecoder, setTimeout, clearTimeout,
    window: { Clerk: { session: { id: 'synthetic-session', getToken: async () => 'synthetic-token' } } },
    fetch: async (_url, options) => {
      const body = JSON.parse(options.body); sourceRequests.push(body);
      const source = VERA_SOURCES[body.sourceId];
      return new Response(JSON.stringify({ schemaVersion: 1, registryVersion: VERA_SOURCE_VERSION, sourceId: body.sourceId, url: source.url,
        verification: 'page_fetch_not_legal_determination', status: 'available', fetchedAt: new Date().toISOString(), contentSha256: 'a'.repeat(64),
        delivery: 'network', excerpts: [{ id: 'excerpt-1', start: 0, end: 19, text: 'Synthetic page text' }] }));
    },
  });
  const captured = [];
  const response = { reply: 'Synthetic response', actions: [{ kind: 'open_record', section: 'licenses', id: 'lic-1' }],
    sourceCitations: [{ sourceId: 'oh-cme-general', excerptId: 'excerpt-1', quote: 'Synthetic page text', claim: 'Synthetic response' }] };
  const api = {
    geminiCall: async (_path, body) => { captured.push(body); return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(response) }] } }] }) }; },
    proxyErrorMessage: () => null, anthropicAvailable: () => true,
    anthropicClientFor: async () => ({ messages: { create: async body => { captured.push(body); return { content: [{ type: 'text', text: JSON.stringify(response) }] }; } } }),
    anthropicErrorMessage: () => null, anthropicSdk: () => null, AI_MESSAGES: {},
  };
  const transport = new vm.SyntheticModule(Object.keys(api), function () { for (const [k, v] of Object.entries(api)) this.setExport(k, v); }, { context });
  const reports = new vm.SyntheticModule(['academicYearOf', 'caseWRVU'], function () { this.setExport('academicYearOf', () => '2026'); this.setExport('caseWRVU', () => 0); }, { context });
  const modules = new Map();
  async function load(filename) {
    if (filename.endsWith('/aiClient.js')) return transport;
    if (filename.endsWith('/caseLogReport.js')) return reports;
    if (!modules.has(filename)) modules.set(filename, new vm.SourceTextModule(await readFile(filename, 'utf8'), { context, identifier: filename,
      initializeImportMeta: meta => { meta.env = { VITE_VERA_SOURCE_RETRIEVAL_ENABLED: 'true', VITE_SUPABASE_URL: 'https://synthetic.example' }; } }));
    return modules.get(filename);
  }
  async function link(specifier, parent) {
    assert.ok(specifier.startsWith('.'));
    let filename = path.resolve(path.dirname(parent.identifier), specifier);
    if (!path.extname(filename)) filename += '.js';
    return load(filename);
  }
  const module = await load(path.join(root, 'src/utils/assistant.js'));
  await module.link(link); await module.evaluate();
  const a = module.namespace;
  const snapshot = a.buildSnapshot({ settings: { degreeType: 'MD' }, cme: [], licenses: [{ id: 'lic-1', type: 'Medical License', state: 'OH', expirationDate: '2024-09-30' }] }, ['OH', 'ZZ']);
  assert.equal(snapshot.cmeSummary.byState.OH.evidence.countingWindow.status, 'historical');
  assert.equal(snapshot.cmeSummary.byState.ZZ, undefined);
  assert.equal(snapshot.deaRenewal.fee, null);
  const blocks = a.systemBlocks(snapshot);
  assert.equal(blocks.length, 3);
  assert.match(blocks[0], /Calculations are not proof of legal compliance/);
  assert.match(blocks[0], /Zero general hours does not mean no mandated topics/);
  assert.match(blocks[0], /not a 20-hour shortfall or an exemption/);
  assert.ok(!blocks.join('\n').includes('$888'));
  assert.ok(!blocks[2].includes('generalSources'));
  for (const provider of ['gemini', 'opus']) {
    const result = await a.assistantTurn({ history: [{ role: 'user', text: 'What about New York and Ohio CME?' }], snapshot, settings: { assistantModel: provider } });
    assert.equal(result.actions[0].id, 'lic-1');
    const body = captured.at(-1), prompt = JSON.stringify(body);
    assert.match(prompt, /stored_rule_reference/);
    assert.match(prompt, /historicalRuleCoverage/);
    assert.match(prompt, /current_amount_not_verified/);
    assert.match(prompt, /NY/);
    assert.match(prompt, /Synthetic page text/);
    assert.equal(result.sourceEvidence.mode, 'official_page_excerpts');
    assert.equal(result.sourceEvidence.citations.length, 1);
    assert.ok(result.sourceEvidence.sources.every(s => !Object.hasOwn(s, 'excerpts')));
    assert.equal(body.tools, undefined);
  }
  assert.equal(sourceRequests.length, 4);
  for (const request of sourceRequests) assert.deepEqual(Object.keys(request), ['sourceId']);
});
