// At desk width the Licenses list is a table with no room for a row's
// renewal block, so a row's detail view carries it. Synthetic records only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mountComponent } from '../component-harness.mjs';

const license = { id: 'lic-1', type: 'State Medical License (MD)', state: 'CO', licenseNumber: 'SYN-1', expirationDate: '2027-04-30' };
const mount = async (isDesktop) => mountComponent('src/components/features/CrudSection.jsx', {
  app: { data: { settings: {}, documents: [], followUps: [] }, theme: {}, isDesktop, addItem() {}, editItem() {}, toggleFavorite() {} },
  props: {
    title: 'Licenses', sectionKey: 'licenses', items: [license],
    fields: [{ key: 'licenseNumber', label: 'Number' }],
    deskColumns: [{ key: 'licenseNumber', label: 'Number' }],
    renderExtra: (item) => ({ type: 'RenewalInfo', props: { item, children: 'How to renew' } }),
    autoViewId: 'lic-1', onAutoViewDone() {},
  },
  modules: { helpers: await import('../../src/utils/helpers.js'), lifecycle: await import('../../src/utils/lifecycle.js'), caseBilling: await import('../../src/utils/caseBilling.js'), formLayout: await import('../../src/utils/formLayout.js') },
});
const detail = m => m.nodes().filter(n => n.type?.name === 'Modal' && n.props.open);

test('a license opened at desk width shows How to renew in its detail view', async () => {
  const m = await mount(true);
  const open = detail(m);
  assert.equal(open.length, 1, 'the detail view is open');
  assert.match(m.text(open[0]), /How to renew/);
});

test('on a phone the card already carries it, so the detail view does not repeat it', async () => {
  const m = await mount(false);
  assert.doesNotMatch(m.text(detail(m)[0]), /How to renew/);
});
