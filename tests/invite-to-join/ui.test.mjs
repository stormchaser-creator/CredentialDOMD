// The Admin "Invite to join" card, rendered with a fake transport: the owner
// sees the exact subject and body before anything is sent, success is shown
// only for a confirmed send with the provider id, a refusal is shown in the
// error colour with its reason, and the button is disabled while sending.
// Synthetic values only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { mountComponent, settle } from '../component-harness.mjs';

const T = { text: '#111111', textMuted: '#555555', input: '#eeeeee', border: '#cccccc', accent: '#008800', card: '#ffffff', danger: '#dd0000', success: '#006600' };
const EMAIL = { from: '"Synthetic Owner, DO" <whit@credentialdomd.com>', to: 'new.doctor@example.com', replyTo: 'owner@example.invalid',
  subject: 'Synthetic Owner, DO invited you to join CredentialDOMD',
  text: 'Hello Jane Synthetic,\n\nSynthetic Owner, DO invited you to join CredentialDOMD.\n\nThe founding membership is $99/year for the first 100 paid members.' };
const PREVIEW = { email: EMAIL, name: 'Jane Synthetic', history: { lastSentAt: null, cooldownUntil: null, sentInWindow: 4, dailyCap: 20 } };
const deferred = () => { let resolve, reject; const promise = new Promise((r, j) => { resolve = r; reject = j; }); return { promise, resolve, reject }; };
// Objects built inside the component's vm realm compare by value only after a copy.
const plain = value => JSON.parse(JSON.stringify(value));
const refusal = (code, message, extra = {}) => Object.assign(new Error(message), { code, extra });

function fakeClient(over = {}) {
  const calls = [];
  const client = {
    preview: async input => { calls.push(['preview', input]); return over.preview ? over.preview(input) : PREVIEW; },
    send: async (preview, options) => { calls.push(['send', preview, options]); return over.send ? over.send(preview, options)
      : { id: '11111111-1111-4111-8111-111111111111', to: preview.email.to, providerId: 're_synthetic123', sentAt: '2026-09-29T15:00:00.000Z' }; },
    list: async () => { calls.push(['list']); return over.list ? over.list() : []; },
  };
  return { client, calls };
}
async function mount(over = {}, props = {}) {
  const f = fakeClient(over);
  const view = await mountComponent('src/components/pages/AdminInviteToJoin.jsx', {
    modules: { inviteToJoinClient: { createInviteToJoinClient: () => f.client } },
    app: { theme: T, user: { id: 'user_syntheticAdmin' } }, props,
  });
  view.render(); await settle(); view.render();
  const find = predicate => view.nodes().find(predicate);
  const input = label => find(n => n.type === 'input' && n.props['aria-label'] === label);
  const button = pattern => find(n => n.type === 'button' && pattern.test(view.text(n)));
  const type = async (label, value) => { input(label).props.onChange({ target: { value } }); view.render(); };
  const preview = async () => { find(n => n.type === 'form').props.onSubmit({ preventDefault() {} }); await settle(); view.render(); };
  const section = () => find(n => n.type === 'section' && n.props['aria-label'] === 'Email preview');
  const note = () => find(n => n.type === 'p' && ['alert', 'status'].includes(n.props.role) && !/Recent invitations/.test(view.text(n)));
  return { ...view, ...f, find, input, button, type, preview, section, note };
}

test('the preview shows the exact from, to, reply-to, subject and body the server will send, and sends nothing', async () => {
  const v = await mount();
  assert.deepEqual(v.calls, [['list']]);
  assert.equal(v.section(), undefined, 'no preview before the owner asks');
  await v.type('Name (optional)', 'Jane Synthetic');
  await v.type('Email address to invite', 'new.doctor@example.com');
  await v.preview();
  assert.deepEqual(plain(v.calls.at(-1)), ['preview', { email: 'new.doctor@example.com', name: 'Jane Synthetic' }]);
  const section = v.section();
  assert.ok(section, 'the preview is on screen');
  const shown = v.text(section);
  for (const line of [`From: ${EMAIL.from}`, `To: ${EMAIL.to}`, `Reply-to: ${EMAIL.replyTo}`, `Subject: ${EMAIL.subject}`]) assert.ok(shown.includes(line), line);
  const pre = v.nodes(section).find(n => n.type === 'pre');
  assert.equal(v.text(pre), EMAIL.text, 'the body is shown verbatim');
  assert.equal(pre.props.style.whiteSpace, 'pre-wrap', 'line breaks shown as sent');
  assert.match(shown, /4 of 20 invitations sent in the last 24 hours/);
  assert.ok(!v.calls.some(c => c[0] === 'send'));
});

test('send is disabled while sending, cannot fire twice, and success names the provider id', async () => {
  const held = deferred();
  const v = await mount({ send: () => held.promise });
  await v.type('Email address to invite', 'new.doctor@example.com');
  await v.preview();
  const send = v.button(/^Send to new\.doctor@example\.com$/);
  assert.equal(send.props.disabled, false);
  const first = send.props.onClick(); v.render();
  assert.equal(v.button(/^Sending\.\.\.$/).props.disabled, true, 'disabled while sending');
  await v.button(/^Sending\.\.\.$/).props.onClick();
  assert.equal(v.calls.filter(c => c[0] === 'send').length, 1, 'one request for two taps');
  assert.equal(v.find(n => n.type === 'button' && /Preview email|Preparing/.test(v.text(n))).props.disabled, true);
  assert.equal(v.input('Email address to invite').props.disabled, true);
  held.resolve({ id: '11111111-1111-4111-8111-111111111111', to: 'new.doctor@example.com', providerId: 're_synthetic123', sentAt: '2026-09-29T15:00:00.000Z' });
  await first; await settle(); v.render();
  const note = v.note();
  assert.equal(note.props.role, 'status');
  assert.equal(note.props.style.color, T.success);
  assert.match(v.text(note), /^Sent to new\.doctor@example\.com\. The email service accepted it \(id re_synthetic123\)\./);
  assert.equal(v.section(), undefined, 'the sent preview is cleared');
  assert.equal(v.input('Email address to invite').props.value, '');
  assert.equal(v.calls.filter(c => c[0] === 'list').length, 2, 'the recent list is refreshed');
});

test('a refusal is shown in the error colour with its reason, and never as a success', async () => {
  for (const error of [
    refusal('daily_cap', 'The daily limit of 20 invitations is used up. Nothing was sent.'),
    refusal('provider_refused', 'The email service refused this invitation, so it was not sent. Check the address and try again.'),
    refusal('provider_unconfirmed', 'The email service did not confirm this invitation. It may or may not have gone out, so check with the person before sending again.'),
  ]) {
    const v = await mount({ send: async () => { throw error; } });
    await v.type('Email address to invite', 'new.doctor@example.com');
    await v.preview();
    await v.button(/^Send to/).props.onClick(); await settle(); v.render();
    const note = v.note();
    assert.equal(note.props.role, 'alert');
    assert.equal(note.props.style.color, T.danger);
    assert.equal(v.text(note), error.message);
    assert.doesNotMatch(v.pageText(), /Sent to new\.doctor/);
    assert.ok(v.section(), 'the preview stays so the owner can retry or change it');
  }
  // A preview refusal is shown the same way.
  const v = await mount({ preview: async () => { throw refusal('offer_unavailable', 'The current membership price could not be confirmed, so the invitation was not written. Nothing was sent. Try again in a minute.'); } });
  await v.type('Email address to invite', 'new.doctor@example.com');
  await v.preview();
  assert.equal(v.note().props.role, 'alert'); assert.equal(v.note().props.style.color, T.danger);
  assert.equal(v.section(), undefined);
});

test('an address invited in the last 24 hours needs the explicit "send again" choice', async () => {
  const v = await mount({ preview: async () => ({ ...PREVIEW, history: { ...PREVIEW.history, lastSentAt: '2026-09-29T09:00:00.000Z', cooldownUntil: '2026-09-30T09:00:00.000Z' } }) });
  await v.type('Email address to invite', 'new.doctor@example.com');
  await v.preview();
  assert.match(v.text(v.section()), /Already invited on .*Send again anyway\./);
  assert.equal(v.button(/^Send to/).props.disabled, true);
  await v.button(/^Send to/).props.onClick();
  assert.ok(!v.calls.some(c => c[0] === 'send'));
  v.find(n => n.type === 'input' && n.props.type === 'checkbox').props.onChange({ target: { checked: true } }); v.render();
  assert.equal(v.button(/^Send to/).props.disabled, false);
  await v.button(/^Send to/).props.onClick(); await settle();
  assert.deepEqual(plain(v.calls.find(c => c[0] === 'send')[2]), { resend: true });
});

test('a cooldown found only at send time asks for the same explicit choice', async () => {
  let refused = false;
  const v = await mount({ send: async (_p, options) => {
    if (!options.resend) { refused = true; throw refusal('recently_invited', 'This address was already invited. Nothing was sent.', { lastSentAt: '2026-09-29T09:00:00.000Z' }); }
    return { id: '11111111-1111-4111-8111-111111111111', to: 'new.doctor@example.com', providerId: 're_again', sentAt: '2026-09-29T15:00:00.000Z' };
  } });
  await v.type('Email address to invite', 'new.doctor@example.com');
  await v.preview();
  await v.button(/^Send to/).props.onClick(); await settle(); v.render();
  assert.ok(refused);
  assert.equal(v.button(/^Send to/).props.disabled, true);
  v.find(n => n.type === 'input' && n.props.type === 'checkbox').props.onChange({ target: { checked: true } }); v.render();
  await v.button(/^Send to/).props.onClick(); await settle(); v.render();
  assert.match(v.text(v.note()), /re_again/);
});

test('a preview made stale by a changed offer is replaced by the new wording, and editing clears the preview', async () => {
  const fresh = { ...EMAIL, text: EMAIL.text.replace('$99', '$149') };
  const v = await mount({ send: async () => { throw refusal('preview_stale', 'The wording changed since your preview.', { email: fresh }); } });
  await v.type('Email address to invite', 'new.doctor@example.com');
  await v.preview();
  await v.button(/^Send to/).props.onClick(); await settle(); v.render();
  assert.equal(v.text(v.nodes(v.section()).find(n => n.type === 'pre')), fresh.text);
  await v.type('Email address to invite', 'other@example.com');
  assert.equal(v.section(), undefined, 'any edit needs a new preview');
});

test('a recent list that cannot load says so, and never reads like a failed send', async () => {
  const listLine = v => v.find(n => n.type === 'p' && n.props.role === 'status' && /Recent invitations/.test(v.text(n)));
  // The client's default message is about a send; the list must not reuse it.
  const unconfirmed = refusal('invite_unavailable', 'The invitation could not be confirmed. Nothing is known to have been sent. Refresh the list before trying again.');
  for (const [error, expected] of [
    [unconfirmed, 'Recent invitations could not be loaded. Open Users again in a minute to retry.'],
    [Object.assign(new Error('The invitation could not be confirmed.'), { code: undefined }), 'Recent invitations could not be loaded. Open Users again in a minute to retry.'],
    [refusal('admin_required', 'Only an authorized administrator can send invitations. Nothing was sent.'), 'Recent invitations could not be loaded: only an authorized administrator can see them.'],
    [refusal('session_changed', 'Your sign-in changed. Reopen Admin and try again. Nothing was sent.'), 'Recent invitations could not be loaded because your sign-in changed. Reopen Admin and try again.'],
    [refusal('not_configured', 'Invitation email is not set up on the server yet. Nothing was sent.'), 'Recent invitations could not be loaded: invitation email is not set up on the server yet.'],
  ]) {
    const v = await mount({ list: async () => { throw error; } });
    assert.equal(v.text(listLine(v)), expected, error.code);
    assert.doesNotMatch(v.pageText(), /could not be confirmed|Nothing is known to have been sent|Nothing was sent|Refresh the list/);
    assert.equal(v.note(), undefined, 'no send note on a page where nothing was sent');
  }
});

test('the dialog version is prefilled and does not load the recent list', async () => {
  const v = await mount({}, { embedded: true, initialName: 'Waitlist Person', initialEmail: 'lead@example.com' });
  assert.deepEqual(v.calls, []);
  assert.equal(v.input('Email address to invite').props.value, 'lead@example.com');
  assert.equal(v.input('Name (optional)').props.value, 'Waitlist Person');
  await v.preview();
  assert.deepEqual(plain(v.calls), [['preview', { email: 'lead@example.com', name: 'Waitlist Person' }]]);
});

test('Admin wires Invite to join into Users and Waitlist, and leaves the lifetime gift untouched', async () => {
  const admin = await readFile(new URL('../../src/components/pages/AdminDashboard.jsx', import.meta.url), 'utf8');
  const users = admin.slice(admin.indexOf('function UsersPanel('), admin.indexOf('function WaitlistList('));
  const waitlist = admin.slice(admin.indexOf('function WaitlistList('));
  assert.match(users, /<AdminLifetimeGift \/>\n\s*<AdminInviteToJoin \/>/);
  assert.match(users, /chip\("Invite to join", T\.accent, \(\) => setJoinTarget\(\{ name: inv\.name \|\| "", email: inv\.email \}\), false\)/);
  assert.match(users, /<AdminInviteToJoin key=\{joinTarget\.email\} embedded initialName=\{joinTarget\.name\} initialEmail=\{joinTarget\.email\} \/>/);
  assert.match(waitlist, />Invite to join<\/button>/);
  assert.match(waitlist, /<AdminInviteToJoin key=\{joinTarget\.email\} embedded/);
  assert.doesNotMatch(admin, /send-invite|sendInvite|Re-send email|"Re-invite"|Invite a physician/);
  const gift = await readFile(new URL('../../src/components/pages/AdminLifetimeGift.jsx', import.meta.url), 'utf8');
  assert.match(gift, /Gift lifetime access by email/);
});
