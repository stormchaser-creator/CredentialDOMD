// Links into one record (Home search, Favorites, Vera, Home's lists) open
// that record. Driven through the real section components; synthetic
// records only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { mountComponent } from '../component-harness.mjs';
import { yearShowing } from '../../src/utils/caseLogReport.js';

const root = fileURLToPath(new URL('../..', import.meta.url));

const app = (data) => ({
  data: { settings: {}, documents: [], cme: [], screenings: [], licenses: [], ...data },
  theme: {}, allTrackedStates: [], isDesktop: false,
  addItem() {}, editItem() {}, deleteItem() {}, toggleFavorite() {}, navigate() {},
});
const constants = async () => ({
  credentialTypes: await import('../../src/constants/credentialTypes.js'),
  cmeTopics: await import('../../src/constants/cmeTopics.js'),
  states: await import('../../src/constants/states.js'),
  useForwardingAddresses: { useForwardingAddresses: () => ({ rows: [] }) },
  forwardingAddresses: { routableSenders: () => [], joinAddresses: () => '' },
});
const openModals = m => m.nodes().filter(n => n.type?.name === 'Modal' && n.props.open);

test('a CME search or Favorites link opens that entry, and clears itself once', async () => {
  const done = [];
  const cme = [{ id: 'cme-a', title: 'Synthetic Zebracourse', hours: 2, category: 'AMA PRA Category 1', date: '2026-01-10' }];
  const m = await mountComponent('src/components/features/CMESection.jsx', {
    app: app({ cme }),
    props: { onShare() {}, autoViewId: 'cme-a', onAutoViewDone: () => done.push('view') },
    modules: await constants(),
  });
  m.render();
  assert.deepEqual(done, ['view']);
  const form = openModals(m);
  assert.equal(form.length, 1, 'the entry form is open');
  assert.match(m.text(form[0]) + JSON.stringify(form[0].props.title ?? ''), /Edit|Zebracourse/);
});

test('a CME link to an entry that is gone is dropped, not kept to fire later', async () => {
  const done = [];
  const m = await mountComponent('src/components/features/CMESection.jsx', {
    app: app({ cme: [] }),
    props: { onShare() {}, autoViewId: 'cme-gone', onAutoViewDone: () => done.push('view') },
    modules: await constants(),
  });
  m.render();
  assert.deepEqual(done, ['view']);
  assert.equal(openModals(m).length, 0);
});

test('a Screenings link shows that record\'s details', async () => {
  const done = [];
  const screenings = [{ id: 'scr-a', name: 'Synthetic background check', expirationDate: '2027-01-01', components: [] }];
  const m = await mountComponent('src/components/features/ScreeningsSection.jsx', {
    app: app({ screenings }),
    props: { onShare() {}, autoViewId: 'scr-a', onAutoViewDone: () => done.push('view') },
    modules: await constants(),
  });
  m.render();
  assert.deepEqual(done, ['view']);
  const open = openModals(m);
  assert.equal(open.length, 1);
  assert.equal(open[0].props.title, 'Synthetic background check');
});

test('a Screenings edit link opens the form and reports the close for the trip back', async () => {
  const calls = [];
  const screenings = [{ id: 'scr-a', name: 'Synthetic background check', components: [] }];
  const m = await mountComponent('src/components/features/ScreeningsSection.jsx', {
    app: app({ screenings }),
    props: { onShare() {}, autoEditId: 'scr-a', onAutoEditDone: () => calls.push('done'), onAutoEditClosed: () => calls.push('closed') },
    modules: await constants(),
  });
  m.render();
  assert.deepEqual(calls, ['done']);
  const form = openModals(m);
  assert.equal(form.length, 1, 'the form is open');
  form[0].props.onClose();
  assert.deepEqual(calls, ['done', 'closed']);
});

test('App passes the link target to the CME and Screenings sections', () => {
  const src = readFileSync(`${root}src/App.jsx`, 'utf8');
  assert.match(src, /<CMESection onShare=\{openShare\} \{\.\.\.crudTarget\("cme"\)\} \/>/);
  assert.match(src, /<ScreeningsSection onShare=\{openShare\} \{\.\.\.crudTarget\("screenings"\)\} \/>/);
});

test('a case-log link lands on the academic year that lists the case', () => {
  const now = new Date(2026, 8, 29, 12);
  assert.equal(yearShowing({ date: '2026-06-15' }, '2026-27', now), '2025-26', 'last year\'s case moves the filter');
  assert.equal(yearShowing({ date: '2026-08-01' }, '2026-27', now), '2026-27', 'this year\'s case keeps it');
  assert.equal(yearShowing({ date: '' }, '2026-27', now), 'Undated');
  assert.equal(yearShowing({ date: '2021-03-01' }, 'all', now), 'all', 'Career lists everything');
  assert.equal(yearShowing({ date: '2026-06-15' }, 'last12', now), 'last12');
  assert.equal(yearShowing({ date: '2024-06-15' }, 'last12', now), '2023-24');
});

test('App moves the Case Logs year for a pending link, above the early returns', () => {
  const src = readFileSync(`${root}src/App.jsx`, 'utf8');
  const effect = src.indexOf('const y = yearShowing(rec, caseLogYear);');
  assert.ok(effect > 0, 'the effect exists');
  assert.ok(effect < src.indexOf('if (!authChecked'), 'and runs before any early return');
});
