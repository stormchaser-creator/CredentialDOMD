// Eric, 2026-11-20: "Cme status should not be on the homepage unless it is
// showing it needs to be due. The cme progress section should be moved as a
// link under credentials."
//
// Home used to render a CME Progress heading and every state's progress card
// whatever the standing. Now Home shows one compact card only while the ring
// lists a CME row (standingScore: a shortfall inside the member's reminder
// lead window, or overdue), and the cards live on Credentials > CME progress.
// The rule is the ring's own (cmeDueRows), not the cards' colour thresholds.
// Board and national certification cards followed on the same day (PR #29
// review): off Home unless due on the same lead window (boardDueRows, and the
// ring's "cert" rows), their full cards on Credentials > CME progress.
// Synthetic records only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { trackedStates, alertingStates, complianceFor, findStateLicense, standingScore, cmeDueRows } from '../../src/utils/compliance.js';
import { reminderLeadDays } from '../../src/utils/reminderPreferences.js';
import { boardComplianceFor } from '../../src/utils/boardCompliance.js';
import { boardDueRows, openBoardTasks } from '../../src/utils/boardTasks.js';

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
  assert.match(home, /const dueRows = \[\.\.\.cmeDue\.map\(needsActionText\), /);
  assert.equal((home.match(/\{cmeDueCard\}/g) || []).length, 2, 'phone and desk place the compact card');
  assert.match(home, /needs attention/);
  assert.match(home, /See CME progress/);
  // The card is one tap target, 44 px, to the progress view.
  const cardSrc = home.slice(home.indexOf('const cmeDueCard'), home.indexOf('const cmeSetupCards'));
  assert.match(cardSrc, /<button type="button" onClick=\{\(\) => openCmeProgress\(\)\}/);
  assert.match(cardSrc, /minHeight: 44/);
  // The rest of Home is untouched: ring, Action Required, setup warnings.
  assert.match(home, /\{actionSection\}/);
  assert.equal((home.match(/\{allTrackedStates\.length > 0 && cmeSetupBlock\}/g) || []).length, 2, 'setup warnings stay on Home in both layouts');
  assert.match(home, /needsActionList\(4\)/);
});

// Eric, 2026-11-20 (PR #29 review): "Show board and national cert cards on
// Home only when due; move them under Credentials too." Same lead window as
// CME; a rolling-window board with no cycle end is never due on hours alone.
const board = (over = {}) => ({ id: 'ABMS:SYN', source: 'ABMS', code: 'SYN', label: 'Synthetic board, ABMS SYN', required: 50, earned: 10, met: false, daysLeft: 200, ...over });
const due = (boards, lead = 90, data = { settings: {}, licenses: [], cme: [] }) => boardDueRows(data, boards, lead).map(r => `${r.board.id}:${r.days}`);

test('no board on Home while it is met, the shortfall is outside the lead window, or the window has no end date', () => {
  assert.deepEqual(due([board({ met: true, earned: 50, daysLeft: 20 })]), [], 'a met cycle never shows, even inside the window');
  assert.deepEqual(due([board({ met: true, earned: 50, daysLeft: -4 })]), []);
  assert.deepEqual(due([board({ daysLeft: 91 })]), [], '91 days out is not due at the default 90');
  assert.deepEqual(due([board({ daysLeft: null })]), [], 'a rolling-window shortfall (daysLeft null) alone stays off Home');
  assert.deepEqual(due([board({ required: null, daysLeft: 10 })]), [], 'a card with no verified requirement is not a shortfall');
  assert.deepEqual(due([{ id: 'ABMS-SUB:SYN:Sub', label: 'Sub', followsParent: true }]), [], 'a subspecialty follow note is never a row');
  // A PA's or NP's certification card is the ring's own "cert" row (cmeDueRows), never a second board row.
  assert.deepEqual(due([board({ id: 'cert:nccpa', source: 'CERT', body: 'NCCPA', daysLeft: 10 })]), []);
});

test('a board on Home once its shortfall is inside the lead window, or overdue; the member\'s lead time decides', () => {
  assert.deepEqual(due([board({ daysLeft: 41 })]), ['ABMS:SYN:41']);
  assert.deepEqual(due([board({ daysLeft: 90 })]), ['ABMS:SYN:90'], 'the 90th day is inside the window');
  assert.deepEqual(due([board({ daysLeft: -3 })]), ['ABMS:SYN:-3'], 'overdue');
  assert.deepEqual(due([board({ daysLeft: 100 })], reminderLeadDays(120)), ['ABMS:SYN:100']);
  assert.deepEqual(due([board({ id: 'B', daysLeft: 60 }), board({ id: 'A', daysLeft: 5 })]), ['A:5', 'B:60'], 'soonest first');
});

test('a rolling-window board comes to Home only for a dated board task inside the window (openBoardTasks)', () => {
  const at = (iso) => new Date(`${iso}T12:00:00`);
  const abim = { settings: { specialties: ['ABIM'], degreeType: 'MD' }, licenses: [{ id: 'b1', type: 'Board Certification (ABMS)', name: 'ABIM', expirationDate: '2030-12-31' }], cme: [] };
  const boards = boardComplianceFor(abim);
  assert.equal(boards[0].daysLeft, null, 'ABIM counts a rolling window');
  assert.equal(boards[0].met, false, 'and no hours are logged');
  assert.deepEqual(boardDueRows(abim, boards, 90, at('2026-11-19')), [], 'the shortfall alone, with no task due, keeps it off Home');
  const rows = boardDueRows(abim, boards, 90, at('2027-11-20'));
  assert.deepEqual(rows.map(r => [r.board.id, r.days, r.short, r.tasks.map(t => t.id)]), [['ABMS:ABIM', 41, false, ['fee']]]);
  assert.deepEqual(rows.flatMap(r => r.tasks.map(t => t.due)), openBoardTasks(abim, boards, 90, at('2027-11-20')).flatMap(o => o.tasks.map(t => t.due)), 'the same tasks the bell alerts');
});

test('Home renders no board or national certification grid; the compact card names a due board and opens CME progress', () => {
  assert.doesNotMatch(home, /boardHeading|boardCards|boardFollowNotes|renderBoardSection/, 'no board grid on Home');
  assert.doesNotMatch(home, /National Certification|Board Certification"/);
  assert.doesNotMatch(home, /CME follows the primary board above/);
  assert.doesNotMatch(home, /setSubPage\("cme"\)/, 'nothing on Home falls back to CME Credits');
  assert.doesNotMatch(home, /See CME Credits/);
  assert.match(app, /const boardDue = useMemo\(\(\) => boardDueRows\(data, boardComps, reminderLeadDays\(data\.settings\.reminderLeadDays\)\), \[data, boardComps\]\);/);
  assert.match(home, /const dueRows = \[\.\.\.cmeDue\.map\(needsActionText\), \.\.\.boardDue\.map\(boardDueText\)\];/);
  assert.match(home, /const cmeDueCard = dueRows\.length > 0 && \(/);
  assert.match(home, /dueRows\.length > 1 \? ` · and \$\{dueRows\.length - 1\} more` : ""/, 'one card: the first due item and "and N more"');
  assert.match(home, /"Board certification needs attention"/);
  // A certification ring row (NCCPA, an NP certifier) opens the view that shows its card.
  assert.match(home, /if \(isCme && item\.kind === "cert"\) \{ openCmeProgress\(\); return; \}/);
});

test('CME progress holds the board and national certification cards under the state cards, with their math', () => {
  const view = slice('const renderCmeProgress = () => {', '/* ─── HOME PAGE');
  assert.match(view, /\{stateCards\}[\s\S]*\{renderBoardSection\(\)\}[\s\S]*\{renderBoardMathModal\(\)\}/, 'under the state cards');
  const section = slice('const renderBoardSection = () => {', 'const renderBoardMathModal');
  assert.match(section, /isAdvancedPractice\(data\.settings\.degreeType\) \? "National Certification" : "Board Certification"/);
  assert.match(section, /boardComps\.filter\(b => !b\.followsParent\)/, 'every board card, met or not');
  assert.match(section, /\{b\.label\}: CME follows the primary board above/);
  assert.match(section, /<BoardTasks board=\{b\} \/>/, 'board tasks show on the card');
  assert.match(section, /Find CME &rarr;/);
  assert.match(slice('const renderBoardMathModal = () => (', 'const openCmeProgress'), /<Modal open=\{!!boardDetail\}/);
  // Search hops for board steps and state deadlines land there too.
  assert.match(app, /sec\.key === "boardSteps" \|\| sec\.key === "stateDeadlines"\) \{ openCmeProgress\(\); return; \}/);
  // The Credentials row counts what it shows.
  assert.match(app, /alertCount: cmeDueRows\(standing\.needsAction\)\.length \+ boardDue\.length/);
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
