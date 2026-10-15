import test from 'node:test';
import assert from 'node:assert/strict';
import { loadScreens, mount, nodes, textOf } from './harness/component-harness.mjs';

const { CrudSection, HealthRecordsSection } = await loadScreens(`
  export { default as CrudSection } from "./src/components/features/CrudSection.jsx";
  export { default as HealthRecordsSection } from "./src/components/features/HealthRecordsSection.jsx";
`);
function card(sectionKey, value) {
  const item = { id: 'synthetic-card', ...value }, before = structuredClone(item);
  const m = mount(sectionKey === 'healthRecords' ? HealthRecordsSection : CrudSection, {
    data: { settings: { name: 'Jordan Tester', degreeType: 'MD' }, [sectionKey]: [item] },
    props: { sectionKey, title: 'Synthetic records', items: [item], fields: [], favoritable: true,
      onAdd() {}, onEdit() {}, onDelete() {}, onShare() {} } });
  globalThis.__screen.app.toggleFavorite = () => {};
  const tree = m.render();
  const titles = nodes(tree).filter(n => n.type === 'div' && n.props?.style?.fontSize === 15 && n.props?.style?.fontWeight === 600).map(textOf);
  const html = m.html();
  assert.deepEqual(item, before, 'presentation never rewrites the saved record');
  assert.deepEqual(m.calls, [], 'rendering never stores or edits a record');
  return { titles, html };
}

test('the actual editable phone license card shows CO below its complete type, without a leading comma', () => {
  const shown = card('licenses', { type: 'State Medical License', state: 'CO', name: 'QA Phone CO License', licenseNumber: 'QA-PHL-4410' });
  assert.deepEqual(shown.titles, ['CO']);
  assert.match(shown.html, />State Medical License<\/div>/);
  assert.match(shown.html, />CO<\/div>/);
  assert.doesNotMatch(shown.html, />, CO<\/div>/);
  assert.match(shown.html, /QA-PHL-4410/);
});

test('the actual health-record card removes its structural comma while retaining provider punctuation', () => {
  const shown = card('healthRecords', { category: 'Vaccination', type: 'Influenza', provider: 'Mercy, Inc. — West' });
  assert.deepEqual(shown.titles, ['Mercy, Inc. — West']);
  assert.match(shown.html, />Influenza<\/span>/);
});

for (const [section, item, expected] of [
  ['insurance', { type: 'Malpractice', provider: 'Mercy, Inc. — West' }, 'Mercy, Inc. — West'],
  ['privileges', { type: 'Surgical Privileges', facility: 'Mercy, North' }, 'Mercy, North'],
  ['education', { type: 'Fellowship', name: 'Fellowship, Clinical, Research' }, 'Clinical, Research'],
  ['education', { type: 'Fellowship', name: 'Fellowship — Clinical, Research' }, 'Clinical, Research'],
  ['education', { type: 'Fellowship', name: 'Fellowship · Clinical, Research' }, 'Clinical, Research'],
  ['education', { type: 'Fellowship', name: 'FELLOWSHIP, Clinical' }, 'Clinical'],
  ['education', { type: 'Fellowship', name: 'Fellowship, , Clinical' }, ', Clinical'],
]) test(`editable ${section} removes one structural type separator while keeping detail punctuation: ${expected}`, () => {
  assert.deepEqual(card(section, item).titles, [expected]);
});

for (const name of ['Fellowship, Neurosurgery', 'Fellowship in Neurosurgery', ', Fellowship, Clinical']) {
  test(`a meaningful display title is not shortened merely because it shares a type prefix: ${name}`, () => {
    const type = name.startsWith('Fellowship in') ? 'Fellowship' : 'Fellow';
    assert.deepEqual(card('education', { type, name }).titles, [name]);
  });
}

for (const [section, item] of [
  ['licenses', { type: 'Certification' }],
  ['healthRecords', { category: 'Vaccination', type: 'Influenza' }],
]) test(`a type-only ${section} card keeps its header without an empty or duplicate detail line`, () => {
  const shown = card(section, item);
  assert.deepEqual(shown.titles, []);
  assert.ok(shown.html.includes(item.type));
});

test('a title without a type keeps its leading and internal punctuation', () => {
  assert.deepEqual(card('education', { name: ', Clinical, Research — Fellowship' }).titles, [', Clinical, Research — Fellowship']);
});
