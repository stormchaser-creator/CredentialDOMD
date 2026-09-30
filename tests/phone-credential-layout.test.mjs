// Phone layout of the credential sections (QA lab, phone-credentials.spec.mjs
// at 375 and 390 px). Driven through the real components with the render
// harness; what these pin is the CSS that decides the layout:
//   CRED-021 / CRED-037  two date fields side by side: every form grid track is
//                        minmax(0, ...), and a Field may shrink (min-width 0).
//                        A 1fr track cannot go below a date input's own
//                        minimum (about 189 px in Chrome), so the second date
//                        ran off the dialog's right edge.
//   CRED-028             the "How to renew" line is never cut: it runs the
//                        card's full width, wraps "Renew online" under it
//                        rather than shrinking, and its words wrap, not clip.
//   CRED-001             card actions at least 32 x 32 and 6 px apart.
//   CRED-026 / 009 / 047 filter chips, CME topic chips and the custom
//                        category buttons at least 32 px tall.
// Synthetic records only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { mountComponent } from './component-harness.mjs';

const actionButton = await import('../src/components/shared/actionButton.js');
const helpers = await import('../src/utils/helpers.js');
const credentialTypes = await import('../src/constants/credentialTypes.js');
const sectionFields = await import('../src/utils/sectionFields.js');
const cmeTopics = await import('../src/constants/cmeTopics.js');
const inboxDocs = await import('../src/utils/inboxDocs.js');
const lifecycle = await import('../src/utils/lifecycle.js');
const caseBilling = await import('../src/utils/caseBilling.js');
const formLayout = await import('../src/utils/formLayout.js');
const FLOOR = 32;
const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const noop = () => {};
const app = (data, over = {}) => ({ data: { settings: {}, documents: [], followUps: [], ...data }, theme: {}, isDesktop: false, addItem: noop, editItem: noop, deleteItem: noop, setData: noop, toggleFavorite: noop, ...over });

/** Every element under `tree` with its parent chain (nearest first). */
function walk(tree) {
  const out = [];
  const isElement = (v) => v && typeof v === 'object' && 'type' in v && 'props' in v;
  const visit = (n, parents) => {
    if (Array.isArray(n)) { n.forEach((c) => visit(c, parents)); return; }
    if (!isElement(n)) return;
    out.push({ node: n, parents });
    const next = [n, ...parents];
    for (const [k, v] of Object.entries(n.props || {})) if (k !== 'children' && (isElement(v) || (Array.isArray(v) && v.some(isElement)))) visit(v, next);
    visit(n.props?.children, next);
  };
  visit(tree, []);
  return out;
}
const openModal = (ui) => ui.nodes().find((n) => n.type?.name === 'Modal' && n.props.open);
const grids = (tree) => walk(tree).map((e) => e.node).filter((n) => n.type === 'div' && n.props.style?.display === 'grid');
/** A track list whose every column may shrink to its share: minmax(0, ...) or a fixed length, never a bare fr or auto. */
const shrinkable = (cols) => String(cols).trim().split(/\s+(?![^(]*\))/).every((t) => /^minmax\(0(px)?,/.test(t.replace(/\s+/g, '')) || /^\d+(\.\d+)?px$/.test(t));

function assertFormGrids(tree, label) {
  const found = grids(tree);
  assert.ok(found.length > 0, `${label}: the form has two-across rows`);
  for (const g of found) assert.ok(shrinkable(g.props.style.gridTemplateColumns), `${label}: "${g.props.style.gridTemplateColumns}" lets a date input push the row past the phone's edge`);
}

function assertTapFloor(style, label, { square = true } = {}) {
  assert.ok((style?.minHeight ?? 0) >= FLOOR, `${label}: minHeight ${style?.minHeight}`);
  if (square) assert.ok((style?.minWidth ?? 0) >= FLOOR, `${label}: minWidth ${style?.minWidth}`);
}

const ACTION_LABELS = /^(Share|Edit|Delete|Add to Favorites|Remove from Favorites)$/;
function assertCardActions(ui, label) {
  const entries = walk(ui.render());
  const actions = entries.filter((e) => e.node.type === 'button' && ACTION_LABELS.test(e.node.props['aria-label'] || ''));
  assert.equal(actions.length, 4, `${label}: star, send, edit and delete on the card`);
  for (const a of actions) assertTapFloor(a.node.props.style, `${label} ${a.node.props['aria-label']}`);
  const row = actions[0].parents[0];
  assert.ok(actions.every((a) => a.parents[0] === row), `${label}: the four share one row`);
  assert.ok(row.props.style.gap >= 6, `${label}: ${row.props.style.gap} px between edit and delete`);
}

// ── CRED-021: Health Records ────────────────────────────────────────────────
const healthRecords = (items = []) => mountComponent('src/components/features/HealthRecordsSection.jsx', {
  app: app({ healthRecords: items }), props: { onShare: noop },
  modules: { credentialTypes, helpers, sectionFields, actionButton },
});

test('CRED-021: the Health Records form lays its date pairs in tracks that can shrink, for every category', async () => {
  const ui = await healthRecords();
  const add = ui.nodes().find((n) => n.type === 'button' && ui.text(n).trim() === 'Add');
  add.props.onClick();
  const modal = () => openModal(ui);
  assert.ok(modal(), 'the Add form is open');
  assertFormGrids(modal(), 'Health Records Add form');
  // TB tests, titers and drug screens add Value/Units, Collected/Reported and Laboratory/Specimen rows.
  for (const category of ['TB Test', 'Titer / Immunity', 'Drug Screen']) {
    const select = walk(modal()).map((e) => e.node).find((n) => n.type === 'select' && n.props.required);
    select.props.onChange({ target: { value: category } });
    ui.render();
    assert.equal(grids(modal()).length, 4, `${category}: all four two-across rows`);
    assertFormGrids(modal(), `${category} form`);
  }
});

test('CRED-001 / CRED-026: Health Records cards and filter chips reach the 32 px floor', async () => {
  const ui = await healthRecords([{ id: 'hr-1', category: 'Vaccination', type: 'Influenza', name: 'Synthetic flu shot', dateAdministered: day(-30) }]);
  assertCardActions(ui, 'Health Records card');
  const chips = ui.nodes().filter((n) => n.type === 'button' && 'aria-pressed' in n.props && !ACTION_LABELS.test(n.props['aria-label'] || ''));
  assert.ok(chips.length >= 5, 'All plus every category');
  for (const c of chips) assertTapFloor(c.props.style, `chip "${ui.text(c)}"`, { square: false });
});

// ── CRED-037: Screenings ────────────────────────────────────────────────────
const screenings = (items = []) => mountComponent('src/components/features/ScreeningsSection.jsx', {
  app: app({ screenings: items }), props: { onShare: noop },
  modules: { credentialTypes, helpers, actionButton },
});

test('CRED-037: the Screenings form keeps Ordered and Reported (and the other pairs) inside the dialog', async () => {
  const ui = await screenings();
  const add = ui.nodes().find((n) => n.type === 'button' && ui.text(n).trim() === 'Add');
  add.props.onClick();
  assert.ok(openModal(ui), 'the Add form is open');
  assertFormGrids(openModal(ui), 'Screenings Add form');
  const dates = walk(openModal(ui)).filter((e) => e.node.type === 'input' && e.node.props.type === 'date' && e.parents.some((p) => p.props?.style?.display === 'grid'));
  assert.ok(dates.length >= 3, 'Ordered, Reported and Expires sit in two-across rows');
});

test('CRED-001: Screenings cards reach the 32 px floor', async () => {
  const ui = await screenings([{ id: 'scr-1', type: 'Background Check', name: 'Synthetic check', agency: 'Synthetic Screening Co', result: 'Clear', reportDate: day(-30), components: [] }]);
  assertCardActions(ui, 'Screenings card');
});

// ── CME ─────────────────────────────────────────────────────────────────────
const cme = (items = [], over = {}) => mountComponent('src/components/features/CMESection.jsx', {
  app: app({ cme: items }, { allTrackedStates: [], ...over }), props: { onShare: noop },
  modules: {
    actionButton, helpers, credentialTypes,
    useForwardingAddresses: { useForwardingAddresses: () => ({ rows: [], loading: false }) },
    cmeTopics, inboxDocs,
  },
});

test('CRED-009: CME topic chips are 32 px tall with room between them, and Hours / Date Completed can shrink', async () => {
  const ui = await cme();
  const add = ui.nodes().find((n) => n.type === 'button' && ui.text(n).trim() === 'Add');
  add.props.onClick();
  const modal = openModal(ui);
  assert.ok(modal, 'the Add form is open');
  const { CME_TOPICS } = cmeTopics;
  const chips = walk(modal).filter((e) => e.node.type === 'button' && CME_TOPICS.some((t) => ui.text(e.node).endsWith(t)));
  assert.ok(chips.length >= CME_TOPICS.length - 1, `every topic is a chip (${chips.length})`);
  for (const c of chips) assertTapFloor(c.node.props.style, `topic "${ui.text(c.node)}"`, { square: false });
  assert.ok(chips.every((c) => c.parents[0].props.style.gap >= 6), 'the chips are not packed 4 px apart');
  assertFormGrids(modal, 'CME Add form');
});

test('CRED-001: the CME phone card actions reach the 32 px floor (they were 26 px)', async () => {
  const ui = await cme([{ id: 'cme-1', title: 'Synthetic Spine Update', hours: 4, category: 'AMA PRA Category 1', date: day(-15) }]);
  assertCardActions(ui, 'CME card');
});

// ── CrudSection (Licenses, Travel & IDs and every generic section) ──────────
const LICENSE = { id: 'lic-1', type: 'State Medical License', name: 'Synthetic CO License', state: 'CO', licenseNumber: 'SYN-4410', expirationDate: day(40) };
const EXTRA = { type: 'span', props: { 'data-extra': 'renewal', children: 'How to renew' } };
const crud = (over = {}) => mountComponent('src/components/features/CrudSection.jsx', {
  app: app({}, over.app),
  props: {
    title: 'Licenses', sectionKey: 'licenses', items: [LICENSE], favoritable: true,
    fields: [{ key: 'licenseNumber', label: 'Number' }],
    filterTabs: [{ key: 'medical', label: 'Medical Licenses', match: () => true }],
    renderExtra: () => EXTRA, onShare: noop, onDelete: noop,
    ...over.props,
  },
  modules: {
    actionButton, helpers, lifecycle, caseBilling, formLayout,
  },
});

test('CRED-001 / CRED-026: a phone record card and the filter chips reach the 32 px floor', async () => {
  const ui = await crud();
  assertCardActions(ui, 'License card');
  const chips = ui.nodes().filter((n) => n.type === 'button' && 'aria-pressed' in n.props && !ACTION_LABELS.test(n.props['aria-label'] || ''));
  assert.ok(chips.length >= 2, 'All and Medical Licenses');
  for (const c of chips) assertTapFloor(c.props.style, `chip "${ui.text(c)}"`, { square: false });
});

test('CRED-028: the card\'s extra line (How to renew) runs the full card width, not the column the actions squeeze', async () => {
  const ui = await crud();
  const entries = walk(ui.render());
  const extra = entries.find((e) => e.node.props?.['data-extra'] === 'renewal');
  assert.ok(extra, 'the extra line renders on the card');
  const card = extra.parents.find((p) => typeof p.props?.onClick === 'function' && p.props.style?.borderRadius === 14);
  assert.ok(card, 'inside the card');
  const between = extra.parents.slice(0, extra.parents.indexOf(card));
  assert.ok(!between.some((p) => p.props?.style?.minWidth === 0), 'not inside the title column (min-width 0, beside the actions)');
  assert.ok(!between.some((p) => walk(p.props?.children).some((e) => ACTION_LABELS.test(e.node.props?.['aria-label'] || ''))), 'not in a row with the action buttons');
});

test('the desk table is unchanged: its star keeps the desk row size', async () => {
  const ui = await crud({ app: { isDesktop: true }, props: { deskColumns: [{ key: 'licenseNumber', label: 'Number' }] } });
  const table = ui.nodes().find((n) => n.type?.name === 'DeskTable');
  assert.ok(table, 'desk width shows the table');
  const star = walk(table.props.actions(LICENSE)).map((e) => e.node).find((n) => /Favorites/.test(n.props?.['aria-label'] || ''));
  assert.equal(star.props.style.minHeight, undefined);
});

// ── RenewalInfo itself ──────────────────────────────────────────────────────
test('CRED-028: "How to renew" wraps "Renew online" under it and wraps its words instead of cutting them to "Ho..."', async () => {
  const ui = await mountComponent('src/components/features/RenewalInfo.jsx', {
    app: { theme: {}, data: { settings: { degreeType: 'MD' } } },
    props: { item: LICENSE },
    modules: { actionButton, renewalRoute: await import('../src/utils/renewalRoute.js') },
  });
  const entries = walk(ui.render());
  const line = entries.map((e) => e.node).find((n) => n.type === 'button' && 'aria-expanded' in n.props);
  const portal = entries.map((e) => e.node).find((n) => n.type === 'a' && ui.text(n) === 'Renew online');
  assert.ok(line && portal, 'an urgent licence shows the line and Renew online');
  const row = entries.find((e) => e.node === line).parents[0];
  assert.equal(row.props.style.flexWrap, 'wrap', 'Renew online moves under the line when both do not fit');
  assert.match(String(line.props.style.flex), /^1 1 auto$/, 'the line asks for its own width (a 0 basis never wraps, it shrinks)');
  const words = line.props.children.find((c) => c?.type === 'span' && /How to renew/.test(ui.text(c)));
  assert.notEqual(words.props.style.whiteSpace, 'nowrap');
  assert.notEqual(words.props.style.textOverflow, 'ellipsis');
  assert.match(ui.text(words), /How to renew · \S/, 'with its cycle');
  assertTapFloor(line.props.style, 'the How to renew line', { square: false });
  assertTapFloor(portal.props.style, 'Renew online', { square: false });
  line.props.onClick({ stopPropagation: noop });
  ui.render();
  for (const a of ui.nodes().filter((n) => n.type === 'a')) assertTapFloor(a.props.style, `box link "${ui.text(a)}"`, { square: false });
});

// ── CRED-047: custom category ───────────────────────────────────────────────
test('CRED-047: Rename, Add a field, Hide category and the field editor\'s Save and Cancel are 32 px tall', async () => {
  const category = { id: 'C1', name: 'Synthetic Badges', icon: 'B', fields: [] };
  const ui = await mountComponent('src/components/features/CustomCategorySection.jsx', {
    app: app({ customCategories: [category, { id: 'C2', name: 'Synthetic Awards', icon: 'A', fields: [] }], customRecords: [] }, { canWriteCredential: true }),
    props: { categoryId: 'C1', onShare: noop },
    modules: { actionButton, customCategories: await import('../src/utils/customCategories.js') },
  });
  const named = (name) => ui.nodes().find((n) => n.type === 'button' && ui.text(n) === name);
  for (const name of ['Rename', 'Add a field', 'Hide category']) {
    assert.ok(named(name), name);
    assertTapFloor(named(name).props.style, name, { square: false });
  }
  named('Add a field').props.onClick();
  ui.render();
  for (const name of ['Save', 'Cancel']) {
    assert.ok(named(name), `${name} in the field editor`);
    assertTapFloor(named(name).props.style, name, { square: false });
  }
});

// ── The shared pieces ───────────────────────────────────────────────────────
test('a Field may shrink below its control, so any two-across row fits the phone', async () => {
  const src = await readFile(new URL('../src/components/shared/Field.jsx', import.meta.url), 'utf8');
  assert.match(src, /<div style=\{\{ marginBottom: 14, minWidth: 0 \}\}/);
  assert.equal(actionButton.TAP_MIN, FLOOR);
  assert.ok(actionButton.CARD_ACTION_GAP >= 6);
  assert.deepEqual([actionButton.cardActionSize.minWidth, actionButton.cardActionSize.minHeight], [FLOOR, FLOOR]);
});

// ── CRED-041: a peer reference's heads-up buttons ──────────────────────────
// Under each Peer References phone card, "Email Heads-Up" and "Text
// Heads-Up" were padding 4px 10px at 12 px text: 131x28 and 125x28, 6 px
// apart. CRED-001 took the card's own actions to the floor, not these.
test('CRED-041: a peer reference\'s Email Heads-Up and Text Heads-Up reach the 32 px floor', async () => {
  const shareText = await import('../src/utils/shareText.js');
  const ui = await mountComponent('src/components/features/PeerNotify.jsx', {
    app: app({ settings: { name: 'Synthetic Physician', degreeType: 'DO' } }),
    props: { peer: { id: 'ref-1', name: 'Jane Synthetic, MD', email: 'jane@example.invalid', phone: '555-010-0000' } },
    modules: { shareText, helpers, actionButton },
  });
  const entries = walk(ui.render());
  const buttons = entries.filter((e) => e.node.type === 'button' && /Heads-Up$/.test(ui.text(e.node).trim()));
  assert.deepEqual(buttons.map((e) => ui.text(e.node).replace(/^\S+\s/, '')), ['Email Heads-Up', 'Text Heads-Up']);
  for (const b of buttons) assertTapFloor(b.node.props.style, ui.text(b.node).trim(), { square: false });
  assert.ok(buttons[0].parents[0].props.style.gap >= 6, 'the two stay apart');
});
