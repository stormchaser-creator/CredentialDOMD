import test from 'node:test';
import assert from 'node:assert/strict';
import { mountComponent, settle } from './component-harness.mjs';

for (const returnValue of [null, {}]) {
  test(`backup download offers truthful fallback when window.open returns ${returnValue === null ? 'null' : 'a window'}`, async () => {
    const url = 'https://storage.example.test/private-backup.zip?token=synthetic';
    const row = { id: 'backup-a', period: '2026-09', status: 'ready', created_at: '2026-09-30T12:00:00Z' };
    const opened = [];
    const panel = await mountComponent('src/components/features/BackupPanel.jsx', {
      app: { data: { settings: { email: 'synthetic@example.test' } }, theme: {}, updateSettings() {} },
      modules: { supabase: { supabase: {
        from: () => ({ select: () => ({ order: () => ({ limit: async () => ({ data: [row], error: null }) }) }) }),
        functions: { invoke: async (name, options) => {
          assert.equal(name, 'backup-link'); assert.equal(options.body.backup_id, row.id);
          return { data: { url }, error: null };
        } },
      } } },
      globals: { window: { open: (...args) => { opened.push(args); return returnValue; } } },
    });
    panel.render(); await settle();
    const button = panel.nodes().find(n => n.type === 'button' && panel.text(n) === 'Download');
    assert.ok(button);
    await button.props.onClick();
    assert.deepEqual(opened, [[url, '_blank', 'noopener,noreferrer']]);
    assert.doesNotMatch(panel.pageText(), /Your browser blocked/);
    const fallback = panel.nodes().find(n => n.type === 'a' && panel.text(n) === 'Open the download');
    if (returnValue === null) {
      assert.match(panel.pageText(), /If the download did not start/);
      assert.equal(fallback.props.href, url);
      assert.equal(fallback.props.rel, 'noopener noreferrer');
      for (const expire of panel.timers) expire();
      assert.equal(panel.nodes().some(n => n.type === 'a' && panel.text(n) === 'Open the download'), false, 'expired links are still removed');
    } else assert.equal(fallback, undefined);
  });
}
