// The welcome email's exact content (src/utils/welcomeEmail.js): what each
// member is told their membership includes, the three first steps, help, the
// money-back guarantee as the app states it, the app link, and the
// fingerprint the owner's approval is bound to. Synthetic names only.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import * as app from '../../src/utils/welcomeEmail.js';
import * as shared from '../../supabase/functions/_shared/app/utils/welcomeEmail.js';
import { DEFAULT_SETTINGS } from '../../src/constants/defaults.js';
import { emailRemindersOn } from '../../src/utils/reminderPreferences.js';

const { composeWelcomeEmail, welcomeEmailPreview, welcomeEmailFingerprint, welcomeEmailCanonical, welcomeFirstName, WELCOME_VARIANTS } = app;
const body = (variant, name = 'Jordan') => composeWelcomeEmail({ name, variant }).text;

const INCLUDES = {
  founding: 'Your membership includes Credential and Practice for as long as you remain a member.',
  trial: 'Your membership includes Credential, plus a 30-day Practice trial that started with your payment.',
  bundle: 'Your membership includes both Credential and Practice.',
  credential: 'Your membership includes Credential. If you would like Practice as well,',
};

test('every version: the product sender, replies to support, one plain subject', () => {
  assert.deepEqual(WELCOME_VARIANTS, ['founding', 'trial', 'bundle', 'credential']);
  for (const variant of WELCOME_VARIANTS) {
    const message = composeWelcomeEmail({ name: 'Jordan', variant });
    assert.equal(message.from, 'CredentialDOMD <whit@credentialdomd.com>');
    assert.equal(message.replyTo, 'support@credentialdomd.com');
    assert.equal(message.subject, 'Welcome to CredentialDOMD');
    assert.ok(Object.isFrozen(message));
  }
});

test('content per offer: each version says exactly what that membership includes, and no other version\'s terms', () => {
  for (const variant of WELCOME_VARIANTS) {
    const text = body(variant);
    for (const [other, sentence] of Object.entries(INCLUDES)) {
      assert.equal(text.includes(sentence), other === variant, `${variant} ${other === variant ? 'states' : 'must not state'}: ${sentence}`);
    }
  }
  assert.match(body('founding'), /Thank you for becoming a founding member\./);
  for (const variant of ['trial', 'bundle', 'credential']) assert.doesNotMatch(body(variant), /founding/i, `${variant} is not a founding membership`);
  assert.match(body('trial'), /never charges you or upgrades on its own/);
  assert.doesNotMatch(body('bundle'), /trial/i);
  assert.doesNotMatch(body('founding'), /trial/i, 'founding members have Practice with no trial clock (20260928190000)');
});

test('the three first steps, help, the guarantee and the app link, in that order', () => {
  for (const variant of WELCOME_VARIANTS) {
    const text = body(variant);
    const order = ['Three good first steps:', '1. Add a license.', '2. Upload a document', 'docs@credentialdomd.com', '3. Check your renewal reminders.',
      'Need help? Use Get help in the app, or write to support@credentialdomd.com.', app.WELCOME_MONEY_BACK, 'Open the app: https://credentialdomd.com/app/', 'CredentialDOMD'];
    let at = -1;
    for (const part of order) { const next = text.indexOf(part, at + 1); assert.ok(next > at, `${variant}: "${part}" in order`); at = next; }
    assert.ok(text.endsWith('\n\nCredentialDOMD'));
  }
});

test('the guarantee is the sentence the membership offer shows in the app', () => {
  const page = fs.readFileSync(new URL('../../src/components/pages/LimitedLaunchMembership.jsx', import.meta.url), 'utf8');
  const line = page.split('\n').find(l => l.includes('100% no-hassle money-back guarantee'));
  assert.ok(line, 'the in-app guarantee line');
  const inApp = line.replace(/<a [^>]*>([^<]*)<\/a>/g, '$1').replace(/<\/?p>/g, '').trim();
  assert.equal(app.WELCOME_MONEY_BACK, inApp);
});

test('no em dashes, en dashes or markup anywhere the owner reviews or a member reads', () => {
  for (const item of welcomeEmailPreview()) {
    for (const field of [item.label, item.subject, item.from, item.replyTo, item.text]) {
      assert.doesNotMatch(field, /[\u2014\u2013]/, `${item.variant}: ${field.slice(0, 40)}`);
      assert.doesNotMatch(field.replace(item.from, ''), /<[a-z/]/i, 'plain text');
    }
  }
  assert.doesNotMatch(fs.readFileSync(new URL('../../src/components/pages/AdminWelcomeEmail.jsx', import.meta.url), 'utf8'), /\u2014/);
});

test('greeted by first name from the profile name; a missing or unusable name is greeted "Hello,"', () => {
  const cases = [['Jordan Rivera', 'Jordan'], ['Dr. Jordan Rivera, MD', 'Jordan'], ['dr jordan', 'Jordan'], ['JORDAN RIVERA', 'Jordan'],
    ['mary-kate o\'neil', 'Mary-Kate'], ['McKenzie Hale', 'McKenzie'], ['Ana María Soto', 'Ana'], ['Zoë', 'Zoë'],
    ['J.', null], ['J', null], ['MD', null], ['Dr.', null], ['', null], ['   ', null], [null, null], [42, null],
    ['<script>', null], ['Jordan\u0000', null], ['user@example.invalid', null], ['1234', null]];
  for (const [name, first] of cases) assert.equal(welcomeFirstName(name), first, JSON.stringify(name));
  assert.ok(body('founding', 'Dr. Jordan Rivera').startsWith('Hi Jordan,\n\n'));
  for (const name of [null, '', 'J.', '<b>x</b>']) assert.ok(body('bundle', name).startsWith('Hello,\n\n'), JSON.stringify(name));
});

test('an unknown version is refused, including inherited names', () => {
  for (const variant of [undefined, '', 'lifetime', 'gift', 'beta', 'constructor', 'toString', '__proto__', 'hasOwnProperty']) {
    assert.throws(() => composeWelcomeEmail({ name: 'Jordan', variant }), /Unknown welcome email version/, String(variant));
  }
});

test('the preview is every version, greeted with the synthetic sample name', () => {
  const preview = welcomeEmailPreview();
  assert.deepEqual(preview.map(p => p.variant), WELCOME_VARIANTS);
  for (const item of preview) {
    assert.equal(item.text, body(item.variant, app.WELCOME_SAMPLE_NAME));
    assert.ok(item.label.length > 5);
  }
});

test('the fingerprint covers every version with and without a name, and the function\'s copy has the same one', async () => {
  const fingerprint = await welcomeEmailFingerprint();
  assert.match(fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(fingerprint, crypto.createHash('sha256').update(welcomeEmailCanonical(), 'utf8').digest('hex'));
  assert.equal(await welcomeEmailFingerprint(), fingerprint, 'stable');
  const canonical = JSON.parse(welcomeEmailCanonical());
  assert.equal(canonical.version, app.WELCOME_EMAIL_VERSION);
  assert.equal(canonical.subject, app.WELCOME_EMAIL_SUBJECT);
  assert.equal(canonical.from, app.WELCOME_EMAIL_FROM);
  assert.equal(canonical.replyTo, app.WELCOME_EMAIL_REPLY_TO);
  assert.deepEqual(canonical.bodies, WELCOME_VARIANTS.map(v => [v, body(v, app.WELCOME_SAMPLE_NAME), body(v, null)]));
  // What limited-stripe-webhook presents is what Admin > Emails approves.
  assert.equal(await shared.welcomeEmailFingerprint(), fingerprint);
  assert.equal(shared.welcomeEmailCanonical(), welcomeEmailCanonical());
  assert.match(app.WELCOME_EMAIL_VERSION, /^[0-9a-z-]{1,64}$/, 'the version the database accepts');
});

// Email reminders are on from the start. Step 3 used to say "turn on Email
// reminders": a member who followed it tapped the switch and turned them OFF.
// Every claim the step makes is checked against the app and the sender here.
test('step 3 describes reminders as the app has them: already on, to the profile Email, with the lead time', () => {
  const src = rel => fs.readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');
  for (const variant of WELCOME_VARIANTS) {
    const step = body(variant).split('\n\n').find(p => p.startsWith('3. '));
    assert.doesNotMatch(step, /turn on/i, 'the switch is already on; tapping it turns reminders off');
    assert.match(step, /Email reminders are already on/);
    assert.match(step, /they go to the Email in your profile/, 'not to the address this welcome reached');
    assert.match(step, /Open More, then Profile & settings\./);
    assert.match(step, /Under Reminders, set Lead time \(days\)/);
  }
  // Already on: the app's default, and the reminder sender reads an untouched
  // switch the same way (a null notify_email used to mean off there).
  assert.equal(DEFAULT_SETTINGS.notifyEmail, true);
  assert.equal(emailRemindersOn(null), true);
  // The names the step uses are the ones on screen.
  assert.match(src('src/App.jsx'), /\{ id: "more", label: "More"/);
  assert.match(src('src/App.jsx'), />Profile &amp; settings</);
  const settings = src('src/components/pages/SettingsSection.jsx');
  assert.match(settings, /<ToggleRow label="Email reminders" sub=\{s\.email \? `Daily check, sent to \$\{s\.email\}/, 'sent to the profile Email');
  assert.match(settings, /<Field label="Email" hint=/);
  assert.match(settings, />Reminders<\/h3>[\s\S]{0,200}<Field label="Lead time \(days\)"/);
  // And the sender mails the profile Email.
  assert.match(src('supabase/functions/send-reminders/index.ts'), /to: \[p\.email\]/);
});
