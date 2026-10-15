import test from 'node:test';
import assert from 'node:assert/strict';
import { mountVera } from './assistant-harness.mjs';
import { settle } from './component-harness.mjs';
import * as helpers from '../src/utils/helpers.js';
import * as inboxDocs from '../src/utils/inboxDocs.js';

const within = async promise => {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Vera stayed pending')), 300); })]); }
  finally { clearTimeout(timer); }
};
async function fixture({ share = () => new Promise(() => {}), copy = async () => true } = {}) {
  const owner = { current: 'profile-synthetic' }, shared = [];
  const v = await mountVera({
    data: { documents: [{ id: 'd1', name: 'synthetic.pdf', type: 'application/pdf', data: 'data:application/pdf;base64,JVBERi0=' }] },
    app: { userIdRef: owner },
    modules: { inboxDocs, helpers: { ...helpers, copyToClipboard: copy } },
    turn: async () => ({ reply: 'Synthetic packet', actions: [{ kind: 'send_packet', docIds: ['d1'], coverNote: 'Synthetic document attached.', summary: 'Synthetic packet' }] }),
    globals: { navigator: { userAgent: 'Synthetic', canShare: () => true, share: payload => { shared.push(payload); return share(payload); } } },
  });
  await v.ask('Prepare my packet'); await settle();
  return { v, owner, shared };
}
test('an unanswered Vera packet share records one request and releases the action button', async () => {
  const { v, shared } = await fixture();
  await within(v.button('Approve').props.onClick()); await settle();
  assert.equal(shared.length, 1);
  const logs = v.rec.of('addItem').filter(([, key]) => key === 'shareLog');
  assert.equal(logs.length, 1); assert.equal(logs[0][2].method, 'share');
  assert.match(v.pageText(), /✓ done.*Sharing requested.*Delivery is not confirmed/);
  assert.doesNotMatch(v.pageText(), /Working…/);
});
test('replacing the account while copying a Vera note prevents the old packet handoff', async () => {
  let finish; const { v, owner, shared } = await fixture({ copy: () => new Promise(resolve => { finish = resolve; }) });
  const pending = v.button('Approve').props.onClick();
  owner.current = 'other-profile'; v.render(); finish(true); await within(pending);
  assert.equal(shared.length, 0);
  assert.equal(v.rec.of('addItem').filter(([, key]) => key === 'shareLog').length, 0);
});
test('a late Vera share rejection cannot update another account or repeat the packet', async () => {
  let reject; const { v, owner, shared } = await fixture({ share: () => new Promise((_, r) => { reject = r; }) });
  await within(v.button('Approve').props.onClick());
  owner.current = 'other-profile'; v.render(); reject(Error('synthetic late refusal')); await settle();
  assert.equal(shared.length, 1);
  assert.doesNotMatch(v.pageText(), /device did not confirm/);
});
