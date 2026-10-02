// Document request matching for a PA or an NP member (DESIGN 4.15, 1.9):
// their own documents answer their asks, "PA license" is the licence and
// not Pennsylvania, and an MD's or DO's request reads exactly as before.
// Both copies (the app's and the inbound function's) are checked alike.
// Synthetic records only.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as client from '../../src/utils/requestPacket.js';
import * as server from '../../supabase/functions/_shared/requestPacket.ts';

test('requests: for a PA "PA license" is the licence, not Pennsylvania; an MD\'s ask reads as before', () => {
  for (const m of [client, server]) {
    assert.deepEqual(m.classifyAsk('PA license', { degreeType: 'PA' }), { kind: 'state_license', state: null, all: false, focus: null, profession: 'PA' });
    assert.equal(m.classifyAsk('Pennsylvania PA license', { degreeType: 'PA' }).state, 'PA');
    assert.deepEqual(m.classifyAsk('PA license'), { kind: 'state_license', state: 'PA', all: false, focus: null });
    assert.equal(m.classifyAsk('NCCPA certificate', { degreeType: 'PA' }).kind, 'board_cert');
    assert.equal(m.classifyAsk('PANCE scores', { degreeType: 'PA' }).kind, 'usmle');
    assert.equal(m.classifyAsk('Copy of your supervision agreement', { degreeType: 'PA' }).kind, 'practice_agreement');
    assert.equal(m.classifyAsk('Copy of your supervision agreement').kind, 'unknown', 'an MD gets no new rule');
    assert.equal(m.classifyAsk('RN license', { degreeType: 'NP' }).kind, 'rn_license');
    assert.equal(m.classifyAsk('APRN license', { degreeType: 'NP' }).kind, 'aprn_license');
    assert.equal(m.classifyAsk('MSN diploma', { degreeType: 'NP' }).kind, 'diploma');
    assert.equal(m.classifyAsk('Prescriptive authority certificate', { degreeType: 'NP' }).kind, 'prescriptive_authority');
    assert.equal(m.classifyAsk('DEA', { degreeType: 'NP' }).kind, 'dea', 'physician rules still apply after the PA and NP ones');
    assert.equal(m.kindName('rn_license'), 'RN license');
  }
});

test('requests: a PA\'s and an NP\'s documents answer their asks, in both copies alike', () => {
  const records = {
    licenses: [
      { id: 'pa1', type: 'State Physician Assistant License', name: 'TX PA License', state: 'TX', expirationDate: '2027-05-31' },
      { id: 'rn1', type: 'RN License (Multistate)', name: 'TX RN', state: 'TX', expirationDate: '2027-05-31' },
      { id: 'ap1', type: 'APRN License (NP)', name: 'TX APRN', state: 'TX', expirationDate: '2027-05-31' },
      { id: 'ag1', type: 'Practice Agreement', name: 'TX agreement', state: 'TX', expirationDate: '2027-05-31' },
      { id: 'nc1', type: 'Board Certification (NCCPA)', name: 'PA-C', expirationDate: '2027-12-31' },
    ],
    education: [{ id: 'ed1', type: 'Master of Physician Assistant Studies (MPAS)', name: 'MPAS', institution: 'Example University' }],
  };
  const docs = [['d1', 'licenses:pa1'], ['d2', 'licenses:rn1'], ['d3', 'licenses:ap1'], ['d4', 'licenses:ag1'], ['d5', 'licenses:nc1'], ['d6', 'education:ed1']]
    .map(([id, linked_to]) => ({ id, name: `${id}.pdf`, mime_type: 'application/pdf', linked_to, uploaded_at: '2026-09-01T00:00:00Z' }));
  const now = '2026-10-01';
  for (const m of [client, server]) {
    const cat = m.catalogueFromRows(docs, records);
    const one = (ask, deg) => m.matchAsk(m.classifyAsk(ask, { degreeType: deg }), cat, now).map(e => String(e.id));
    assert.deepEqual(one('PA license', 'PA'), ['d1']);
    assert.deepEqual(one('Practice agreement', 'PA'), ['d4']);
    assert.deepEqual(one('NCCPA certificate', 'PA'), ['d5']);
    assert.deepEqual(one('PA program diploma', 'PA'), ['d6']);
    assert.deepEqual(one('RN license', 'NP'), ['d2']);
    assert.deepEqual(one('APRN license', 'NP'), ['d3']);
    const proposal = m.buildProposal({ body: 'Please send:\n- PA license\n- NCCPA certificate\n' }, cat, { name: 'Pat Example', degree_type: 'PA' }, now);
    assert.deepEqual(proposal.items.map(i => [i.kind, i.status]), [['state_license', 'found'], ['board_cert', 'found']]);
  }
  const mdCat = client.catalogueFromRows(docs, records);
  assert.deepEqual(client.matchAsk(client.classifyAsk('PA license'), mdCat, now), [], 'for an MD "PA license" is a Pennsylvania licence, and none is on file');
});

