// Helpers every QA-lab journey uses: the running lab, its mock API, the local
// database (read-only queries through psql, never production), the captured
// email, and the steps a physician takes to get into the app.
//
// Everything here talks to this machine only: the mock server and app server
// from qa-lab/.generated/lab.json, the local Supabase stack through
// qa-lab/lib/local-db.mjs (which refuses any non-local host).
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { LAB_EMAIL_DOMAIN } from '../../lib/lab-config.mjs';
import { GENERATED_DIR } from '../../lib/paths.mjs';
import { localExec, localJson, supabaseStatus } from '../../lib/local-db.mjs';
import { sleep, waitFor } from '../../lib/procs.mjs';
import { readRuntime } from '../../lab.mjs';

export { sleep, waitFor, LAB_EMAIL_DOMAIN };

export const E2E_DIR = path.join(GENERATED_DIR, 'e2e');
export const SHOT_DIR = path.join(E2E_DIR, 'shots');
export const RESULTS_JSON = path.join(GENERATED_DIR, 'results.json');

/** The running lab (qa-lab/.generated/lab.json), or an error that says how to start it. */
export function lab() {
  const rt = readRuntime();
  if (!rt) throw new Error('no QA lab is running: start it with `npm run qa:lab`, or run the journeys with `npm run qa:e2e` (starts one)');
  return rt;
}

/** The lab's own JSON API on the mock server (/qa/...). */
export async function mockApi(pathname, { method = 'GET', body, timeoutMs = 90000 } = {}) {
  const r = await fetch(`${lab().urls.mock}${pathname}`, {
    method, headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!r.ok) throw new Error(`${method} ${pathname}: ${r.status} ${text.slice(0, 300)}`);
  return data;
}

const quote = (v) => (v === null || v === undefined ? 'null' : `'${String(v).replace(/'/g, "''")}'`);
/** Escapes a value for a SQL literal (for the local lab database only). */
export const lit = quote;

/** Rows of a read-only query against the LOCAL lab database, as an array of objects. */
export function rows(sql) {
  return localJson(`select coalesce(json_agg(t), '[]'::json) from (${sql.trim().replace(/;\s*$/, '')}) t`);
}
/** The first row, or null. */
export function row(sql) { return rows(sql)[0] || null; }

/** A statement against the LOCAL lab database as its superuser (setup only: enable a switch, age a date). */
export function labExec(sql) { return localExec(sql); }

/** A short letters-only tag (names: the app refuses digits in a signing name, e.g. invite-to-join). */
export function letters(n = 4) {
  const a = 'abcdefghijklmnopqrstuvwxyz';
  let out = '';
  for (let i = 0; i < n; i++) out += a[Math.floor(Math.random() * a.length)];
  return out[0].toUpperCase() + out.slice(1);
}

/** A unique tag for a journey's names and addresses. */
export function stamp(prefix = 'e2e') {
  const t = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(2, 14);
  return `${prefix}-${t}-${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * A fresh test physician through the QA sign-in API (mock Clerk), waiting until
 * the signed user.created webhook reached the local clerk-webhook.
 */
export async function createPhysician({ firstName = 'Test', lastName, email, verified = true, tag } = {}) {
  const t = tag || stamp();
  const created = await mockApi('/qa/users', { method: 'POST', body: {
    firstName, lastName: lastName || `Physician ${letters()}`, email: email || `${t}@${LAB_EMAIL_DOMAIN}`, verified,
  } });
  const user = created.user;
  const delivery = await waitFor('the user.created webhook', async () => {
    const d = (await mockApi('/qa/clerk/webhooks')).deliveries.find((x) => x.id === created.webhook);
    return d && d.state !== 'pending' && d.state !== 'retrying' ? d : null;
  }, { timeoutMs: 90000, intervalMs: 500 }).catch(() => null);
  return { id: user.id, email: user.email_addresses[0].email_address, firstName, lastName: user.last_name, webhook: delivery?.state || 'timeout', raw: user };
}

/** The local profile row of a subject (null when none yet). */
export function profileOf(subject) {
  return row(`select * from public.profiles where auth_user_id = ${quote(subject)}`);
}
export async function waitForProfile(subject, predicate = () => true, timeoutMs = 60000) {
  return waitFor(`the profile of ${subject}`, async () => { const p = profileOf(subject); return p && predicate(p) ? p : null; }, { timeoutMs, intervalMs: 500 });
}

/** Emails the mock Resend captured (newest first). */
export async function emails({ to, subject, since, tag } = {}) {
  const q = new URLSearchParams();
  if (to) q.set('to', to);
  if (subject) q.set('subject', subject);
  if (since) q.set('since', since);
  if (tag) q.set('tag', tag);
  return (await mockApi(`/qa/emails?${q}`)).emails;
}
export async function emailBody(id) { return mockApi(`/qa/emails/${encodeURIComponent(id)}`); }
export async function waitForEmail(filter, timeoutMs = 60000) {
  return waitFor(`an email ${JSON.stringify(filter)}`, async () => (await emails(filter))[0] || null, { timeoutMs, intervalMs: 1000 });
}

/** Makes a physician a lab administrator (local app_admins). */
export async function makeAdmin(user) { return mockApi(`/qa/users/${encodeURIComponent(user.id)}/admin`, { method: 'POST' }); }

/** Screenshot to .generated/e2e/shots/<name>.png; returns the path. */
export async function shot(page, name, testInfo) {
  mkdirSync(SHOT_DIR, { recursive: true });
  const file = path.join(SHOT_DIR, `${name.replace(/[^A-Za-z0-9._-]+/g, '_')}.png`);
  await page.screenshot({ path: file, fullPage: true }).catch(() => {});
  if (testInfo) await testInfo.attach(name, { path: file, contentType: 'image/png' }).catch(() => {});
  return file;
}

// ── In the app ─────────────────────────────────────────────────────────────

/** Opens the app and signs in as `user` on the QA sign-in. */
export async function signIn(page, user) {
  await page.goto(lab().urls.app, { waitUntil: 'domcontentloaded' });
  const row = page.locator(`[data-testid="qa-signin-as"][data-user-id="${user.id}"]`);
  await row.waitFor({ timeout: 60000 });
  await row.click();
}

/** Waits for what a signed-in physician lands on: the membership gate, or the member app. */
export async function landing(page, { timeoutMs = 120000 } = {}) {
  const gate = page.getByRole('region', { name: 'Membership' });
  const member = page.locator('nav, [role="navigation"]').filter({ hasText: /Home|Dashboard/ }).first();
  const failure = page.getByText(/could not finish|could not load|could not be loaded|could not be initialized/i).first();
  return Promise.race([
    gate.waitFor({ timeout: timeoutMs }).then(() => 'gate'),
    member.waitFor({ timeout: timeoutMs }).then(() => 'member'),
    failure.waitFor({ timeout: timeoutMs }).then(() => 'failure'),
  ]).catch(() => 'timeout');
}

/**
 * From the pending membership gate: review the offer shown, agree to its
 * terms, continue to payment and pay on the lab's Checkout stand-in. Returns
 * the review text and the checkout session id. As with Stripe, the browser is
 * back at ?billing=complete at once and the webhook events follow (by default
 * 1.5 s later, all at once, shuffled); `plan` changes that for this checkout
 * (see setDeliveryPlan), `beforePay(sessionId)` runs on the stand-in first.
 */
export async function payForMembership(page, { offerButton = /Review .* offer/, plan, beforePay } = {}) {
  const rt = lab();
  await page.getByRole('button', { name: offerButton }).first().click();
  const proceed = page.getByRole('button', { name: 'Continue to secure payment' });
  await proceed.waitFor({ timeout: 60000 });
  const reviewText = (await page.getByRole('region', { name: 'Membership' }).innerText()).replace(/\s+/g, ' ');
  const disabledBeforeConsent = await proceed.isDisabled();
  await page.getByRole('checkbox', { name: /agree to the payment and renewal terms/ }).check();
  await proceed.click();
  const pay = page.getByTestId('qa-stripe-pay');
  await pay.waitFor({ timeout: 60000 });
  const standIn = new URL(page.url());
  const sessionId = standIn.pathname.split('/').pop();
  // The QA build sends the browser to the stand-in on the app's own origin, never to Stripe.
  if (standIn.origin !== rt.urls.appOrigin) throw new Error(`Checkout opened on ${standIn.origin}, not the lab app's origin`);
  if (plan) await setDeliveryPlan(sessionId, plan);
  if (beforePay) await beforePay(sessionId);
  await pay.click();
  await page.waitForURL((u) => u.origin === rt.urls.appOrigin && u.searchParams.get('billing') === 'complete', { timeout: 120000 });
  return { reviewText, sessionId, disabledBeforeConsent };
}

/**
 * How the mock Stripe delivers one checkout's events: { delayMs, order
 * ('shuffled' | 'checklist' | 'invoice-first' | [types]), mode ('concurrent' |
 * 'sequential'), drop: [types], retry }. Set it on the stand-in, before Pay.
 */
export async function setDeliveryPlan(sessionId, plan) {
  return mockApi('/qa/stripe/delivery-plan', { method: 'POST', body: { session: sessionId, ...plan } });
}

/** Every webhook attempt about one checkout session (its session, subscription and invoice), oldest first. */
export async function checkoutAttempts(sessionId) {
  const session = (await mockApi('/qa/stripe/sessions')).sessions.find((x) => x.id === sessionId);
  const ids = new Set([session?.id, session?.subscription, session?.invoice].filter(Boolean));
  return (await mockApi('/qa/stripe/deliveries')).deliveries.filter((d) => ids.has(d.object)).reverse();
}

/** Waits until each of the checkout's three events has been accepted (2xx) by the webhook; returns every attempt. */
export async function waitForCheckoutEvents(sessionId, timeoutMs = 90000) {
  const types = ['checkout.session.completed', 'customer.subscription.created', 'invoice.paid'];
  return waitFor('every checkout event to be accepted', async () => {
    const all = await checkoutAttempts(sessionId);
    return types.every((t) => all.some((d) => d.type === t && d.status >= 200 && d.status < 300)) ? all : null;
  }, { timeoutMs, intervalMs: 1000 });
}

/**
 * Holds the member's billing reconcile lease (LOCAL database, as the webhook
 * itself takes it: claim_billing_reconcile), so the next Stripe event for this
 * account is refused 503 billing_reconciliation_pending, as when another event
 * for the same account is being settled. Returns the lease token.
 */
export function holdReconcileLease(profileId) {
  const account = row(`select stripe_customer_id from public.billing_accounts where profile_id = ${quote(profileId)} and livemode`);
  if (!account) throw new Error(`no live billing account for profile ${profileId}`);
  const out = localExec(`select public.claim_billing_reconcile(${quote(profileId)}::uuid, true, ${quote(account.stripe_customer_id)}, 'evt_qalabjourneyhold${Date.now()}')::text`);
  const claim = JSON.parse(out.split('\n').filter((l) => l.startsWith('{')).at(-1));
  if (claim.state !== 'claimed') throw new Error(`could not hold the reconcile lease: ${claim.state}`);
  return claim.token;
}
export function releaseReconcileLease(profileId, token) {
  return localExec(`select public.release_billing_reconcile(${quote(profileId)}::uuid, true, ${quote(token)}::uuid)`) === 't';
}

/** Waits for the member app (the gate gone and the main navigation shown). */
/**
 * The identity step's lab-only stalls, told apart by the app's support reference: under load
 * the local edge runtime has answered initialize-clerk-profile 503 continuity_unavailable, and
 * 401 when its fetch of the mock Clerk's JWKS timed out (5 s), for every journey loading in the
 * same seconds; and the gateway has answered the profile step 502 (2026-09-30). A closed
 * account's ACCOUNT_UNAVAILABLE-H409 is the product's answer and never matches.
 */
export const TRANSIENT_IDENTITY = /Support reference: ID-(?:INIT-UNAVAILABLE-H(?:401|5\d\d)|PROFILE-UNKNOWN-H5\d\d)\b/;

/**
 * Waits for the member app (the Credentials button). When the load stops on a transient identity
 * failure ("Your account identity could not be verified ... Reload to try again"), taps Reload
 * as the screen asks, at most `retries` times, and says so on the run's output (the app's own
 * report of the stop stays in client_errors, so results.json's labHealth counts it).
 */
export async function waitForMemberApp(page, timeoutMs = 120000, { retries = 2 } = {}) {
  await page.getByRole('region', { name: 'Membership' }).waitFor({ state: 'detached', timeout: timeoutMs }).catch(() => {});
  const app = page.getByRole('button', { name: /^Credentials$/ }).first();
  const stalled = page.getByRole('status').filter({ hasText: TRANSIENT_IDENTITY }).first();
  for (let i = 0; i < retries; i++) {
    await app.or(stalled).first().waitFor({ timeout: timeoutMs });
    if (await app.isVisible().catch(() => false)) return;
    const ref = ((await stalled.innerText().catch(() => '')).match(TRANSIENT_IDENTITY) || ['a transient identity failure'])[0];
    console.log(`qa-lab: the member app stopped on ${ref} (a lab stall); tapping Reload, as the screen asks`);
    // An account-load stop's button reads "Reload" since a9fb298b (accessGateStatus); "Try again" before it.
    await page.getByRole('button', { name: /^(Reload|Try again)$/ }).first().click().catch(() => {});
    await sleep(2000);   // let the reload Try again starts replace the stopped page
    await page.waitForLoadState('domcontentloaded').catch(() => {});
  }
  await app.waitFor({ timeout: timeoutMs });
}

/**
 * A fresh ACTIVE member, the way a physician becomes one: created on the QA
 * sign-in, signed in, founding offer paid on the Checkout stand-in (back at
 * once, the events a moment later, as with Stripe), and once the membership
 * is active the app opened again, as the member's next visit. The page ends on
 * the member app. (That reopening keeps these journeys about their own
 * features: the return from Checkout itself, including what one page load
 * that started pending gets wrong, is billing-return.spec.mjs's and
 * signup-checkout.spec.mjs's to check.)
 */
export async function newMember(page, opts = {}) {
  const user = await createPhysician(opts);
  await signIn(page, user);
  const where = await landing(page);
  if (where !== 'gate') throw new Error(`a new physician should land on the membership gate, landed on: ${where}`);
  const payment = await payForMembership(page);
  await waitForProfile(user.id, (p) => p.access_status === 'active', 90000);
  await waitForMemberApp(page);
  await page.goto(lab().urls.app, { waitUntil: 'domcontentloaded' });
  await waitForMemberApp(page);
  await dismissInterruptions(page);
  return { user, payment, profile: profileOf(user.id) };
}

/** Closes first-run dialogs and banners that sit over the app (if any are shown). */
export async function dismissInterruptions(page) {
  for (const name of [/^Not now$/i, /^Skip$/i, /^Dismiss$/i, /^Maybe later$/i, /^Got it$/i, /^Close$/i]) {
    const b = page.getByRole('dialog').getByRole('button', { name }).first();
    if (await b.isVisible().catch(() => false)) await b.click().catch(() => {});
  }
}

/** Main navigation (phone bottom bar or desk side nav). */
export async function goTab(page, name) {
  // Some tabs carry an emoji ("🏥 Practice").
  await page.getByRole('navigation').first().getByRole('button', { name: new RegExp(`^(\\S+ )?${name}$`) }).first().click();
}

// ── Server side, as the physician (the local stack only) ────────────────────

let anonKey = null;
function localAnonKey() {
  if (anonKey) return anonKey;
  const status = supabaseStatus();
  if (!status?.ANON_KEY) throw new Error('the local stack is not running');
  return (anonKey = status.ANON_KEY);
}

/** A token for `user` from the mock Clerk (template 'supabase' is the database token). */
export async function tokenFor(user, template = 'supabase') {
  const { session } = await mockApi('/qa/sessions', { method: 'POST', body: { userId: user.id } });
  const { jwt } = await mockApi(`/qa/sessions/${encodeURIComponent(session.id)}/tokens`, { method: 'POST', body: template ? { template } : {} });
  await mockApi(`/qa/sessions/${encodeURIComponent(session.id)}`, { method: 'DELETE' }).catch(() => {});
  return jwt;
}

/** PostgREST on the LOCAL gateway as `user` (RLS applies as it does for the app). */
export async function restAs(user, pathname, { method = 'GET', body, headers = {} } = {}) {
  const jwt = await tokenFor(user);
  const r = await fetch(`${lab().urls.api}/rest/v1/${pathname.replace(/^\//, '')}`, {
    method, headers: { apikey: localAnonKey(), Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json', Prefer: 'return=representation', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000),
  });
  const text = await r.text();
  let data = null; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: r.status, data };
}

/** What the database says `subject` may do (credentialdo_access_snapshot as that member). */
export function accessSnapshot(subject) {
  const claims = JSON.stringify({ sub: subject, role: 'authenticated' }).replace(/'/g, "''");
  // The last line is the snapshot (psql prints each statement's result); the read-only transaction ends with the session.
  const out = localExec(`begin read only; select set_config('request.jwt.claims', '${claims}', true); set local role authenticated; select public.credentialdo_access_snapshot()::text`);
  const line = out.split('\n').filter((l) => l.startsWith('{')).at(-1);
  return line ? JSON.parse(line) : null;
}

/** The mock Stripe's checkout sessions for a Clerk subject, and every webhook delivery about them (newest first). */
export async function stripeFor(subject) {
  const sessions = (await mockApi(`/qa/stripe/sessions?subject=${encodeURIComponent(subject)}`)).sessions;
  const ids = new Set(sessions.flatMap((s) => [s.id, s.subscription, s.invoice, s.customer]).filter(Boolean));
  const deliveries = (await mockApi('/qa/stripe/deliveries')).deliveries.filter((d) => ids.has(d.object) || ids.has(d.customer));
  return { sessions, deliveries };
}

/** Sends a recorded Stripe event to the webhook again (a replay). */
export async function replayStripeEvent(eventId) {
  return mockApi(`/qa/stripe/events/${encodeURIComponent(eventId)}/resend`, { method: 'POST', body: {} });
}

// ── App screens ────────────────────────────────────────────────────────────

/**
 * A form control by its visible label, found as the label's sibling (the
 * label and its control share a parent). Since 43341dc1 the Field component
 * also ties the label to a single control (htmlFor), so the same control has
 * that accessible name too; a Field around several controls is a named
 * group instead, and this still finds its first control.
 */
export function field(scope, label) {
  return scope.locator('label', { hasText: label }).first().locator('xpath=..').locator('input, select, textarea').first();
}

/** Credentials > <section> (e.g. "Licenses", "Education"). */
export async function openCredentials(page, section) {
  await goTab(page, 'Credentials');
  if (section) await page.getByRole('navigation').filter({ hasText: 'Active Credentials' }).getByRole('button', { name: new RegExp(`(^|\\s)${section}( \\d+)?$`) }).first().click();
}

/** More > <item> (a button whose name starts with the item's label, after its emoji). */
export async function openMore(page, item) {
  await goTab(page, 'More');
  await page.getByRole('button', { name: new RegExp(`^(\\S+ )?${item}`) }).first().click();
}

/** The desk table row whose text matches. */
export function tableRow(page, text) {
  return page.getByRole('row').filter({ hasText: text }).first();
}

/** The Clerk subject the app is signed in as (window.Clerk). */
export async function clerkId(page) { return page.evaluate(() => window.Clerk?.user?.id || null); }

/** Writes that failed to reach the cloud and wait for replay (localStorage credentialdomd-pending-ops:<clerk>). */
export async function pendingOps(page) {
  return page.evaluate(() => {
    const id = window.Clerk?.user?.id;
    const raw = id ? localStorage.getItem(`credentialdomd-pending-ops:${id}`) : null;
    try { return raw ? JSON.parse(raw) : []; } catch { return [raw]; }
  });
}

/** Console lines the checklist's write-evidence protocol (SYNC-001) treats as a failed write. */
export const SYNC_WARNINGS = /Failed to insert|Failed to update|Failed to delete|Failed to set favorite|Failed to record deletion|Bulk sync|still failing|Failed to save settings|Document file upload failed|Not sent:/;
export function syncWarnings(report, sinceIndex = 0) { return report.console.slice(sinceIndex).filter((l) => SYNC_WARNINGS.test(l)); }

/** The Home hero: ring percent and the tile counts. */
export async function homeTiles(page) {
  await goTab(page, 'Home');
  const ring = page.getByRole('progressbar', { name: 'Tracked standing' });
  await ring.waitFor({ timeout: 30000 }).catch(() => {});
  const text = (await page.locator('main, body').first().innerText()).replace(/\s+/g, ' ');
  const n = (label) => Number((new RegExp(`(\\d+) ${label}`, 'i').exec(text) || [])[1] ?? NaN);
  const percent = Number(((await ring.getAttribute('aria-valuenow').catch(() => null)) ?? (/(\d+)% Tracked standing/i.exec(text) || [])[1]) ?? NaN);
  return { percent, active: n('Active'), expiring: n('Expiring'), expired: n('Expired'), noDate: n('No date'), snoozed: n('Snoozed') };
}

/** A small valid PDF whose only content is `text` (synthetic, no personal data). */
export function syntheticPdf(text = 'QA synthetic document') {
  const safe = text.replace(/[()\\]/g, ' ');
  const stream = `BT /F1 14 Tf 72 720 Td (${safe}) Tj ET`;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let body = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((o, i) => { offsets.push(body.length); body += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = body.length;
  body += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  body += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

/** A tiny PNG (solid colour) for screenshot attachments. */
export function syntheticPng() {
  return Buffer.from('iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAHklEQVR4nGNkYPjPQApgIkn1qIZRDaMaRjUMKw0AdTgBH0jPmM0AAAAASUVORK5CYII=', 'base64');
}

/** Clicks `trigger` and answers the file chooser it opens with `files` ({name, mimeType, buffer}). */
export async function chooseFiles(page, trigger, files) {
  const [chooser] = await Promise.all([page.waitForEvent('filechooser', { timeout: 15000 }), trigger.click()]);
  await chooser.setFiles(files);
}

/** Tables a member's records live in, keyed by the app's section. */
export function memberRows(table, profileId, where = '') {
  return rows(`select * from public.${table} where user_id = '${profileId}' ${where}`);
}
export function tombstones(profileId) {
  return rows(`select item_id, collection, deleted_at from public.deleted_items where user_id = '${profileId}'`);
}

/**
 * The action buttons of the record (desk table row or card) whose text matches:
 * star, share, edit, delete. They sit together after the star and are found as
 * the star's siblings, in that order (named "Share", "Edit" and "Delete" since
 * 43341dc1, "... entry" on a CME card).
 */
export function recordButtons(page, text) {
  const star = page.getByRole('button', { name: /(Add to|Remove from) Favorites/ });
  const box = page.locator('tr, div').filter({ hasText: text }).filter({ has: star }).last();
  const group = box.getByRole('button', { name: /(Add to|Remove from) Favorites/ }).first().locator('xpath=..');
  const all = group.locator('button');
  return { box, star: all.nth(0), share: all.nth(1), edit: all.nth(2), remove: all.nth(3) };
}

/**
 * Queues the mock AI's next answer. With `match` (text the request must contain, e.g. a slice
 * of the uploaded file's base64) only that request gets it, so parallel journeys cannot take it.
 */
export async function scriptAi(provider, response, match) {
  return mockApi('/qa/ai/next', { method: 'POST', body: { provider, response, ...(match ? { match } : {}) } });
}
/**
 * The file's whole base64, which identifies it inside an AI request. (A middle
 * slice used to be enough, until a script left queued by a journey that
 * stopped early matched the next run's synthetic PDF, which differs from it
 * only in a few digits, and answered it with the old license number.)
 */
export function base64Marker(buffer) {
  return Buffer.from(buffer).toString('base64');
}
