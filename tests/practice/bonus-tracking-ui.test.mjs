import test from 'node:test';
import assert from 'node:assert/strict';
import { loadScreens, mount, renderScreen, nodes, textOf, find, field, click, pinClock, THEME } from '../harness/component-harness.mjs';

// Bonus terms on the agreement form, and the progress they drive on the
// agreement, its summary and the Practice dashboard, in the empty and the
// filled states. Driven through the real components. Synthetic data only.

pinClock(test, 'America/Los_Angeles', '2026-11-16T09:00:00-08:00');
const { Contracts, ContractSummary, BonusProgress, BonusOverview } = await loadScreens(`
  export {default as Contracts} from "./src/components/features/locum/Contracts.jsx";
  export {default as ContractSummary} from "./src/components/features/locum/ContractSummary.jsx";
  export {default as BonusProgress, BonusOverview} from "./src/components/features/locum/BonusProgress.jsx";
`);
// Practice's sub-views pull in the whole records layer, so the dashboard is
// bundled with the real records modules (as the other dashboard tests do); it
// only renders here, and with nobody signed in nothing is stored.
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
let Practice;
try {
  Practice = await loadScreens(`
    export {default as LocumDashboard} from "./src/components/features/locum/LocumDashboard.jsx";
    export {BonusOverview} from "./src/components/features/locum/BonusProgress.jsx";
  `, { real: ['lib/supabase', 'utils/storageScope', 'utils/privateVault'] });
} finally { delete globalThis.localStorage; }

const PLAIN = { id: 'c1', facility: 'Synthetic Valley Hospital', payModel: 'hourly', hourlyRate: 250, dayRate: 0, callStipend: 0, incrementMinutes: 15, minCallMinutes: 15, coveragePeriods: [] };
const TERMS = { bonusWrvuTarget: 6000, bonusPeriod: 'annual', bonusPeriodStart: '2026-07-01', bonusRatePerWrvu: 52.5 };
const enc = (id, date, wRVU, contractId = 'c1') => ({ id, contractId, date, codes: [{ code: '99213', wRVU, units: 1 }] });
const BELOW = [enc('e1', '2026-08-01', 4200)];
const ABOVE = [enc('e1', '2026-08-01', 6000), enc('e2', '2026-09-01', 120.5), enc('e0', '2026-06-30', 999)];
const BONUS_KEYS = ['bonusWrvuTarget', 'bonusPeriod', 'bonusPeriodStart', 'bonusRatePerWrvu'];

const app = (data, extra = {}) => ({ data: { settings: {}, locumContracts: [], encounters: [], invoices: [], workLog: [], dutyDays: [], caseLogs: [], documents: [], ...data }, theme: THEME, isDesktop: false, user: { id: 'user_synthetic' }, ...extra });
const html = (Component, data, props) => renderScreen(Component, { app: app(data), props });
const text = (markup) => markup.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ');

const edit = (m) => nodes(find(m.render(), n => n.type === 'div' && n.key === 'c1', 'card')).filter(n => n.type === 'button' && n.props['aria-label'] === 'Edit')[0].props.onClick();
const control = (m, label, type = 'input') => find(field(m.render(), label), n => n.type === type, label);
const saved = (m) => m.calls.filter(c => (c[0] === 'edit' || c[0] === 'add') && c[1] === 'locumContracts').map(c => c[2]);
const submitNew = (m) => find(m.render(), n => n.type === 'button' && textOf(n) === 'Add' && !n.props['aria-label'] && n.props.style?.padding === '12px 18px', 'form Add button').props.onClick();

// ─── The agreement form ─────────────────────────────────────

test('edit form, empty: the four optional bonus fields are there and blank', () => {
  const m = mount(Contracts, { data: { locumContracts: [PLAIN] } });
  edit(m);
  const group = find(m.render(), n => n.props?.['aria-label'] === 'Productivity bonus', 'bonus group');
  assert.match(textOf(group), /Productivity bonus \(optional\)/);
  assert.equal(control(m, 'wRVU target').props.value, '');
  assert.equal(control(m, '$ per wRVU').props.value, '');
  assert.equal(control(m, 'Bonus period', 'select').props.value, '');
  assert.equal(control(m, 'Period start date').props.value, '');
  assert.deepEqual(nodes(control(m, 'Bonus period', 'select')).filter(n => n.type === 'option').map(textOf), ['No period', 'Annual', 'Quarterly', 'Monthly']);
});

test('an agreement without bonus terms saves exactly the keys it always did', () => {
  const m = mount(Contracts, { data: { locumContracts: [PLAIN] } });
  edit(m);
  control(m, 'Hourly rate ($/hr)').props.onChange({ target: { value: '275' } });
  click(m, 'Save');
  const [c] = saved(m);
  assert.equal(c.hourlyRate, 275);
  for (const k of BONUS_KEYS) assert.ok(!(k in c), `${k} is not written`);

  const n = mount(Contracts, { data: { locumContracts: [] } });
  click(n, 'Add');
  control(n, 'Hospital / Facility').props.onChange({ target: { value: 'Synthetic Mercy' } });
  control(n, 'Hourly rate ($/hr)').props.onChange({ target: { value: '250' } });
  submitNew(n);
  for (const k of BONUS_KEYS) assert.ok(!(k in saved(n)[0]), `${k} is not written on a new agreement`);
});

test('edit form, filled: the terms show, and save as numbers, a period and a date', () => {
  const m = mount(Contracts, { data: { locumContracts: [PLAIN] } });
  edit(m);
  control(m, 'wRVU target').props.onChange({ target: { value: '6000' } });
  control(m, '$ per wRVU').props.onChange({ target: { value: '52.50' } });
  control(m, 'Bonus period', 'select').props.onChange({ target: { value: 'annual' } });
  control(m, 'Period start date').props.onChange({ target: { value: '2026-07-01' } });
  assert.equal(control(m, 'wRVU target').props.value, '6000');
  assert.equal(control(m, 'Bonus period', 'select').props.value, 'annual');
  click(m, 'Save');
  const [c] = saved(m);
  assert.deepEqual(BONUS_KEYS.map(k => c[k]), [6000, 'annual', '2026-07-01', 52.5]);
  assert.equal(c.hourlyRate, 250, 'the rest of the agreement is untouched');

  // Reopened, the saved terms are in the form.
  edit(m);
  assert.equal(control(m, 'wRVU target').props.value, 6000);
  assert.equal(control(m, '$ per wRVU').props.value, 52.5);
  assert.equal(control(m, 'Period start date').props.value, '2026-07-01');
});

test('clearing the terms saves null, never 0', () => {
  const m = mount(Contracts, { data: { locumContracts: [{ ...PLAIN, ...TERMS }] } });
  edit(m);
  control(m, 'wRVU target').props.onChange({ target: { value: '' } });
  control(m, '$ per wRVU').props.onChange({ target: { value: '' } });
  control(m, 'Bonus period', 'select').props.onChange({ target: { value: '' } });
  control(m, 'Period start date').props.onChange({ target: { value: '' } });
  click(m, 'Save');
  assert.deepEqual(BONUS_KEYS.map(k => saved(m)[0][k]), [null, null, null, null]);
});

test('a target or rate that is not above 0 is refused and named, and nothing is saved', () => {
  const m = mount(Contracts, { data: { locumContracts: [PLAIN] } });
  edit(m);
  control(m, 'wRVU target').props.onChange({ target: { value: '-10' } });
  click(m, 'Save');
  assert.deepEqual(saved(m), []);
  assert.match(textOf(m.render()), /The wRVU target must be a number above 0, or left blank\./);
  control(m, 'wRVU target').props.onChange({ target: { value: '6000' } });
  control(m, '$ per wRVU').props.onChange({ target: { value: '0' } });
  click(m, 'Save');
  assert.deepEqual(saved(m), []);
  assert.match(textOf(m.render()), /The \$ per wRVU rate must be a number above 0, or left blank\./);
});

// ─── On the agreement ───────────────────────────────────────

test('agreement card: no bonus block without terms, progress and the estimate with them', () => {
  const empty = text(html(Contracts, { locumContracts: [PLAIN], encounters: ABOVE }));
  assert.doesNotMatch(empty, /Estimated bonus|wRVU target|of 6,000 wRVU/);
  const filled = text(html(Contracts, { locumContracts: [{ ...PLAIN, ...TERMS }], encounters: ABOVE }));
  assert.match(filled, /6,120\.5 of 6,000 wRVU/);
  assert.match(filled, /102%/);
  assert.match(filled, /Estimated bonus \$6,326\.25/);
});

test('agreement summary, empty: a prompt to add the terms and no number', () => {
  const out = text(html(ContractSummary, { locumContracts: [PLAIN], encounters: ABOVE }, { contract: PLAIN, onClose() {}, onEdit() {} }));
  assert.match(out, /No bonus terms on this agreement yet\. Add a wRVU target and a \$ per wRVU rate to see your progress and an estimated bonus\./);
  assert.match(out, /Add bonus terms/);
  assert.doesNotMatch(out, /Estimated bonus \$|%/);
});

test('agreement summary, filled and below the target: number, percent, bar, and $0.00 labeled as an estimate', () => {
  const c = { ...PLAIN, ...TERMS };
  const markup = html(ContractSummary, { locumContracts: [c], encounters: BELOW }, { contract: c, onClose() {} });
  const out = text(markup);
  assert.match(out, /This year \(Jul 1, 2026 to Jun 30, 2027\)/);
  assert.match(out, /4,200 of 6,000 wRVU/);
  assert.match(out, /70%/);
  assert.match(out, /1,800 wRVU to go\./);
  assert.match(markup, /role="progressbar"[^>]*aria-valuenow="70"/);
  assert.match(markup, /width:70\.00%/);
  assert.match(out, /Estimated bonus \$0\.00/);
  assert.match(out, /Estimated bonus based on your logged wRVUs; your employer's statement is the official number\./);
});

test('agreement summary, filled and above the target: the estimate and how it was worked out', () => {
  const c = { ...PLAIN, ...TERMS };
  const markup = html(ContractSummary, { locumContracts: [c], encounters: ABOVE }, { contract: c, onClose() {} });
  const out = text(markup);
  assert.match(out, /6,120\.5 of 6,000 wRVU/);
  assert.match(out, /120\.5 wRVU above the target\./);
  assert.match(out, /Estimated bonus \$6,326\.25/);
  assert.match(out, /120\.5 wRVU above the target × \$52\.50 per wRVU\./);
  assert.match(out, /your employer's statement is the official number/);
  assert.match(markup, /aria-valuenow="100"/, 'the bar stops at the target');
  assert.match(markup, /width:100\.00%/);
});

test('a target without a rate shows progress and asks for the rate; a rate without a target shows no number', () => {
  const noRate = { ...PLAIN, ...TERMS, bonusRatePerWrvu: null };
  const a = text(html(BonusProgress, { encounters: ABOVE }, { contract: noRate }));
  assert.match(a, /6,120\.5 of 6,000 wRVU/);
  assert.match(a, /Add the \$ per wRVU rate to see an estimated bonus\. Edit the agreement to add it\./);
  assert.doesNotMatch(a, /Estimated bonus \$|official number/);

  const noTarget = { ...PLAIN, ...TERMS, bonusWrvuTarget: null };
  const b = text(html(BonusProgress, { encounters: ABOVE }, { contract: noTarget }));
  assert.match(b, /has a rate of \$52\.50 per wRVU but no wRVU target\. Add the target to see your progress and an estimated bonus\./);
  assert.doesNotMatch(b, /6,120|%|Estimated bonus \$/);
});

test('wRVUs logged in the period with no agreement picked are pointed out, not counted', () => {
  const c = { ...PLAIN, ...TERMS };
  const out = text(html(BonusProgress, { encounters: [...BELOW, enc('e9', '2026-10-01', 35, null)] }, { contract: c }));
  assert.match(out, /4,200 of 6,000 wRVU/);
  assert.match(out, /35 wRVU logged in this period have no agreement picked, so they are not counted here\./);
});

// ─── The Practice dashboard ─────────────────────────────────

test('dashboard card, empty: one prompt that leads to Contracts, and no number', () => {
  const none = text(html(BonusOverview, { locumContracts: [], encounters: ABOVE }, { onOpenContracts() {} }));
  assert.match(none, /Bonus progress/);
  assert.match(none, /Add an agreement with its wRVU target and \$ per wRVU rate/);
  assert.match(none, /Go to Contracts/);
  const noTerms = text(html(BonusOverview, { locumContracts: [PLAIN], encounters: ABOVE }, { onOpenContracts() {} }));
  assert.match(noTerms, /Add a wRVU target and a \$ per wRVU rate to an agreement/);
  assert.match(noTerms, /Add bonus terms in Contracts/);
  for (const out of [none, noTerms]) assert.doesNotMatch(out, /Estimated bonus|%|\$\d/);
});

test('dashboard card, filled: each active agreement with terms, by name; archived and term-less ones left out', () => {
  const contracts = [
    { ...PLAIN, ...TERMS, shortName: 'SVH' },
    { ...PLAIN, id: 'c2', facility: 'Synthetic Lakeside Clinic', bonusWrvuTarget: 500, bonusPeriod: 'monthly', bonusRatePerWrvu: 40 },
    { ...PLAIN, id: 'c3', facility: 'Synthetic No Terms' },
    { ...PLAIN, ...TERMS, id: 'c4', facility: 'Synthetic Archived', customFields: { archivedAt: '2026-10-01T00:00:00.000Z' } },
  ];
  const encounters = [...ABOVE, enc('e5', '2026-11-03', 125, 'c2'), enc('e6', '2026-10-31', 400, 'c2')];
  const out = text(html(BonusOverview, { locumContracts: contracts, encounters }, { onOpenContracts() {} }));
  assert.match(out, /SVH .*6,120\.5 of 6,000 wRVU.*Estimated bonus \$6,326\.25/);
  assert.match(out, /Synthetic Lakeside Clinic This calendar month \(Nov 1, 2026 to Nov 30, 2026\) 125 of 500 wRVU 25%.*Estimated bonus \$0\.00/);
  assert.doesNotMatch(out, /Synthetic No Terms|Synthetic Archived/);
});

test('Practice members only: without Practice the dashboard shows the offer and no bonus tracking', () => {
  const data = { locumContracts: [{ ...PLAIN, ...TERMS }], encounters: ABOVE };
  const gate = { limitedLaunch: { enabled: false }, practiceReadOnly: false, isDevMode: false };
  const locked = text(renderScreen(Practice.LocumDashboard, { app: app(data, { ...gate, plan: 'core' }), props: { initialSub: 'rvus' } }));
  assert.match(locked, /Practice tools/);
  assert.doesNotMatch(locked, /Bonus progress|Estimated bonus|6,120/);

  // With Practice, the RVUs view carries the card (the harness does not expand
  // child components on a mount, so the element itself is the evidence).
  const m = mount(Practice.LocumDashboard, { data, props: { initialSub: 'rvus' } });
  Object.assign(globalThis.__screen.app, gate, { plan: 'locum' });
  const tree = m.render();
  assert.ok(nodes(tree).some(n => n.type === Practice.BonusOverview), 'BonusOverview is on the RVUs view');
  find(tree, n => n.type === 'button' && textOf(n) === 'Work', 'Work tab').props.onClick();
  assert.ok(!nodes(m.render()).some(n => n.type === Practice.BonusOverview), 'and only there');
});
