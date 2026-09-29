// Admin > Emails (AdminWelcomeEmail.jsx): the owner reads the exact subject
// and every version of the welcome email, and "Approve and turn on" sends the
// server the fingerprint of exactly that content. The server decides who is
// an administrator (tests/welcome-email/sql.test.mjs); here a refusal is
// shown and never reported as a change. Synthetic I/O only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mountComponent, settle } from '../component-harness.mjs';
import * as welcomeEmail from '../../src/utils/welcomeEmail.js';

const FINGERPRINT = await welcomeEmail.welcomeEmailFingerprint();
// The page hashes the email with crypto.subtle, which can take longer than one
// settle() on a busy runner (CI failed 2026-09-29 while the Studio passed); the
// same content's fingerprint is handed over already computed.
const FAST_WELCOME = { ...welcomeEmail, welcomeEmailFingerprint: async () => FINGERPRINT };
const OFF = { enabled: false, enabledAt: null, approvedFingerprint: null, approvedVersion: null, approvedAt: null, approvedBy: null, senderFingerprint: null, senderCheckedAt: null, purchasesSinceOn: 0, sent: 0, notSent: 0, history: [] };
const ON = { ...OFF, enabled: true, enabledAt: '2026-09-29T15:00:00Z', approvedFingerprint: FINGERPRINT, approvedVersion: welcomeEmail.WELCOME_EMAIL_VERSION, approvedAt: '2026-09-29T15:00:00Z', approvedBy: 'Synthetic Owner',
  senderFingerprint: FINGERPRINT, senderCheckedAt: '2026-09-29T15:05:00Z',
  purchasesSinceOn: 3, sent: 2, notSent: 1, history: [{ action: 'approve', version: welcomeEmail.WELCOME_EMAIL_VERSION, fingerprint: FINGERPRINT, at: '2026-09-29T15:00:00Z', by: 'Synthetic Owner' }] };
const OTHER = 'e'.repeat(64);

async function mount(status = OFF, answers = {}) {
  const calls = [];
  const supabase = { rpc: async (name, args) => {
    calls.push({ name, args });
    if (name === 'admin_welcome_email_status') return typeof status === 'function' ? status() : { data: status, error: null };
    const answer = answers[name];
    return typeof answer === 'function' ? answer(args) : answer;
  } };
  const view = await mountComponent('src/components/pages/AdminWelcomeEmail.jsx', { modules: { supabase: { supabase }, welcomeEmail: FAST_WELCOME }, props: { T: {} } });
  view.render(); await settle(); view.render();
  const button = label => view.nodes().find(n => n.type === 'button' && view.text(n) === label);
  const checkbox = () => view.nodes().find(n => n.type === 'input' && n.props.type === 'checkbox');
  return { ...view, calls, button, checkbox };
}

test('shows the sender, the subject and every version of the body exactly as members receive it', async () => {
  const v = await mount();
  const page = v.pageText();
  for (const part of ['From: CredentialDOMD <whit@credentialdomd.com>', 'Reply to: support@credentialdomd.com', 'Subject: Welcome to CredentialDOMD', FINGERPRINT.slice(0, 12)]) assert.ok(page.includes(part), part);
  const bodies = v.nodes().filter(n => n.type === 'pre').map(n => v.text(n));
  assert.deepEqual(bodies, welcomeEmail.welcomeEmailPreview().map(p => p.text));
  assert.deepEqual(v.nodes().filter(n => n.type === 'article').map(n => n.props['aria-label']), welcomeEmail.welcomeEmailPreview().map(p => p.label));
  assert.match(page, /Off\. No welcome email is sent\./);
  assert.match(page, /Never for gifts, free betas or unpaid checkouts/);
});

test('approval needs the review tick, then sends the fingerprint of exactly this content', async () => {
  const v = await mount(OFF, { admin_set_welcome_email: { data: ON, error: null } });
  assert.equal(v.button('Approve and turn on').props.disabled, true, 'not before the review tick');
  await v.button('Approve and turn on').props.onClick();
  assert.equal(v.calls.filter(c => c.name === 'admin_set_welcome_email').length, 0);
  v.checkbox().props.onChange({ target: { checked: true } }); v.render();
  assert.equal(v.button('Approve and turn on').props.disabled, false);
  await v.button('Approve and turn on').props.onClick(); await settle(); v.render();
  const set = v.calls.filter(c => c.name === 'admin_set_welcome_email');
  assert.deepEqual(set.map(c => ({ ...c.args })), [{ p_enabled: true, p_fingerprint: FINGERPRINT, p_version: welcomeEmail.WELCOME_EMAIL_VERSION }]);
  const page = v.pageText();
  assert.match(page, /On\./);
  assert.match(page, /by Synthetic Owner/);
  assert.match(page, /Paid purchases since it was turned on: 3\. Sent: 2\. Not sent: 1\./);
  assert.match(page, /The deployed webhook holds the approved email \(last checked/);
  assert.equal(v.button('Approve and turn on').props.disabled, true, 'already approved');
  assert.equal(v.checkbox().props.checked, false);
});

test('Turn off sends no content, and the server\'s answer is what the page shows', async () => {
  const v = await mount(ON, { admin_set_welcome_email: { data: { ...ON, enabled: false }, error: null } });
  await v.button('Turn off').props.onClick(); await settle(); v.render();
  assert.deepEqual(v.calls.filter(c => c.name === 'admin_set_welcome_email').map(c => ({ ...c.args })), [{ p_enabled: false, p_fingerprint: null, p_version: null }]);
  assert.match(v.pageText(), /Off\. No welcome email is sent\. Last approved/);
  assert.equal(v.button('Turn off'), undefined);
});

test('a refusal (not an administrator) is shown and nothing is reported as changed', async () => {
  const v = await mount(OFF, { admin_set_welcome_email: { data: null, error: { message: 'Administrator access required' } } });
  v.checkbox().props.onChange({ target: { checked: true } }); v.render();
  await v.button('Approve and turn on').props.onClick(); await settle(); v.render();
  const alert = v.nodes().find(n => n.props?.role === 'alert');
  assert.equal(v.text(alert), 'Administrator access required');
  assert.match(v.pageText(), /Off\./);
});

test('an answer that does not confirm this exact content is not taken as approval', async () => {
  const v = await mount(OFF, { admin_set_welcome_email: { data: { ...ON, approvedFingerprint: 'e'.repeat(64) }, error: null } });
  v.checkbox().props.onChange({ target: { checked: true } }); v.render();
  await v.button('Approve and turn on').props.onClick(); await settle(); v.render();
  assert.match(v.text(v.nodes().find(n => n.props?.role === 'alert')), /did not confirm the change/);
  assert.match(v.pageText(), /Off\./);
});

test('on for a different version says so, and offers to approve the one shown', async () => {
  // The webhook still holds (and sends) the approved one; this page shows newer wording.
  const v = await mount({ ...ON, approvedFingerprint: 'a'.repeat(64), senderFingerprint: 'a'.repeat(64) });
  assert.match(v.pageText(), /On, but not for the email shown here\./);
  v.checkbox().props.onChange({ target: { checked: true } }); v.render();
  assert.equal(v.button('Approve and turn on').props.disabled, false);
});

test('a status that cannot be read is an error, never "Off"', async () => {
  const v = await mount(() => ({ data: null, error: { message: 'Administrator access required' } }));
  assert.equal(v.text(v.nodes().find(n => n.props?.role === 'alert')), 'Administrator access required');
  assert.doesNotMatch(v.pageText(), /Off\./);
});

test('Admin has an Emails tab that renders the panel and loads no list', () => {
  const dashboard = fs.readFileSync(new URL('../../src/components/pages/AdminDashboard.jsx', import.meta.url), 'utf8');
  assert.match(dashboard, /\{ id: "emails", label: "Emails" \}/);
  assert.match(dashboard, /\{tab === "emails" && <AdminWelcomeEmail T=\{T\} \/>\}/);
});

// The browser's fingerprint comes from its own (possibly cached) bundle, and
// the webhook deploys separately. When the two differ every claim is refused
// and no ledger row is written, so only the server's report can show it.
test('the deployed webhook holding other wording is "nothing is sending", never "On."', async () => {
  const v = await mount({ ...ON, senderFingerprint: OTHER, purchasesSinceOn: 4, sent: 0, notSent: 4 });
  const page = v.pageText();
  assert.match(page, /On, but nothing is sending\./);
  assert.doesNotMatch(page, /On\. Approved/);
  assert.match(page, new RegExp(`fingerprint ${OTHER.slice(0, 12)}, last checked [^)]+\\) from the approved one \\(${FINGERPRINT.slice(0, 12)}\\)`));
  assert.match(page, /Deploy limited-stripe-webhook from the same commit as the app, then reload this page\./);
  assert.match(page, /still sent once the two match, up to 72 hours after payment/);
  assert.match(page, /Not sent: 4\./);
  assert.equal(v.button('Approve and turn on').props.disabled, true, 'the email shown here is already the approved one: the fix is a deploy');
});

test('a stale approval from a cached page: the webhook holds the email shown here, so it can be approved', async () => {
  const v = await mount({ ...ON, approvedFingerprint: OTHER, senderFingerprint: FINGERPRINT });
  assert.match(v.pageText(), /On, but nothing is sending\..*It holds the email shown here; approve it below if it is right\./s);
  v.checkbox().props.onChange({ target: { checked: true } }); v.render();
  assert.equal(v.button('Approve and turn on').props.disabled, false);
});

test('before the webhook has reported its copy, the page says so instead of confirming it', async () => {
  const v = await mount({ ...ON, senderFingerprint: null, senderCheckedAt: null });
  assert.match(v.pageText(), /On\. Approved .* The deployed webhook has not reported which email it holds yet; it checks in every 10 minutes\./s);
});

test('while off, the page says whether the deployed webhook holds the email shown here', async () => {
  const same = await mount({ ...OFF, senderFingerprint: FINGERPRINT, senderCheckedAt: '2026-09-29T15:05:00Z' });
  assert.match(same.pageText(), /Off\. No welcome email is sent\. The deployed webhook holds the email shown here\./);
  const differs = await mount({ ...OFF, senderFingerprint: OTHER, senderCheckedAt: '2026-09-29T15:05:00Z' });
  assert.match(differs.pageText(), new RegExp(`holds a different email \\(fingerprint ${OTHER.slice(0, 12)}\\); deploy limited-stripe-webhook`));
});
