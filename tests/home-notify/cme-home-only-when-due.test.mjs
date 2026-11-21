// Eric, 2026-11-20: "Cme status should not be on the homepage unless it is
// showing it needs to be due. The cme progress section should be moved as a
// link under credentials."
//
// Home used to render a CME Progress heading and every state's progress card
// whatever the standing. Now Home shows one compact card only while the ring
// lists a CME row (standingScore: a shortfall inside the member's reminder
// lead window, or overdue), and the cards live on Credentials > CME progress.
// The rule is the ring's own (cmeDueRows), not the cards' colour thresholds.
// Synthetic records only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { trackedStates, alertingStates, complianceFor, findStateLicense, standingScore, cmeDueRows } from '../../src/utils/compliance.js';
import { reminderLeadDays } from '../../src/utils/reminderPreferences.js';

const root = fileURLToPath(new URL('../..', import.meta.url));
const app = readFileSync(`${root}src/App.jsx`, 'utf8');
const day = (n) => { const d = new Date(Date.now() + n * 86400000); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const card = (st, daysLeft, fullyCompliant = false) => ({ st, key: st, kind: 'medical', comp: { fullyCompliant, daysLeft, assessmentStatus: fullyCompliant ? 'met' : 'needs-hours' } });
const rows = (stateComps, leadDays = 90) => cmeDueRows(standingScore({ stateComps, leadDays }).needsAction).map(r => r.item.id);

/** The source of one top-level function in App.jsx, up to the next marker. */
const slice = (start, end) => {
  const i = app.indexOf(start);
  assert.ok(i >= 0, `${start} is in App.jsx`);
  const j = app.indexOf(end, i + start.length);
  assert.ok(j > i, `${end} follows ${start}`);
  return app.slice(i, j);
};
const home = slice('const renderHome = () => {', '/* ─── SHARE PAGE');

test('no CME row while every card is met, or the shortfall is outside the reminder lead window', () => {
  assert.deepEqual(rows([card('TX', 40, true), card('CA', -5, true)]), [], 'a met cycle never shows, even inside the window or past its date');
  assert.deepEqual(rows([card('TX', 200), card('CA', 91)]), [], 'a shortfall 91+ days out is not due yet at the default 90');
  // The card colours (60 danger / 180 warning) are not the rule: 150 days out is amber on the card but not due.
  assert.deepEqual(rows([card('TX', 150)]), []);
});

test('a CME row once a shortfall is inside the lead window, or overdue; the member\'s lead time decides', () => {
  assert.deepEqual(rows([card('TX', 45), card('CA', 200)]), ['cme:TX']);
  assert.deepEqual(rows([card('TX', -3)]), ['cme:TX'], 'overdue');
  assert.deepEqual(rows([card('TX', 90)]), ['cme:TX'], 'the 90th day is inside the window');
  assert.deepEqual(rows([card('TX', 100)], reminderLeadDays(120)), ['cme:TX'], 'a 120-day lead time brings 100 days out inside');
  assert.deepEqual(rows([card('TX', 100)], reminderLeadDays(90)), []);
  assert.equal(reminderLeadDays(undefined), 90, 'the default lead time is 90 days');
});

test('only CME rows: a lapsing licence in the ring is not a CME row', () => {
  const lic = { id: 'tx', type: 'State Medical License', state: 'TX', licenseNumber: 'SYN-TX', expirationDate: day(20) };
  const score = standingScore({ items: [lic], stateComps: [card('CA', 200)], leadDays: 90 });
  assert.equal(score.needsAction.length, 1);
  assert.deepEqual(cmeDueRows(score.needsAction), []);
  assert.deepEqual(cmeDueRows(undefined), []);
  const cert = { st: 'NCCPA', kind: 'cert', key: 'cert:nccpa', comp: { fullyCompliant: false, daysLeft: 30, assessmentStatus: 'needs-hours', certCard: { label: 'NCCPA certification (PA-C)' } } };
  assert.deepEqual(rows([cert]), ['cme:cert:nccpa'], 'a certification shortfall in the window is a CME row too');
});

test('real records: the licence renewal anchors the window, and a Resolve licence never makes a CME row (HOME-013)', () => {
  const data = (licenses, lead = 90) => ({
    settings: { name: 'Synthetic Physician', degreeType: 'MD', primaryState: 'TX', additionalStates: [], reminderLeadDays: lead },
    licenses, cme: [], privileges: [], insurance: [], caseLogs: [], healthRecords: [], education: [], customRecords: [], alertAcks: [],
  });
  const due = (d) => {
    const stateComps = trackedStates(d.settings.primaryState, d.settings.additionalStates, d.licenses)
      .map(st => ({ st, comp: complianceFor(d, st), lic: findStateLicense(d.licenses, st) }));
    const counted = new Set(alertingStates(d.settings.primaryState, d.settings.additionalStates, d.licenses));
    return cmeDueRows(standingScore({ items: d.licenses, stateComps: stateComps.filter(x => counted.has(x.st)), leadDays: reminderLeadDays(d.settings.reminderLeadDays) }).needsAction).map(r => r.item.id);
  };
  const TX = (n) => ({ id: 'tx', type: 'State Medical License', state: 'TX', licenseNumber: 'SYN-TX', expirationDate: day(n) });
  assert.deepEqual(due(data([TX(800)])), [], 'no CME logged, but the renewal is 800 days out: nothing on Home');
  assert.deepEqual(due(data([TX(40)])), ['cme:TX'], 'no CME logged and the renewal is 40 days out: Home shows the card');
  assert.deepEqual(due(data([TX(150)], 180)), ['cme:TX'], 'a 180-day lead time brings a 150-day renewal inside');
  const CO = { id: 'co', type: 'State Medical License', state: 'CO', licenseNumber: 'SYN-CO', dateUnknown: true, statusSource: 'Synthetic board email' };
  assert.deepEqual(due(data([TX(800), CO])), [], 'a date-unknown CO licence is a Resolve task, not a CME-due card');
});

test('Home renders no CME Progress section or state grid; only the compact card, gated on the ring\'s CME rows', () => {
  assert.doesNotMatch(home, /CME Progress/, 'no CME Progress heading on Home');
  assert.doesNotMatch(home, /renderStateCard|stateCards|cmeHeader/, 'no state progress grid on Home');
  assert.doesNotMatch(home, /cmd-responsive-grid-3">\{stateCards\}/);
  assert.match(home, /const cmeDue = cmeDueRows\(standing\.needsAction\);/);
  assert.match(home, /const cmeDueCard = cmeDue\.length > 0 && \(/);
  assert.equal((home.match(/\{cmeDueCard\}/g) || []).length, 2, 'phone and desk place the compact card');
  assert.match(home, /needs attention/);
  assert.match(home, /See CME progress/);
  // The card is one tap target, 44 px, to the progress view.
  const cardSrc = home.slice(home.indexOf('const cmeDueCard'), home.indexOf('const cmeSetupCards'));
  assert.match(cardSrc, /<button type="button" onClick=\{openCmeDue\}/);
  assert.match(cardSrc, /minHeight: 44/);
  assert.match(home, /if \(cmeDueCertOnly\) \{ setTab\("credentials"\); setSubPage\("cme"\); return; \}\n\s+openCmeProgress\(\);/);
  // The rest of Home is untouched: ring, Action Required, setup warnings, board cards.
  assert.match(home, /\{actionSection\}/);
  assert.equal((home.match(/\{allTrackedStates\.length > 0 && cmeSetupBlock\}/g) || []).length, 2, 'setup warnings stay on Home in both layouts');
  assert.match(home, /\{boardHeading\}/);
  assert.match(home, /needsActionList\(4\)/);
});

test('Home taps that reviewed a state card land on CME progress with its math open', () => {
  assert.match(app, /const openCmeProgress = \(detail = null\) => \{\n\s+setTab\("credentials"\); setSubPage\("cmeProgress"\);\n\s+if \(detail\) setCmeDetail\(detail\);/);
  assert.match(home, /const reviewCmeState = \(st, kind\) => openCmeProgress\(/);
  assert.doesNotMatch(home, /renderCmeMathModal\(\)/, 'the math modal renders on the progress view');
});

test('Credentials lists CME progress first under Continuing Education; CME Credits and Find CME stay', () => {
  const group = slice('{ title: "Continuing Education", items: [', ']},');
  const ids = [...group.matchAll(/\{ id: "([^"]+)", label: "([^"]+)"/g)].map(m => [m[1], m[2]]);
  assert.deepEqual(ids, [['cmeProgress', 'CME progress'], ['cme', 'CME Credits'], ['findCme', 'Find CME']]);
  assert.match(group, /pinned: true/, 'kept first on the phone list though it has no count');
  const routes = slice('const renderCredSection = (sub) => {', 'if (sub === "privileges")');
  assert.match(routes, /if \(sub === "cmeProgress"\) return renderCmeProgress\(\);/);
  assert.match(routes, /if \(sub === "cme"\) return <CMESection onShare=\{openShare\} \{\.\.\.crudTarget\("cme"\)\} \/>;/);
  assert.match(routes, /if \(sub === "findCme"\) return <CMEResourcesSection \/>;/);
  assert.match(routes, /if \(sub\?\.startsWith\("findCme:"\)\) return <CMEResourcesSection initialTopicFilter=/);
});

test('the CME progress view is the full section: every state card, setup warnings, Find CME and the math', () => {
  const view = slice('const renderCmeProgress = () => {', '/* ─── HOME PAGE');
  assert.match(view, />CME progress<\/h2>/);
  assert.match(view, /const stateCards = stateComps\.map\(renderStateCard\);/, 'every tracked state, not only the due ones');
  assert.match(view, /const licenseWarnings = cmeSetupWarnings\(\);/);
  assert.match(view, /setSubPage\("findCme"\); \}\} style=\{\{[\s\S]*?minHeight: 32,[\s\S]*?\}\}>Find CME<\/button>/);
  assert.match(view, /\{renderCmeMathModal\(\)\}/);
  // The card still opens its math and keeps Find CME and the renewal packet.
  const cardSrc = slice('const renderStateCard = ({ st, key, kind, comp, lic }) => {', 'const openCmeProgress');
  assert.match(cardSrc, /onClick=\{\(\) => setCmeDetail\(\{ st, kind, comp \}\)\}/);
  assert.match(cardSrc, /setSubPage\("findCme"\);[\s\S]*?Find CME &rarr;/);
  assert.match(cardSrc, /sendRenewalPacket\(st, app \? kind : undefined\)/);
});
