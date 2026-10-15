import test from 'node:test';
import assert from 'node:assert/strict';
import { mountComponent } from './component-harness.mjs';
import * as helpers from '../src/utils/helpers.js';
import * as shareText from '../src/utils/shareText.js';
import * as shareHandoff from '../src/utils/shareHandoff.js';
import * as docLabel from '../src/utils/docLabel.js';
import * as outgoingText from '../src/utils/outgoingText.js';

async function fixture() {
  const state = { copy: async () => true, share: async () => {}, emails: [], texts: [], logs: [] };
  const app = { user: { id: 'synthetic-owner' }, theme: {}, data: { settings: { name: 'Synthetic Physician' }, shareLog: state.logs, documents: [] } };
  const ui = await mountComponent(process.env.SHARE_MODAL_SOURCE || 'src/components/features/ShareModal.jsx', {
    app, props: { open: true, section: 'licenses', linkedDocs: [], item: { id: 'synthetic-license', type: 'State Medical License', state: 'CO', licenseNumber: 'QA-ONLY' }, onLogShare: row => state.logs.push(row), onUnlogShare: id => { const at = state.logs.findIndex(row => row.id === id); if (at >= 0) state.logs.splice(at, 1); } },
    modules: { helpers: { ...helpers, copyToClipboard: text => state.copy(text) }, shareText, outgoingText, shareHandoff, docLabel,
      notifications: { composeText: (phone, body) => { state.texts.push({ phone, body }); return { truncated: false, copied: Promise.resolve(false) }; } } },
    globals: { window: { open: (...args) => state.emails.push(args) }, navigator: { share: data => state.share(data) } },
  });
  const click = label => {
    const button = ui.nodes().find(n => n.type === 'button' && ui.text(n) === label);
    assert.ok(button, `button ${label} is present`);
    return button.props.onClick();
  };
  return { ...state, state, app, ui, click };
}

test('opening Messages records a draft request without claiming delivery', async () => {
  const f = await fixture();
  f.click('Text');
  assert.equal(f.state.texts.length, 1);
  assert.equal(f.state.texts[0].phone, '');
  assert.match(f.state.texts[0].body, /QA-ONLY/);
  assert.equal(f.state.logs.length, 1);
  assert.equal(f.state.logs[0].method, 'text');
  assert.match(f.ui.pageText(), /Sharing activity.*do not confirm delivery.*Text draft requested/);
  assert.doesNotMatch(f.ui.pageText(), /Texted|Send history/);
});

test('Mail handoffs and historical server email entries do not guess delivery', async () => {
  const f = await fixture();
  f.state.logs.push({ id: 'historical-server', itemId: 'synthetic-license', method: 'email', recipient: 'staff@qa.credentialdomd.test', sentAt: '2026-10-01T00:00:00Z' });
  f.click('Email (opens Mail)');
  assert.equal(f.state.emails.length, 1);
  assert.match(f.state.emails[0][0], /^mailto:/);
  assert.equal(f.state.logs.length, 2);
  assert.equal((f.ui.pageText().match(/Email requested/g) || []).length, 2);
  assert.doesNotMatch(f.ui.pageText(), /Emailed|Texted/);
});

test('canceled and resolved native shares record requests without claiming completion', async () => {
  const f = await fixture();
  f.state.share = async () => { throw Object.assign(Error('synthetic canceled'), { name: 'AbortError' }); };
  await f.click('Send via Mail, Messages, AirDrop…');
  assert.equal(f.state.logs.length, 0);
  assert.doesNotMatch(f.ui.pageText(), /Device share completed/);
  f.state.share = async () => {};
  await f.click('Send via Mail, Messages, AirDrop…');
  assert.equal(f.state.logs.length, 1);
  assert.match(f.ui.pageText(), /Device share requested/);
});

test('an unanswered native share records exactly one request before its promise settles', async () => {
  const f = await fixture(); let finish;
  f.state.share = () => new Promise(resolve => { finish = resolve; });
  const pending = f.click('Send via Mail, Messages, AirDrop…');
  assert.equal(f.state.logs.length, 1);
  assert.equal(f.state.logs[0].method, 'share');
  assert.match(f.ui.pageText(), /Device share requested/);
  finish(); await pending;
  assert.equal(f.state.logs.length, 1);
});

test('a synchronous share refusal does not record a request', async () => {
  const f = await fixture();
  f.state.share = () => { throw new Error('synthetic unsupported device'); };
  await f.click('Send via Mail, Messages, AirDrop…');
  assert.equal(f.state.logs.length, 0);
});

test('late share completion cannot write or display activity in a replacement account', async () => {
  const f = await fixture(); let finish;
  f.state.share = () => new Promise(resolve => { finish = resolve; });
  const pending = f.click('Send via Mail, Messages, AirDrop…');
  const atHandoff = f.state.logs.length;
  f.app.user = { id: 'other-owner' }; f.app.data.shareLog = []; f.ui.render();
  finish(); await pending;
  assert.equal(atHandoff, 1);
  assert.equal(f.state.logs.length, 1);
  assert.doesNotMatch(f.ui.pageText(), /Opening…|Device share requested/);
});

test('late clipboard success cannot log in an account that replaced the initiating one', async () => {
  const f = await fixture(); let finish;
  f.state.copy = () => new Promise(resolve => { finish = resolve; });
  const pending = f.click('Copy');
  f.app.user = { id: 'other-owner' }; f.ui.render();
  finish(true); await pending;
  assert.equal(f.state.logs.length, 0);
  assert.doesNotMatch(f.ui.pageText(), /Copied!/);
});

test('handlers captured before account A to B to A cannot initiate a stale share', async () => {
  const f = await fixture(); let calls = 0;
  f.state.share = async () => { calls++; };
  const stale = f.ui.nodes().find(n => n.type === 'button' && /Send via Mail/.test(f.ui.text(n))).props.onClick;
  f.app.user = { id: 'other-owner' }; f.ui.render();
  f.app.user = { id: 'synthetic-owner' }; f.ui.render();
  await stale();
  assert.equal(calls, 0);
  assert.equal(f.state.logs.length, 0);
});

test('denied clipboard write never claims copied or writes sharing history', async () => {
  const f = await fixture(); f.state.copy = async () => false;
  await f.click('Copy');
  assert.equal(f.state.logs.length, 0);
  assert.match(f.ui.pageText(), /Could not copy/);
  assert.doesNotMatch(f.ui.pageText(), /Copied!/);
  f.state.copy = async () => true;
  await f.click('Copy');
  assert.equal(f.state.logs.length, 1);
  assert.equal(f.state.logs[0].method, 'clipboard');
  assert.match(f.ui.pageText(), /Copied!/);
  f.state.copy = async () => false;
  await f.click('Copied!');
  assert.equal(f.state.logs.length, 1);
  assert.doesNotMatch(f.ui.pageText(), /Copied!/);
});

test('late clipboard success cannot overwrite a newer denial or another credential', async () => {
  const f = await fixture(); let finish;
  f.state.copy = () => new Promise(resolve => { finish = resolve; });
  const pending = f.click('Copy');
  f.state.copy = async () => false;
  await f.click('Copy');
  finish(true); await pending;
  assert.equal(f.state.logs.length, 0);
  assert.match(f.ui.pageText(), /Could not copy/);
  assert.doesNotMatch(f.ui.pageText(), /Copied!/);
  f.state.copy = () => new Promise(resolve => { finish = resolve; });
  const previous = f.click('Copy');
  f.ui.setProps({ item: { id: 'other-license', type: 'Other credential' } });
  finish(true); await previous;
  assert.equal(f.state.logs.length, 0);
  assert.doesNotMatch(f.ui.pageText(), /Copied!|Could not copy/);
});
