import test from 'node:test';
import assert from 'node:assert/strict';
import { mountComponent } from '../component-harness.mjs';

for (const enabled of [false, true]) {
  test(`cancellation view retains records without a countdown when limited launch is ${enabled}`, async () => {
    const navigation = [], downloads = [], data = { settings: { cancelledAt: '2020-01-01T00:00:00Z' }, licenses: [{ id: 'synthetic' }] };
    const app = { data, theme: {}, navigate: (...args) => navigation.push(args), hasSubscription: true, isFreeBeta: false,
      limitedLaunch: { enabled, access: {} }, manage: () => navigation.push(['billing']) };
    const panel = await mountComponent('src/components/pages/CancellationPage.jsx', { app,
      modules: { credentialExport: { generateCredentialZip: async snapshot => { assert.equal(snapshot, data); return 'synthetic-zip'; }, downloadBlob: (...args) => downloads.push(args) } },
    });
    panel.render(); const text = panel.pageText();
    assert.match(text, /records.*(remain|stay).*available|Canceling a paid membership does not delete/s);
    assert.doesNotMatch(text, /scheduled job deletes|Data deletion scheduled|days remaining|day remaining|Reactivate before|before then/);
    if (enabled) {
      const exportButton = panel.nodes().find(n => n.type === 'button' && panel.text(n) === 'Export saved records');
      exportButton.props.onClick(); assert.deepEqual(navigation, [['more', 'export']]);
      assert.ok(panel.nodes().some(n => n.type === 'button' && panel.text(n) === 'Manage paid subscription'));
    } else {
      const exportButton = panel.nodes().find(n => n.type === 'button' && panel.text(n) === 'Export & Download My Data');
      await exportButton.props.onClick(); assert.equal(downloads.length, 1); assert.equal(downloads[0][0], 'synthetic-zip');
      const back = panel.nodes().find(n => n.type === 'button' && panel.text(n) === 'Back to app');
      back.props.onClick(); assert.deepEqual(navigation, [['more', null]]);
      assert.match(panel.pageText(), /Delete All My Data/);
    }
  });
}
