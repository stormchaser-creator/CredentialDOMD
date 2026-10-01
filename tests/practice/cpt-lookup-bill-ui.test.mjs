import test from 'node:test';
import assert from 'node:assert/strict';
import { loadScreens, mount, nodes, textOf, find, pinClock } from '../harness/component-harness.mjs';

// CPT Lookup's "+ Bill it" (PRAC-026). An AI-suggested code is billed at the
// catalog's work RVU, not 0; an encounter already stored at 0 is saved at the
// figure its editor shows; and a membership whose Practice is read-only is
// told why instead of being offered a button that can only be refused.
// Synthetic contract and text only.

pinClock(test, 'America/Chicago', '2026-09-20T12:00:00-05:00');
const { CPTLookup, RVULog } = await loadScreens([
  'export {default as CPTLookup} from "./src/components/features/CPTLookup.jsx";',
  'export {default as RVULog} from "./src/components/features/locum/RVULog.jsx";',
].join('\n'));

const settle = async () => { for (let i = 0; i < 30; i++) await new Promise(r => setImmediate(r)); };
const CONTRACT = { id: 'c1', facility: 'Synthetic General', coveragePeriods: [{ start: '2026-09-01', end: '2026-09-30' }], startDate: '2026-09-01', endDate: '2026-09-30' };

// The AI's answer, as Gemini returns it: a code, its words, never a wRVU.
const AI_CODES = [
  { code: '61343', description: 'Synthetic suboccipital decompression', confidence: 'high', reasoning: 'Synthetic: posterior fossa decompression' },
  { code: '00000', description: 'Synthetic code no catalog lists', confidence: 'low', reasoning: 'Synthetic: not a real code', wRVU: '99' },
];
const sent = [];
globalThis.fetch = async (url, init) => {
  sent.push(String(url));
  const body = { candidates: [{ content: { parts: [{ text: JSON.stringify({ codes: AI_CODES, notes: '' }) }] } }] };
  return { ok: true, status: 200, json: async () => body, headers: { get: () => null } };
};

const search = async (m, q) => {
  find(m.render(), n => n.type === 'input' && n.props['aria-label'] === 'Search CPT codes', 'search box').props.onChange({ target: { value: q } });
  await new Promise(r => setTimeout(r, 260)); // the search is debounced 200 ms
  await settle();
};
// "+ Bill it" is a small component: render it with its props to reach its handler.
const billButtons = (m) => nodes(m.render()).filter(n => typeof n.type === 'function' && n.props?.c?.code);
const bill = (el) => el.type(el.props).props.onClick({ stopPropagation() {} });

test('PRAC-026: "+ Bill it" on an AI-suggested 61343 logs it at the catalog 31.06 wRVU, not 0', async () => {
  const m = mount(CPTLookup, { data: { settings: { apiKey: 'synthetic-test-key' }, locumContracts: [CONTRACT] } });
  await search(m, 'synthetic chiari decompression');
  await find(m.render(), n => n.type === 'button' && /Ask AI to find CPT codes/.test(textOf(n)), 'AI button').props.onClick();
  await settle();
  assert.equal(sent.length, 1, 'one AI call');
  const aiRow = billButtons(m).find(n => n.props.c.code === '61343' && n.props.c.reasoning);
  assert.ok(aiRow, 'the AI row offers "+ Bill it"');
  assert.match(textOf(m.render()), /31\.06 wRVU/, 'the AI row shows the wRVU it will bill');
  bill(aiRow);
  const enc = m.calls.find(c => c[0] === 'add' && c[1] === 'encounters')?.[2];
  assert.deepEqual(enc.codes, [{ code: '61343', desc: 'Synthetic suboccipital decompression', units: 1, wRVU: 31.06 }]);
  assert.equal(enc.contractId, 'c1');
  // A code no catalog lists is never given a figure, not even one the AI made up.
  const unknown = billButtons(m).find(n => n.props.c.code === '00000');
  assert.equal(unknown.props.c.wRVU, undefined);
  assert.doesNotMatch(textOf(m.render()), /99\.00 wRVU/);
});

test('PRAC-026: Save changes on an encounter stored at 0 wRVU keeps the 31.06 its editor shows', () => {
  const ENC = { id: 'e1', contractId: 'c1', date: '2026-09-10', codes: [{ code: '61343', desc: 'Synthetic suboccipital decompression', units: 1, wRVU: 0 }], note: '', spokenText: '' };
  const m = mount(RVULog, { data: { locumContracts: [CONTRACT], encounters: [ENC], caseLogs: [] } });
  find(m.render(), n => n.type === 'div' && n.key === 'e1' && n.props.role === 'button', 'encounter row').props.onClick();
  assert.match(textOf(m.render()), /31\.06 wRVU/, 'the editor shows the catalog figure');
  find(m.render(), n => n.type === 'button' && textOf(n).includes('Save changes'), 'Save changes').props.onClick();
  const saved = m.calls.find(c => c[0] === 'edit' && c[1] === 'encounters')[2];
  assert.equal(saved.codes[0].wRVU, 31.06);
});

const CREDENTIAL_ONLY = { accessStatus: 'active', purchasedOfferId: 'core', practiceIncluded: false, lifetime: { credential: false, practice: false }, practiceTrial: { state: 'expired' } };
const asMember = (m, { access, practiceReadOnly }) => {
  Object.assign(globalThis.__screen.app, { limitedLaunch: { enabled: true, access }, practiceReadOnly });
  return m;
};

test('PRAC-026: a Credential-only member is told billing is part of Practice, with how to add it, and gets no "+ Bill it"', async () => {
  const m = asMember(mount(CPTLookup, { data: { locumContracts: [] } }), { access: CREDENTIAL_ONLY, practiceReadOnly: true });
  await search(m, '61343');
  const page = textOf(m.render());
  assert.match(page, /61343/, 'the code is still found');
  assert.equal(billButtons(m).length, 0, 'no button that can only be refused');
  assert.match(page, /Billing a code to your RVU log is part of Practice, and your Credential membership does not include it\. You can still search and copy codes here\./);
  const link = find(m.render(), n => n.type === 'a' && textOf(n) === 'Contact support about adding Practice', 'support link');
  assert.equal(link.props.href, 'mailto:support@credentialdomd.com');
  assert.doesNotMatch(page, /This record is read-only/);
  assert.doesNotMatch(page, /—/, 'no em dash');
  assert.equal(m.calls.length, 0, 'nothing written');
});

test('PRAC-026: a lapsed membership is told Practice is read-only; a member with Practice keeps "+ Bill it"', async () => {
  const lapsed = asMember(mount(CPTLookup, { data: { locumContracts: [] } }), { access: { ...CREDENTIAL_ONLY, accessStatus: 'revoked', purchasedOfferId: null }, practiceReadOnly: true });
  await search(lapsed, '61343');
  assert.equal(billButtons(lapsed).length, 0);
  assert.match(textOf(lapsed.render()), /Billing a code to your RVU log is part of Practice, which is read-only on this account\./);
  assert.equal(nodes(lapsed.render()).filter(n => n.type === 'a').length, 0, 'no offer to add Practice to a lapsed membership');

  const member = asMember(mount(CPTLookup, { data: { locumContracts: [CONTRACT] } }), { access: { ...CREDENTIAL_ONLY, practiceIncluded: true }, practiceReadOnly: false });
  await search(member, '61343');
  assert.doesNotMatch(textOf(member.render()), /part of Practice/);
  const hit = billButtons(member).find(n => n.props.c.code === '61343');
  bill(hit);
  assert.equal(member.calls.find(c => c[0] === 'add' && c[1] === 'encounters')[2].codes[0].wRVU, 31.06, 'a search result bills its wRVU, as before');
});

// A browser that refuses clipboard access (permission denied) rejects the
// write. It used to be an unhandled rejection (the QA lab logged it) under a
// "Copied to clipboard" that was not true.
test('CPT Lookup: a refused clipboard write says "Copy failed" on the row, never "Copied", and rejects nothing unhandled', async () => {
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  const had = Object.getOwnPropertyDescriptor(globalThis.navigator, 'clipboard');
  const writes = [];
  let refuse = true;
  Object.defineProperty(globalThis.navigator, 'clipboard', { configurable: true, value: {
    writeText: async (text) => { writes.push(text); if (refuse) { const e = new Error('Write permission denied.'); e.name = 'NotAllowedError'; throw e; } },
  } });
  try {
    const m = mount(CPTLookup, { data: { locumContracts: [] } });
    await search(m, '61343');
    const rowFor = () => find(m.render(), n => n.type === 'button' && n.key === '61343', 'the 61343 row');
    rowFor().props.onClick();
    await settle();
    assert.deepEqual(writes, ['61343'], 'the copy was tried');
    let page = textOf(m.render());
    assert.match(page, /Copy failed\. This browser did not allow copying; select the code to copy it\./);
    assert.doesNotMatch(page, /Copied to clipboard/);
    assert.doesNotMatch(page, /—/, 'no em dash');
    const alert = nodes(m.render()).find(n => n.props?.role === 'alert' && /Copy failed/.test(textOf(n)));
    assert.ok(alert, 'announced as an alert');

    // Allowed again: the next copy says so.
    refuse = false;
    rowFor().props.onClick(); // closes the row
    rowFor().props.onClick();
    await settle();
    page = textOf(m.render());
    assert.match(page, /Copied to clipboard/);
    assert.doesNotMatch(page, /Copy failed/);
    await new Promise(r => setTimeout(r, 20));
    assert.deepEqual(unhandled, [], 'no unhandled rejection');
  } finally {
    process.off('unhandledRejection', onUnhandled);
    if (had) Object.defineProperty(globalThis.navigator, 'clipboard', had); else delete globalThis.navigator.clipboard;
  }
});
