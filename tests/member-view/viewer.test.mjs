// The read-only support viewer and the member's Settings card (ticket
// d45e857c, phase 2): the viewer is fed a snapshot, not the member's live
// context; every write path refuses; nothing lands in browser storage; the
// banner names the member and the time left; the member's log shows the view
// and each file opened.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { mountComponent, settle } from '../component-harness.mjs';
import * as memberViewer from '../../src/utils/memberViewer.js';
import * as memberViewClient from '../../src/utils/memberViewClient.js';
import * as memberView from '../../supabase/functions/_shared/memberView.mjs';
import * as adminViewBanner from '../../src/components/shared/adminViewBanner.js';
import * as helpers from '../../src/utils/helpers.js';

const { createReadOnlyView, READ_ONLY_ACTIONS, ReadOnlyViewError, recordCard, recordDetails, homeSummary, formatCountdown } = memberViewer;
const { createMemberViewClient, grantStatus, viewLogLine, memberViewAvailability, readActiveGrants, reasonCheck, MEMBER_VIEW_MESSAGES } = memberViewClient;
const root = fileURLToPath(new URL('../..', import.meta.url));
const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const day = offset => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);

const snapshot = () => memberView.shapeSnapshot({
  profile: { id: uuid(1), name: 'Dana Reyes', degree_type: 'MD', npi: '1234567890', primary_state: 'CO', email: 'dana@example.invalid', access_status: 'active' },
  collections: {
    licenses: [
      { id: uuid(10), type: 'Medical License', name: 'Colorado', license_number: 'DR.123', state: 'CO', expiration_date: day(20), notes: 'Renew online' },
      { id: uuid(11), type: 'DEA', state: 'CO', license_number: 'FR1234567', expiration_date: day(400), favorite: true },
      { id: uuid(12), type: 'Medical License', state: 'CA', expiration_date: day(-30), lifecycle_status: 'historical' },
    ],
    cme: [{ id: uuid(20), title: 'Opioid prescribing', category: 'Category 1', hours: 2.5, date: day(-10) }],
    customRecords: [{ id: uuid(30), category_id: uuid(31), category_name: 'Hospital ID Badges', name: 'Penrose badge', field_labels: { badgeNumber: 'Badge number' }, field_values: { badgeNumber: 'PX-1182' } }],
  },
  documents: [{ id: uuid(40), name: 'DEA certificate.pdf', mime_type: 'application/pdf', size_bytes: 20480, linked_to: `licenses:${uuid(11)}`, uploaded_at: '2026-09-01T12:00:00Z' }],
});
const opened = () => ({ session: { id: uuid(60), expiresInSeconds: 900, expiresAt: new Date(Date.now() + 900000).toISOString() }, member: { profileId: uuid(1), name: 'Dana Reyes', degreeType: 'MD' }, snapshot: snapshot() });

// ─── Every write path refuses ─────────────────────────────────────────────

test('every write-shaped action refuses, including every writer AppContext hands the member screens', async () => {
  const view = createReadOnlyView(snapshot());
  for (const action of READ_ONLY_ACTIONS) {
    assert.throws(() => view[action]('licenses', { id: uuid(10) }), error => error instanceof ReadOnlyViewError && error.code === 'read_only' && error.action === action, action);
  }
  // The context value the member's screens read their writers from.
  const context = await readFile(new URL('../../src/context/AppContext.jsx', import.meta.url), 'utf8');
  const value = context.slice(context.indexOf('const value = useMemo(() => ({'), context.indexOf('}), [', context.indexOf('const value = useMemo(() => ({')));
  const writers = [...value.matchAll(/\b(setData|updateSection|updateSettings|addItem|editItem|deleteItem|toggleFavorite|toggleTheme|checkout|manage)\b/g)].map(m => m[1]);
  assert.ok(writers.length >= 10);
  for (const writer of new Set(writers)) assert.ok(READ_ONLY_ACTIONS.includes(writer), `${writer} must refuse in the viewer`);
});

test('the snapshot is a frozen copy: nothing in the viewer can change it', () => {
  const source = snapshot();
  const view = createReadOnlyView(source);
  assert.notEqual(view.data, source);
  assert.ok(Object.isFrozen(view.data.sections.licenses[0]));
  assert.throws(() => { 'use strict'; view.data.sections.licenses[0].notes = 'edited'; }, TypeError);
  assert.throws(() => { view.data.sections.licenses.push({}); }, TypeError);
  assert.throws(() => { view.data.member.name = 'Someone else'; }, TypeError);
  assert.throws(() => { view.addItem = () => true; }, TypeError);
});

// ─── Isolation ────────────────────────────────────────────────────────────

test('the viewer is isolated: no AppContext, no sync, no storage, no AI, no share code in its bundle', async () => {
  const result = await build({ entryPoints: [`${root}src/components/features/MemberViewer.jsx`], bundle: true, write: false, metafile: true, format: 'esm', platform: 'browser',
    jsx: 'automatic', external: ['react', 'react/jsx-runtime'], define: { 'import.meta.env': '{}' }, logLevel: 'silent' });
  const inputs = Object.keys(result.metafile.inputs);
  for (const forbidden of ['context/AppContext', 'lib/supabase', 'utils/storage.js', 'utils/storageScope', 'utils/aiClient', 'utils/secretBox', 'utils/shareText', 'utils/assistant', 'utils/documentScanner', 'lib/admin']) {
    assert.ok(!inputs.some(input => input.includes(forbidden)), `${forbidden} is reachable from the viewer`);
  }
  const bundle = result.outputFiles[0].text;
  for (const api of ['localStorage', 'sessionStorage', 'indexedDB', 'caches.open']) assert.ok(!bundle.includes(api), `the viewer bundle mentions ${api}`);
  const source = await readFile(new URL('../../src/components/features/MemberViewer.jsx', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /useApp\(|context\/AppContext|lib\/supabase|saveData|syncItem|localStorage|sessionStorage/);
});

// ─── Rendered ─────────────────────────────────────────────────────────────

const require = createRequire(import.meta.url);
const bundled = await build({ entryPoints: [`${root}src/components/features/MemberViewer.jsx`], bundle: true, write: false, platform: 'node', format: 'cjs', jsx: 'automatic',
  external: ['react', 'react/jsx-runtime'], define: { 'import.meta.env': '{}' }, logLevel: 'silent' });
const viewerModule = { exports: {} };
new Function('require', 'module', 'exports', bundled.outputFiles[0].text)(require, viewerModule, viewerModule.exports);
const MemberViewer = viewerModule.exports.default;
const markup = props => renderToStaticMarkup(React.createElement(MemberViewer, { opened: opened(), client: {}, T: {}, ...props }));

test('the banner names the member, says read-only, and counts down the time left', () => {
  const html = markup();
  const banner = html.match(/<div role="status"[^>]*data-member-view-banner=""[^>]*>([\s\S]*?)<\/div>/)?.[1] || '';
  assert.match(banner, /Viewing Dana Reyes(&#x27;|')s account, read-only\./);
  assert.match(banner, /1[45]:\d\d left/);
  assert.match(banner, />Exit</);
  const style = html.match(/data-member-view-banner=""[^>]*style="([^"]*)"/)?.[1] || html.match(/style="([^"]*)"[^>]*data-member-view-banner=""/)?.[1];
  assert.match(style, /position:fixed/);
  assert.match(style, /background-color:#4c1d95/, 'the same banner as Preview as');
  assert.equal(formatCountdown(900000), '15:00');
  assert.equal(formatCountdown(61000), '1:01');
  assert.equal(formatCountdown(-5), '0:00');
});

test('the banner names the member even when the profile has no name', () => {
  const banner = html => html.match(/<div role="status"[^>]*data-member-view-banner=""[^>]*>([\s\S]*?)<\/div>/)?.[1] || '';
  const session = { id: uuid(60), expiresInSeconds: 900 };
  const nameless = memberView.shapeSnapshot({ profile: { id: uuid(1), name: '', email: 'dana@example.invalid' }, collections: {} });
  const withEmail = markup({ opened: { session, member: { profileId: uuid(1), name: '', degreeType: '' }, snapshot: nameless } });
  assert.match(banner(withEmail), /Viewing dana@example\.invalid(&#x27;|')s account, read-only\./);
  // No name and no email on the profile (3 of 11 live profiles on 2026-09-25):
  // the email the Accounts row showed, and failing that the account id.
  const bare = memberView.shapeSnapshot({ profile: { id: uuid(1) }, collections: {} });
  const fromRow = markup({ opened: { session, member: { profileId: uuid(1), name: '' }, snapshot: bare }, fallbackName: 'row@example.invalid' });
  assert.match(banner(fromRow), /Viewing row@example\.invalid(&#x27;|')s account/);
  const byId = markup({ opened: { session, member: { profileId: uuid(1), name: '' }, snapshot: bare } });
  assert.match(banner(byId), /Viewing member 00000000(&#x27;|')s account/);
  for (const html of [withEmail, fromRow, byId]) assert.doesNotMatch(banner(html), /Viewing (this member)?(&#x27;|')s/);
});

test('no add, edit, delete, star, send, share, upload, scan or AI control anywhere in the viewer', () => {
  const html = markup();
  const buttons = [...html.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)].map(m => m[1].replace(/<[^>]+>/g, '').trim());
  assert.ok(buttons.includes('Exit'));
  for (const label of buttons) assert.doesNotMatch(label, /^(Add|Edit|Delete|Remove|Save|Send|Share|Upload|Scan|Ask|Import|Export|Download|Star|Unstar|Reply|Email|Text)\b/i, label);
  assert.doesNotMatch(html, /<input|<textarea|<select|contenteditable|type="file"|aria-pressed/);
  assert.doesNotMatch(html, /—/, 'no em dash in the viewer copy');
});

test('records read the way the member\'s cards read them', () => {
  const s = snapshot();
  const expiring = recordCard('licenses', s.sections.licenses.find(l => l.id === uuid(10)), s);
  assert.equal(expiring.type, 'Medical License');
  assert.equal(expiring.color, 'orange');
  assert.match(expiring.subLine, /\d+d left/);
  const retired = recordCard('licenses', s.sections.licenses.find(l => l.id === uuid(12)), s);
  assert.equal(retired.inactive, true);
  assert.equal(retired.color, 'gray');
  assert.match(retired.subLine, /Historical/);
  assert.equal(recordCard('licenses', s.sections.licenses.find(l => l.id === uuid(11)), s).favorite, true);
  const details = recordDetails('licenses', s.sections.licenses.find(l => l.id === uuid(10)), s);
  assert.deepEqual(details.find(d => d.label === 'License #'), { label: 'License #', value: 'DR.123' });
  assert.deepEqual(details.find(d => d.label === 'Notes'), { label: 'Notes', value: 'Renew online' });
  assert.deepEqual(recordDetails('customRecords', s.sections.customRecords[0], s).find(d => d.label === 'Badge number'), { label: 'Badge number', value: 'PX-1182' });
  const home = homeSummary(s);
  assert.deepEqual(home.attention.map(a => a.id), [uuid(10)]);
  assert.equal(home.cmeHours, undefined, 'no all-time CME sum: the member\'s Home never shows one');
  assert.deepEqual(home.cmeStates.map(c => c.st), ['CO'], 'the one state the member tracks (the CA licence is historical)');
});

// ─── Home: the member's CME cards ─────────────────────────────────────────

test('Home shows each state\'s CME exactly as the member\'s Home computes it, not an all-time sum', async () => {
  const { complianceFor, trackedStates } = await import('../../src/utils/compliance.js');
  const { totalHoursLabel } = await import('../../src/utils/cmePresentation.js');
  // The member's records in the app's own shape...
  const licenses = [
    { id: uuid(10), type: 'Medical License', state: 'CA', licenseNumber: 'A12345', issuedDate: '2016-01-04', expirationDate: day(200) },
    { id: uuid(11), type: 'Medical License', state: 'CO', licenseNumber: 'DR.1', expirationDate: day(500) },
    { id: uuid(12), type: 'DEA', state: 'CA', licenseNumber: 'FR1234567', expirationDate: day(300) },
  ];
  const cme = [
    { id: uuid(20), title: 'Neurosurgery update', category: 'AMA PRA Category 1', hours: 38, date: day(-30) },
    { id: uuid(21), title: 'Five years ago', category: 'AMA PRA Category 1', hours: 174, date: day(-2000) },
    { id: uuid(22), title: 'Pain management', category: 'AMA PRA Category 1', hours: 2, date: day(-10), topics: ['Pain Management'] },
  ];
  const settings = { degreeType: 'MD', primaryState: 'CA', additionalStates: ['NY'] };
  const data = { licenses, cme, settings };
  // ...and the same records as the database hands them to the function.
  const snake = row => Object.fromEntries(Object.entries(row).map(([k, v]) => [memberView.camelToSnake(k), v]));
  const snap = memberView.shapeSnapshot({
    profile: { id: uuid(1), name: 'Dana Reyes', degree_type: 'MD', primary_state: 'CA', additional_states: ['NY'], reminder_lead_days: 90 },
    collections: { licenses: licenses.map(snake), cme: cme.map(snake) },
  });
  const cards = memberViewer.stateCmeCards(snap);
  const expected = trackedStates('CA', ['NY'], licenses).map(st => complianceFor(data, st)).sort((a, b) => (a.daysLeft ?? 9e9) - (b.daysLeft ?? 9e9));
  assert.deepEqual(cards.map(c => c.st), expected.map(c => c.state), 'the same states, soonest renewal first');
  for (const [i, card] of cards.entries()) {
    const want = expected[i];
    assert.equal(card.comp.totalEarned, want.totalEarned, card.st);
    assert.equal(card.comp.totalRequired, want.totalRequired, card.st);
    assert.equal(card.comp.cat1Earned, want.cat1Earned, card.st);
    assert.equal(card.comp.daysLeft, want.daysLeft, card.st);
    assert.equal(card.comp.assessmentStatus, want.assessmentStatus, card.st);
    assert.deepEqual(card.comp.topicResults.map(t => [t.topic, t.earned, t.met]), want.topicResults.map(t => [t.topic, t.earned, t.met]), card.st);
    assert.deepEqual(card.comp.mate, want.mate, card.st);
    assert.equal(card.hoursLine, want.noGeneralReq ? 'Topic-specific' : totalHoursLabel(want), card.st);
  }
  const ca = cards.find(c => c.st === 'CA');
  assert.equal(ca.primary, true);
  assert.equal(ca.comp.totalEarned, 40, 'the current cycle only: the 174 hours from five years ago do not count');
  assert.equal(cards.find(c => c.st === 'NY').renews, 'No NY license on file, tracking a rolling ' + cards.find(c => c.st === 'NY').comp.cycle + '-yr window');
  // Drawn on the viewer's Home, with the member's labels.
  const html = markup({ opened: { ...opened(), snapshot: snap } });
  const home = html.match(/data-member-view-cme=""[\s\S]*?On file/)?.[0] || '';
  for (const card of cards) {
    assert.match(home, new RegExp(`data-member-view-state="${card.st}"`));
    assert.ok(home.includes(card.hoursLine), `${card.st}: ${card.hoursLine}`);
  }
  assert.ok(html.includes(totalHoursLabel(complianceFor(data, 'CA'))));
  assert.doesNotMatch(html, /214|CME hours recorded/, 'no all-time total anywhere');
  assert.doesNotMatch(html, /—/);
});

// ─── Identifiers the app's own gate withholds ─────────────────────────────

test('the support view withholds what the app\'s identifier gate flags: in keys, in labelled values and in free text', async () => {
  const { identifierReason } = await import('../../src/utils/customCategories.js');
  // A case log written before the gate existed (the August 2026 import is how
  // 1,380 MRNs reached case logs), or brought back by a JSON restore.
  const customFields = { 'Pt Name': 'Jane Q', 'Medical Record #': '00481234', 'Chart #': '771', 'Acct #': '99812', 'Encounter #': 'E55',
    'Tax ID': '12-3456789', "Driver's License": 'D1234567', Note: 'MRN 00481234', Approach: 'Retrosigmoid' };
  for (const [label, value] of Object.entries(customFields)) {
    assert.equal(!!identifierReason(label, value), label !== 'Approach', `the app's gate on ${label}`);
  }
  const snap = memberView.shapeSnapshot({
    profile: { id: uuid(1), name: 'Dana Reyes' },
    collections: {
      caseLogs: [{ id: uuid(50), category: 'Cranial', title: 'Craniotomy MRN 00481234', date: day(-5),
        notes: 'Uneventful\nMRN 00481234\nPt Name: Jane Q\nTax ID: 12-3456789', custom_fields: customFields }],
      // A custom record keyed f1..f4: the label, not the key, says what it is.
      customRecords: [{ id: uuid(51), category_id: uuid(52), category_name: 'Hospital forms', name: 'Intake form',
        field_labels: { f1: 'Medical Record #', f2: 'Acct #', f3: 'Badge number', f4: 'Tax ID', f5: 'Pt Name' },
        field_values: { f1: '00481234', f2: '99812', f3: 'PX-1182', f4: '12-3456789', f5: 'Jane Q' } }],
    },
  });
  const text = JSON.stringify(snap);
  for (const leaked of ['Jane Q', '00481234', '"771"', '99812', 'E55', '12-3456789', 'D1234567']) assert.ok(!text.includes(leaked), `${leaked} reached the snapshot`);
  const log = snap.sections.caseLogs[0];
  assert.deepEqual(log.customFields, { Approach: 'Retrosigmoid' });
  assert.equal(log.notes, 'Uneventful\n[Withheld: a medical record number]\n[Withheld: a patient identifier]\n[Withheld: a Social Security number]');
  assert.equal(log.title, '[Withheld: a medical record number]');
  const record = snap.sections.customRecords[0];
  assert.deepEqual(record.fieldValues, { f3: 'PX-1182' });
  assert.deepEqual(recordDetails('customRecords', record, snap).filter(d => d.label === 'Badge number'), [{ label: 'Badge number', value: 'PX-1182' }]);
  const shown = recordDetails('caseLogs', log, snap).map(d => `${d.label}: ${d.value}`).join('\n');
  for (const leaked of ['Jane Q', '00481234', '99812', '12-3456789']) assert.ok(!shown.includes(leaked), leaked);
  // Phrases, not bare words: a real reappointment item survives.
  const kept = memberView.shapeSnapshot({ collections: { privileges: [{ id: uuid(53), facility: 'Mercy', notes: 'Patient Safety Committee: attended',
    custom_fields: { Committee: 'Patient Safety Committee', 'Badge #': 'PX-1182' } }] } });
  assert.equal(kept.sections.privileges[0].notes, 'Patient Safety Committee: attended');
  assert.deepEqual(kept.sections.privileges[0].customFields, { Committee: 'Patient Safety Committee', 'Badge #': 'PX-1182' });
  // The support view's gate is the app's gate, not a copy of its rules.
  const shared = await readFile(new URL('../../supabase/functions/_shared/memberView.mjs', import.meta.url), 'utf8');
  assert.match(shared, /import \{ identifierReason \} from '\.\/app\/utils\/identifierGate\.js';/);
});

// ─── Driven: open a file, heartbeat refusal, exit ─────────────────────────

async function mountViewer({ client, onClose = () => {}, clock = { offset: 0 } }) {
  const intervals = [];
  // The viewer's own clock, so a test can move time forward inside it.
  class ViewerDate extends Date { static now() { return Date.now() + clock.offset; } }
  const storageWrites = [];
  const storage = { getItem: () => null, setItem: (...args) => storageWrites.push(args), removeItem: (...args) => storageWrites.push(args) };
  const created = [];
  const mounted = await mountComponent('src/components/features/MemberViewer.jsx', {
    modules: { memberView, memberViewer, memberViewClient, adminViewBanner, helpers },
    props: { opened: opened(), client, T: {}, onClose },
    globals: {
      setInterval: fn => { intervals.push(fn); return intervals.length; }, clearInterval() {},
      localStorage: storage, sessionStorage: storage, structuredClone, Date: ViewerDate,
      URL: Object.assign(function (...args) { return new URL(...args); }, { createObjectURL: blob => { created.push(blob); return `blob:viewer/${created.length}`; }, revokeObjectURL() {} }),
    },
  });
  mounted.render(); // runs the mount effects: the countdown and the heartbeat
  return { ...mounted, intervals, storageWrites, created };
}
const plain = node => { const c = node?.props?.children; return (Array.isArray(c) ? c : [c]).flat(Infinity).map(v => typeof v === 'string' || typeof v === 'number' ? String(v) : v && typeof v === 'object' ? plain(v) : '').join(''); };
const buttonNamed = (nodes, name) => nodes.find(n => n.type === 'button' && plain(n).includes(name));

test('opening a file goes through the function, one at a time, and shows it view-only; nothing is stored', async () => {
  const calls = [];
  const client = {
    openFile: async (session, doc) => { calls.push(['openFile', session, doc]); return { buffer: new TextEncoder().encode('%PDF-1.7').buffer, mimeType: 'application/pdf' }; },
    check: async () => ({ state: 'active', session: { expiresInSeconds: 800 } }), end: async id => calls.push(['end', id]),
  };
  const v = await mountViewer({ client });
  buttonNamed(v.nodes(), 'Credentials').props.onClick();
  buttonNamed(v.nodes(), 'Licenses').props.onClick();
  // The DEA card carries the file.
  const card = v.nodes().filter(n => n.type === 'button' && n.props['aria-expanded'] !== undefined).find(n => plain(n).includes('FR1234567'));
  card.props.onClick();
  const open = v.nodes().find(n => n.type === 'button' && n.props['data-member-view-open-file'] === uuid(40));
  assert.ok(open, 'the file has an Open file control');
  open.props.onClick();
  await settle();
  assert.deepEqual(calls, [['openFile', uuid(60), uuid(40)]]);
  const frame = v.nodes().find(n => n.type === 'iframe');
  assert.equal(frame.props.src, 'blob:viewer/1#toolbar=0');
  assert.match(v.pageText(), /This open is in the member's log/);
  assert.deepEqual(v.storageWrites, [], 'nothing written to browser storage');
  buttonNamed(v.nodes(), 'Close file').props.onClick();
  assert.equal(v.nodes().find(n => n.type === 'iframe'), undefined);
});

test('walking every tab, section and record: the only controls are navigation, Open file and Exit', async () => {
  const v = await mountViewer({ client: { check: async () => ({}), end: async () => {},
    openFile: async () => ({ buffer: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]).buffer, mimeType: 'image/png' }) } });
  const seen = new Set();
  const controls = () => v.nodes().filter(n => ['button', 'input', 'textarea', 'select', 'form', 'a'].includes(n.type));
  const allowed = label => /^(Home|Credentials|Documents|Work|Activity|Profile|Back|Open file|Opening\.\.\.|Close file|Exit)$/.test(label);
  const look = () => {
    for (const n of controls()) {
      assert.equal(n.type, 'button', `only buttons, found ${n.type}`);
      const label = plain(n).trim();
      if (n.props['aria-expanded'] !== undefined || /\d+$/.test(label)) { seen.add('record or section'); continue; }
      assert.ok(allowed(label), `unexpected control: ${label}`);
      seen.add(label);
    }
  };
  for (const tab of ['Home', 'Credentials', 'Documents', 'Work', 'Activity', 'Profile']) {
    buttonNamed(v.nodes(), tab).props.onClick(); look();
    const sections = v.nodes().filter(n => n.type === 'button' && /\d+$/.test(plain(n).trim()) && n.props['aria-expanded'] === undefined);
    for (const index of sections.keys()) {
      v.nodes().filter(n => n.type === 'button' && /\d+$/.test(plain(n).trim()) && n.props['aria-expanded'] === undefined)[index].props.onClick(); look();
      for (const idx of v.nodes().filter(n => n.props?.['aria-expanded'] !== undefined).keys()) {
        v.nodes().filter(n => n.props?.['aria-expanded'] !== undefined)[idx].props.onClick(); look();
      }
      buttonNamed(v.nodes(), 'Back').props.onClick();
    }
  }
  buttonNamed(v.nodes(), 'Documents').props.onClick();
  v.nodes().find(n => n.props?.['data-member-view-open-file']).props.onClick();
  await settle(); look();
  for (const label of ['Home', 'Credentials', 'Back', 'Open file', 'Close file', 'Exit']) assert.ok(seen.has(label), `walked past ${label}`);
  assert.deepEqual(v.storageWrites, []);
});

test('the member ending access mid-visit closes the viewer at the next check', async () => {
  const calls = [];
  const client = {
    check: async () => { throw memberViewClient.memberViewFailure('grant_ended'); },
    openFile: async () => { throw new Error('must not be called'); }, end: async id => calls.push(['end', id]),
  };
  let closedWith = null;
  const v = await mountViewer({ client, onClose: note => { closedWith = note; } });
  // Intervals: [0] the countdown, [1] the heartbeat.
  await v.intervals[1]();
  await settle();
  assert.equal(closedWith, MEMBER_VIEW_MESSAGES.grant_ended);
  assert.deepEqual(calls, [['end', uuid(60)]]);
});

test('a refused file closes the viewer when access is over, and otherwise just says why', async () => {
  let closedWith = null;
  let refusal = 'not_viewable';
  const client = { check: async () => ({ state: 'active', session: { expiresInSeconds: 800 } }), end: async () => {},
    openFile: async () => { throw memberViewClient.memberViewFailure(refusal); } };
  const v = await mountViewer({ client, onClose: note => { closedWith = note; } });
  buttonNamed(v.nodes(), 'Documents').props.onClick();
  v.nodes().find(n => n.props?.['data-member-view-open-file'] === uuid(40)).props.onClick();
  await settle();
  assert.match(v.pageText(), /cannot be shown in the read-only view/);
  assert.equal(closedWith, null);
  refusal = 'grant_expired';
  v.nodes().find(n => n.props?.['data-member-view-open-file'] === uuid(40)).props.onClick();
  await settle();
  assert.equal(closedWith, MEMBER_VIEW_MESSAGES.grant_expired);
});

test('the viewer fails closed: the kill switch closes it at once, and two failed checks in a row close it', async () => {
  // The operator unsets MEMBER_SUPPORT_VIEW_ENABLED: the next check says so.
  let closedWith = null;
  const off = await mountViewer({ client: { check: async () => { throw memberViewClient.memberViewFailure('support_view_disabled'); }, openFile: async () => ({}), end: async () => {} },
    onClose: note => { closedWith = note; } });
  await off.intervals[1](); await settle();
  assert.equal(closedWith, MEMBER_VIEW_MESSAGES.support_view_disabled);
  assert.ok(memberViewClient.MEMBER_VIEW_CLOSING.has('origin_not_allowed'));
  // The check cannot get through (network drop, request blocked).
  closedWith = null;
  let answer = 'fail';
  const client = { check: async () => { if (answer === 'fail') throw memberViewClient.memberViewFailure(); return { state: 'active', session: { expiresInSeconds: 600 } }; },
    openFile: async () => ({}), end: async () => {} };
  const v = await mountViewer({ client, onClose: note => { closedWith = note; } });
  await v.intervals[1](); await settle();
  assert.equal(closedWith, null, 'one failed check is not enough to close');
  answer = 'ok'; await v.intervals[1](); await settle();
  answer = 'fail'; await v.intervals[1](); await settle();
  assert.equal(closedWith, null, 'a confirmed check in between starts the count again');
  await v.intervals[1](); await settle();
  assert.equal(closedWith, MEMBER_VIEW_MESSAGES.access_unconfirmed, 'two in a row close the view');
  assert.doesNotMatch(MEMBER_VIEW_MESSAGES.access_unconfirmed, /—/);
});

test('Exit ends the visit on the server and hands control back', async () => {
  const calls = [];
  let closedWith = null;
  const v = await mountViewer({ client: { check: async () => ({}), openFile: async () => ({}), end: async id => calls.push(id) }, onClose: note => { closedWith = note; } });
  buttonNamed(v.nodes(), 'Exit').props.onClick();
  assert.deepEqual(calls, [uuid(60)]);
  assert.equal(closedWith, '');
});

test('the 15 minutes running out closes the viewer without a server answer', async () => {
  let closedWith = null;
  const clock = { offset: 0 };
  const v = await mountViewer({ client: { check: async () => ({}), openFile: async () => ({}), end: async () => {} }, onClose: note => { closedWith = note; }, clock });
  clock.offset = 14 * 60000;
  v.intervals[0]();
  assert.equal(closedWith, null, 'still open at 14 minutes');
  assert.match(v.pageText(), /[01]:\d\d left/);
  clock.offset = 15 * 60000 + 1000;
  v.intervals[0]();
  assert.equal(closedWith, MEMBER_VIEW_MESSAGES.session_expired);
});

// ─── The transport ────────────────────────────────────────────────────────

function transport(responses) {
  const sent = [];
  const session = { user: { id: 'user_Admin' }, getToken: async () => 'token' };
  const client = createMemberViewClient({ accountId: 'user_Admin', url: 'https://project.test', anonKey: 'anon', getSession: () => session,
    uuid: () => '30000000-0000-4000-8000-000000000001',
    fetchImpl: async (url, init) => { sent.push({ url, body: JSON.parse(init.body), auth: init.headers.Authorization }); return responses.shift(); } });
  return { client, sent };
}
const jsonResponse = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('the admin transport: start carries a request id and the reason; refusals that end the view say so', async () => {
  const t = transport([
    jsonResponse(200, { session: { id: uuid(60), expiresInSeconds: 900 }, member: { name: 'Dana Reyes' }, snapshot: snapshot() }),
    jsonResponse(409, { error: 'grant_ended' }),
    new Response(new Uint8Array([37, 80, 68, 70]), { status: 200, headers: { 'content-type': 'application/pdf' } }),
    jsonResponse(403, { error: 'no_active_grant' }),
  ]);
  const started = await t.client.start({ profileId: uuid(1), reason: `  ${'Ticket 4411: CME hours'}  ` });
  assert.equal(started.session.id, uuid(60));
  assert.deepEqual(t.sent[0].body, { action: 'start', profileId: uuid(1), reason: 'Ticket 4411: CME hours', requestId: '30000000-0000-4000-8000-000000000001' });
  assert.equal(t.sent[0].url, 'https://project.test/functions/v1/admin-member-view');
  assert.equal(t.sent[0].auth, 'Bearer token');
  await assert.rejects(t.client.check(uuid(60)), error => error.code === 'grant_ended' && error.closes === true);
  const file = await t.client.openFile(uuid(60), uuid(40));
  assert.equal(file.mimeType, 'application/pdf');
  assert.equal(file.buffer.byteLength, 4);
  await assert.rejects(t.client.start({ profileId: uuid(1), reason: 'Ticket 4411: CME hours' }), error => error.code === 'no_active_grant' && /has not allowed support access/.test(error.message));
  await assert.rejects(t.client.start({ profileId: uuid(1), reason: 'short' }), error => error.code === 'invalid_reason');
  for (const message of Object.values(MEMBER_VIEW_MESSAGES)) assert.doesNotMatch(message, /—/);
});

test('the reason is counted and sent the way the server stores it', async () => {
  for (const raw of ['CME\n\nissue', 'CME  issue', ' CME\tissue ']) {
    assert.equal(memberView.normalizeReason(raw), null, `the server refuses ${JSON.stringify(raw)}`);
    assert.deepEqual(reasonCheck(raw), { text: 'CME issue', length: 9, ok: false }, 'so the screen does not offer it');
  }
  for (const raw of ['Ticket 4411: CME hours', 'Ticket 4411:\n\nCME   hours', 'x'.repeat(500), `${'x'.repeat(499)}\n\ny`, '', 'CME issue.']) {
    assert.equal(reasonCheck(raw).ok, memberView.normalizeReason(raw) !== null, `screen and server agree on ${JSON.stringify(raw).slice(0, 40)}`);
  }
  const t = transport([jsonResponse(200, { session: { id: uuid(60), expiresInSeconds: 900 }, member: { name: 'Dana Reyes' }, snapshot: snapshot() })]);
  await assert.rejects(t.client.start({ profileId: uuid(1), reason: 'CME\n\nissue' }), error => error.code === 'invalid_reason');
  assert.equal(t.sent.length, 0, 'refused before any request');
  await t.client.start({ profileId: uuid(1), reason: 'Ticket 4411:\n\nCME   hours' });
  assert.equal(t.sent[0].body.reason, 'Ticket 4411: CME hours');
});

// ─── Admin > Accounts ─────────────────────────────────────────────────────

test('View as member is enabled only while that member has an active grant', async () => {
  const grants = new Map([[uuid(1), { grantId: uuid(70), expiresAt: new Date(Date.now() + 3600000).toISOString() }]]);
  assert.deepEqual(memberViewAvailability(grants, { id: uuid(2) }, uuid(99)).enabled, false);
  assert.match(memberViewAvailability(grants, { id: uuid(2) }, uuid(99)).note, /not allowed by the member/);
  const on = memberViewAvailability(grants, { id: uuid(1) }, uuid(99));
  assert.equal(on.enabled, true);
  assert.match(on.note, /allowed until/);
  assert.equal(memberViewAvailability(grants, { id: uuid(99) }, uuid(99)).show, false, 'never on your own row');
  assert.equal(memberViewAvailability(grants, { id: uuid(1), deleted_at: '2026-09-01' }, uuid(99)).show, false);
  // A refused or missing grants read (not an admin, migration not applied) enables nothing.
  const refused = await readActiveGrants({ rpc: async () => ({ data: null, error: { code: '42501' } }) });
  assert.equal(refused.grants.size, 0);
  assert.equal(refused.error, 'unavailable');
  // When the list did not load, no row is said to lack a grant: a member who
  // did allow access is not shown to the admin as one who did not.
  for (const user of [{ id: uuid(1) }, { id: uuid(2) }]) {
    const unchecked = memberViewAvailability(refused.grants, user, uuid(99), refused.error);
    assert.equal(unchecked.show, true);
    assert.equal(unchecked.enabled, false);
    assert.equal(unchecked.note, 'Could not check support access. Refresh to try again.');
  }
  assert.equal(memberViewAvailability(refused.grants, { id: uuid(99) }, uuid(99), refused.error).show, false, 'still never on your own row');
  const dashboard = await readFile(new URL('../../src/components/pages/AdminDashboard.jsx', import.meta.url), 'utf8');
  assert.equal([...dashboard.matchAll(/memberViewAvailability\(memberGrants, u, myProfileId, grantsError\)/g)].length, 2, 'the button and the note both hear about a failed load');
  assert.match(dashboard, /disabled=\{!view\.enabled\}/);
  assert.match(dashboard, /<AdminMemberView target=\{memberViewTarget\} grant=\{memberGrants\.get\(memberViewTarget\.id\) \|\| null\}/);
});

// ─── Settings > Support access ───────────────────────────────────────────

function memberClient({ grant = null, events = [] } = {}) {
  const calls = [];
  const state = { grant, events };
  const now = () => new Date().toISOString();
  return {
    calls, state,
    rpc: async name => {
      calls.push(name);
      if (name === 'member_view_grant_open') state.grant = { id: uuid(80), created_at: now(), expires_at: new Date(Date.now() + 24 * 3600000).toISOString(), ended_at: null, ended_by: null, state: 'active' };
      if (name === 'member_view_grant_end' && state.grant) state.grant = { ...state.grant, ended_at: now(), ended_by: 'member', state: 'ended' };
      return { data: { now: now(), grant: state.grant, ...(name === 'member_view_status' ? { events: state.events } : {}) }, error: null };
    },
    from: table => { throw new Error(`the card reads through member_view_status only, not ${table}`); },
  };
}

async function mountCard(client) {
  const card = await mountComponent('src/components/pages/SupportAccessCard.jsx', {
    modules: { memberViewClient },
    props: { theme: { text: '#111', textMuted: '#555', border: '#ccc', card: '#fff', accent: '#080', accentDim: '#efe', danger: '#c00' }, client },
    globals: { setInterval: () => 1, clearInterval() {} },
  });
  card.render(); await settle(); card.render();
  return card;
}

test('the member allows support access for 24 hours and can end it at any time', async () => {
  const client = memberClient();
  const card = await mountCard(client);
  assert.match(card.pageText(), /Support access is off\./);
  assert.match(card.pageText(), /never shown/);
  // Scoped to the in-app view: the service administrator's database access
  // (Privacy Policy section 7) is not something this card can promise away.
  assert.doesNotMatch(card.pageText(), /cannot open your account unless|the way you see it/);
  assert.match(card.pageText(), /Support can open a read-only view of your account in the app only if you allow it here\./);
  assert.match(card.pageText(), /database access for running the service is described in the Privacy Policy/);
  assert.doesNotMatch(card.pageText(), /HIPAA|—/);
  const allow = buttonNamed(card.nodes(), 'Allow CredentialDOMD support to view my account for 24 hours');
  allow.props.onClick(); await settle();
  assert.ok(client.calls.includes('member_view_grant_open'));
  assert.match(card.pageText(), /Support can view your account until .*\((23 h 59|24 h 0) min left\)/);
  buttonNamed(card.nodes(), 'End support access now').props.onClick(); await settle();
  assert.ok(client.calls.includes('member_view_grant_end'));
  assert.match(card.pageText(), /Support access is off\. You ended it on/);
});

test('the member\'s log shows the view and each file opened: who, when, what and why', async () => {
  const events = [
    { id: uuid(91), created_at: '2026-09-25T15:04:00Z', event: 'file_opened', actor_name: 'Eric Whitney', reason: 'Ticket 4411: CME hours on Home look wrong', document_name: 'DEA certificate.pdf' },
    { id: uuid(90), created_at: '2026-09-25T15:02:00Z', event: 'view_started', actor_name: 'Eric Whitney', reason: 'Ticket 4411: CME hours on Home look wrong', document_name: null },
  ];
  const card = await mountCard(memberClient({ events }));
  const text = card.pageText();
  assert.match(text, /Eric Whitney \(CredentialDOMD support\) opened the file "DEA certificate\.pdf"\./);
  assert.match(text, /Eric Whitney \(CredentialDOMD support\) opened your account, read-only\./);
  assert.equal(text.match(/Reason: Ticket 4411: CME hours on Home look wrong/g).length, 2);
  assert.match(text, /Sep 25, 2026/);
  assert.deepEqual(viewLogLine(events[0]).text, 'Eric Whitney (CredentialDOMD support) opened the file "DEA certificate.pdf".');
  const empty = await mountCard(memberClient());
  assert.match(empty.pageText(), /No one from support has viewed your account\./);
});

test('grant time left is measured on the server clock', () => {
  const grant = { expires_at: '2026-09-26T12:00:00.000Z', state: 'active' };
  // Server says it is 11:00; the device thinks it is 11:30. One hour is left.
  const deviceNow = Date.parse('2026-09-26T11:30:00.000Z');
  assert.equal(grantStatus(grant, '2026-09-26T11:00:00.000Z', deviceNow, deviceNow).remainingMs, 3600000);
  assert.equal(grantStatus({ ...grant, state: 'ended', ended_by: 'member' }, '2026-09-26T11:00:00.000Z', deviceNow).state, 'ended');
  assert.equal(grantStatus(null).state, 'none');
});

test('Settings shows the card; the privacy policy describes the access plainly, with no compliance claim', async () => {
  const settings = await readFile(new URL('../../src/components/pages/SettingsSection.jsx', import.meta.url), 'utf8');
  assert.match(settings, /<SupportAccessCard theme=\{T\} \/>/);
  const { PRIVACY } = await import('../../src/content/legalText.js');
  const text = JSON.stringify(PRIVACY);
  assert.match(text, /A read-only support view, only if you allow it/);
  assert.match(text, /allow support to view your account for 24 hours, and end that at any time/);
  assert.match(text, /read-only view of your account in the app/);
  assert.match(text, /This view is separate from the administrative access to the database and storage described above/);
  assert.ok(text.indexOf('has administrative access to the database and storage') < text.indexOf('A read-only support view'), 'the database access is disclosed first');
  assert.doesNotMatch(text, /as you see it/, 'the view is not a copy of every screen');
  assert.match(text, /15 minutes at a time and only after entering a reason/);
  assert.match(text, /Each view and each file opened is logged with the reason, and you can read that log in Settings/);
  assert.doesNotMatch(text, /HIPAA[ -]compliant|compliant with HIPAA|—/);
  for (const page of ['landing/privacy.html', 'public/privacy.html']) {
    assert.match(await readFile(new URL(`../../${page}`, import.meta.url), 'utf8'), /A read-only support view, only if you allow it/);
  }
});

// ─── Admin > Accounts > View as member ────────────────────────────────────

test('View as member needs a typed reason, then opens the isolated viewer with the snapshot', async () => {
  const starts = [];
  const fakeClient = { start: async input => { starts.push(input); return opened(); }, end: async () => {}, check: async () => ({}), openFile: async () => ({}) };
  const target = { id: uuid(1), name: 'Dana Reyes', email: 'dana@example.invalid' };
  const grant = { grantId: uuid(70), expiresAt: new Date(Date.now() + 3600000).toISOString() };
  let closed = 0;
  const mounted = await mountComponent('src/components/pages/AdminMemberView.jsx', {
    modules: { memberViewClient: { ...memberViewClient, createMemberViewClient: () => fakeClient } },
    app: { user: { id: 'user_Admin' }, theme: { text: '#111', textMuted: '#555', border: '#ccc', input: '#eee', accent: '#080', textDim: '#999' }, isDesktop: true },
    props: { target, grant, onClose: () => { closed++; } },
  });
  const open = () => buttonNamed(mounted.nodes(), 'Open read-only view');
  assert.equal(open().props.disabled, true, 'no reason yet');
  assert.match(mounted.pageText(), /allowed support access until/);
  assert.match(mounted.pageText(), /Your reason is shown to the member in their log/);
  mounted.nodes().find(n => n.type === 'textarea').props.onChange({ target: { value: 'short' } });
  assert.equal(open().props.disabled, true, 'under 10 characters');
  // Ten characters as typed, nine as stored: the server would refuse it.
  mounted.nodes().find(n => n.type === 'textarea').props.onChange({ target: { value: 'CME\n\nissue' } });
  assert.equal(open().props.disabled, true, 'counted after newlines and spaces collapse');
  assert.match(mounted.pageText(), /9 of 500 characters, at least 10\./);
  mounted.nodes().find(n => n.type === 'textarea').props.onChange({ target: { value: 'Ticket 4411: CME hours on Home look wrong' } });
  assert.equal(open().props.disabled, false);
  open().props.onClick();
  await settle();
  // Built inside the component's own realm: compare as plain data.
  assert.deepEqual(JSON.parse(JSON.stringify(starts)), [{ profileId: uuid(1), reason: 'Ticket 4411: CME hours on Home look wrong' }]);
  const tree = mounted.render();
  assert.equal(tree.type.name, 'MemberViewer', 'the viewer replaces the dialog');
  assert.equal(tree.props.opened.session.id, uuid(60));
  assert.equal(tree.props.client, fakeClient);
  assert.equal(tree.props.fallbackName, 'dana@example.invalid', 'the banner can fall back to the email the Accounts row showed');
  tree.props.onClose(MEMBER_VIEW_MESSAGES.grant_ended);
  assert.match(mounted.pageText(), /The member ended support access, so the view is closed\./);
  assert.equal(closed, 0);

  // Without a grant the button stays off whatever the reason.
  const none = await mountComponent('src/components/pages/AdminMemberView.jsx', {
    modules: { memberViewClient: { ...memberViewClient, createMemberViewClient: () => fakeClient } },
    app: { user: { id: 'user_Admin' }, theme: {}, isDesktop: false }, props: { target, grant: null, onClose() {} },
  });
  none.nodes().find(n => n.type === 'textarea').props.onChange({ target: { value: 'Ticket 4411: CME hours on Home look wrong' } });
  assert.equal(buttonNamed(none.nodes(), 'Open read-only view').props.disabled, true);
  assert.match(none.pageText(), /has to allow support access in their Settings first/);
});
