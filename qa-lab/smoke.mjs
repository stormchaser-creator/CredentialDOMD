#!/usr/bin/env node
// npm run qa:smoke: proves the lab works end to end, the way a new physician meets the app.
//
//   1. creates a test physician through the QA sign-in API (mock Clerk), which
//      sends a Svix-signed user.created webhook to the local clerk-webhook;
//   2. opens the app in headless Chrome, picks that physician on the QA sign-in;
//   3. waits for the pending membership gate (a new account has no membership);
//   4. checks the database agrees (a profile for the subject, access pending),
//      and that the browser never talked to anything but this machine.
//
// --checkout goes on, as the physician would: reviews the founding offer,
// agrees to its terms, continues to payment, pays on the lab's stand-in for
// Stripe Checkout (which posts signed checkout.session.completed,
// customer.subscription.created and invoice.paid events to the local
// limited-stripe-webhook), and checks the membership turns active.
//
// Options: --checkout, --with-lab (start npm run qa:lab first and stop it
// after), --headed, --keep-open (leave the browser open until Ctrl-C). Needs
// Google Chrome, or QA_BROWSER=<path to a Chromium>. Exit code 0 only when
// every check passed.
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright-core';
import { LAB_EMAIL_DOMAIN } from './lib/lab-config.mjs';
import { GENERATED_DIR, QA_LAB_DIR, isMain } from './lib/paths.mjs';
import { readRuntime } from './lab.mjs';
import { sleep, waitFor } from './lib/procs.mjs';

const LOCAL = new Set(['127.0.0.1', 'localhost', '[::1]']);

export async function launchBrowser({ headed = false } = {}) {
  const options = { headless: !headed };
  if (process.env.QA_BROWSER) return chromium.launch({ ...options, executablePath: process.env.QA_BROWSER });
  try { return await chromium.launch({ ...options, channel: 'chrome' }); }
  catch (e) {
    try { return await chromium.launch(options); }
    catch { throw new Error(`no browser: install Google Chrome or set QA_BROWSER (${e.message.split('\n')[0]})`); }
  }
}

/**
 * A browser page for the lab: records console errors, refuses (and records)
 * every request to a host that is not this machine, and routes Stripe's hosted
 * pages to the mock's stand-ins so a checkout never opens the real Stripe.
 */
export async function labPage(browser, runtime) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const report = { consoleErrors: [], pageErrors: [], external: [], httpErrors: [] };
  await context.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.protocol === 'data:' || url.protocol === 'blob:' || LOCAL.has(url.hostname)) return route.continue();
    if (url.hostname === 'checkout.stripe.com') return route.fulfill({ status: 302, headers: { Location: `${runtime.urls.mock}/qa/stripe/hosted/checkout/${url.pathname.split('/').pop()}` } });
    if (url.hostname === 'billing.stripe.com') return route.fulfill({ status: 302, headers: { Location: `${runtime.urls.mock}/qa/stripe/hosted/portal/${url.pathname.split('/').pop()}` } });
    report.external.push(`${route.request().method()} ${url.origin}${url.pathname}`);
    return route.abort('blockedbyclient');
  });
  const page = await context.newPage();
  page.on('console', (m) => { if (m.type() === 'error') report.consoleErrors.push(m.text().slice(0, 300)); });
  page.on('pageerror', (e) => report.pageErrors.push(String(e.message).slice(0, 300)));
  // Which local request failed, so a console "403" names its endpoint.
  page.on('response', (r) => {
    if (r.status() < 400) return;
    const u = new URL(r.url());
    report.httpErrors.push(`${r.status()} ${r.request().method()} ${u.pathname}`);
  });
  return { context, page, report };
}

async function api(runtime, pathname, init = {}) {
  const r = await fetch(`${runtime.urls.mock}${pathname}`, { ...init, headers: { 'Content-Type': 'application/json', ...(init.headers || {}) }, signal: AbortSignal.timeout(90000) });
  const data = await r.json().catch(() => null);
  if (!r.ok) throw new Error(`${pathname}: ${r.status} ${JSON.stringify(data).slice(0, 300)}`);
  return data;
}

async function startLab() {
  console.log('qa-smoke: starting the lab (npm run qa:lab) ...');
  const child = spawn(process.execPath, [path.join(QA_LAB_DIR, 'lab.mjs'), '--quiet'], { stdio: ['ignore', 'inherit', 'inherit'] });
  const runtime = await waitFor('the lab to come up', async () => {
    if (child.exitCode !== null) throw new Error(`qa:lab exited with ${child.exitCode}`);
    const rt = readRuntime();
    return rt?.pid === child.pid ? rt : null;
  }, { timeoutMs: 900000, intervalMs: 2000 });
  return { runtime, child };
}

/** Review offer, agree, continue, pay on the lab's Checkout stand-in, back to the app: membership active. */
async function checkoutFlow({ page, runtime, user, check, shotDir, stamp }) {
  await page.getByRole('button', { name: 'Review Credential offer' }).click();
  const proceed = page.getByRole('button', { name: 'Continue to secure payment' });
  await proceed.waitFor({ timeout: 60000 });
  const reviewText = (await page.getByRole('region', { name: 'Membership' }).innerText()).replace(/\s+/g, ' ');
  check('the offer review shows the founding price and its terms', /\$99\.00 per year/.test(reviewText) && /USD 99 due now/.test(reviewText), reviewText.match(/Credential \$[\d.]+ per year/)?.[0] || reviewText.slice(0, 120));
  check('payment stays disabled until the terms are agreed', await proceed.isDisabled());
  await page.getByRole('checkbox', { name: /agree to the payment and renewal terms/ }).check();
  await proceed.click();
  const pay = page.getByTestId('qa-stripe-pay');
  await pay.waitFor({ timeout: 60000 });
  const sessionId = new URL(page.url()).pathname.split('/').pop();
  check('continuing opens Checkout (the lab stand-in, never checkout.stripe.com)', page.url().startsWith(`${runtime.urls.mock}/qa/stripe/hosted/checkout/cs_live_`), sessionId.slice(0, 24) + '...');
  await pay.click();
  await page.waitForURL((u) => u.origin === runtime.urls.appOrigin && u.searchParams.get('billing') === 'complete', { timeout: 120000 });
  const deliveries = (await api(runtime, '/qa/stripe/deliveries')).deliveries.slice(0, 3).reverse();
  check('signed checkout.session.completed, customer.subscription.created, invoice.paid all accepted by limited-stripe-webhook',
    deliveries.map((d) => d.type).join(',') === 'checkout.session.completed,customer.subscription.created,invoice.paid' && deliveries.every((d) => d.status === 200 && d.endpoint === 'limited-stripe-webhook'),
    deliveries.map((d) => `${d.type} ${d.status}`).join(', '));
  const active = await waitFor('the membership to turn active', async () => {
    const { profile } = await api(runtime, `/qa/users/${user.id}/profile`).catch(() => ({ profile: null }));
    return profile?.access_status === 'active' ? profile : null;
  }, { timeoutMs: 60000, intervalMs: 1000 }).catch(() => null);
  check('the profile is active after payment', !!active, active ? `profile ${active.id}` : 'still not active after 60s');
  // The app notices on its own (it polls after ?billing=complete): the gate goes away.
  const gone = await page.getByRole('region', { name: 'Membership' }).waitFor({ state: 'detached', timeout: 90000 }).then(() => true, () => false);
  await sleep(1500);
  const shot = path.join(shotDir, `smoke-${stamp}-member.png`);
  await page.screenshot({ path: shot, fullPage: true });
  check('back in the app, the membership gate is gone', gone, `screenshot ${shot}`);
}

export async function smoke(argv = process.argv.slice(2)) {
  const { values } = parseArgs({ args: argv, options: { 'with-lab': { type: 'boolean', default: false }, checkout: { type: 'boolean', default: false }, headed: { type: 'boolean', default: false }, 'keep-open': { type: 'boolean', default: false } } });
  let lab = null;
  let runtime = readRuntime();
  if (!runtime && values['with-lab']) lab = await startLab();
  runtime = lab?.runtime || runtime;
  if (!runtime) throw new Error('no QA lab is running: start it with `npm run qa:lab` (or run `npm run qa:smoke -- --with-lab`)');

  const checks = [];
  const check = (name, ok, detail = '') => { checks.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`); return ok; };
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  const shotDir = path.join(GENERATED_DIR, 'smoke');
  mkdirSync(shotDir, { recursive: true });
  let browser;
  try {
    // 1. A new test physician through the QA sign-in API.
    const created = await api(runtime, '/qa/users', { method: 'POST', body: JSON.stringify({ firstName: 'Smoke', lastName: `Test ${stamp}`, email: `smoke-${stamp}@${LAB_EMAIL_DOMAIN}` }) });
    const user = created.user;
    const email = user.email_addresses[0].email_address;
    check('test physician created through the QA sign-in API', /^user_qa[A-Za-z0-9]+$/.test(user.id) && email.endsWith(`@${LAB_EMAIL_DOMAIN}`), `${user.id} <${email}>`);
    const delivery = await waitFor('the user.created webhook', async () => {
      const d = (await api(runtime, '/qa/clerk/webhooks')).deliveries.find((x) => x.id === created.webhook);
      return d && d.state !== 'pending' && d.state !== 'retrying' ? d : null;
    }, { timeoutMs: 90000, intervalMs: 1000 }).catch((e) => ({ state: 'timeout', attempts: [], error: e.message }));
    const last = delivery.attempts?.at(-1);
    check('Svix-signed user.created webhook accepted by the local clerk-webhook', delivery.state === 'delivered', `${delivery.state}${last ? `, HTTP ${last.status} ${String(last.response).slice(0, 120)}` : ''}`);

    // 2. The app, as a physician would open it.
    browser = await launchBrowser({ headed: values.headed });
    const { page, report } = await labPage(browser, runtime);
    await page.goto(runtime.urls.app, { waitUntil: 'domcontentloaded' });
    const signin = page.getByTestId('qa-signin');
    await signin.waitFor({ timeout: 60000 });
    check('the app shows the QA sign-in (Clerk replaced in this build)', await signin.isVisible());
    const row = page.locator(`[data-testid="qa-signin-as"][data-user-id="${user.id}"]`);
    await row.waitFor({ timeout: 20000 });
    await row.click();

    // 3. The pending membership gate.
    const gate = page.getByRole('region', { name: 'Membership' });
    const failure = page.getByText(/could not finish|could not load|could not be loaded|could not be initialized/i);
    const outcome = await Promise.race([
      gate.waitFor({ timeout: 120000 }).then(() => 'gate'),
      failure.first().waitFor({ timeout: 120000 }).then(() => 'failure'),
    ]).catch(() => 'timeout');
    await sleep(1500);
    const shot = path.join(shotDir, `smoke-${stamp}.png`);
    await page.screenshot({ path: shot, fullPage: true });
    const gateText = outcome === 'gate' ? (await gate.innerText()).replace(/\s+/g, ' ').trim() : (await page.locator('body').innerText()).replace(/\s+/g, ' ').trim();
    check('signed in, the pending membership gate appears', outcome === 'gate', outcome === 'gate' ? gateText.slice(0, 160) : `${outcome}: ${gateText.slice(0, 200)}`);
    if (outcome === 'gate') {
      check('the gate offers the founding Credential membership', /Review Credential offer/.test(gateText));
      check('the gate has "Check access again" and "Sign out"', await page.getByRole('button', { name: 'Check access again' }).isVisible() && await page.getByRole('button', { name: 'Sign out' }).isVisible());
    }

    // 4. The database agrees.
    const { profile } = await api(runtime, `/qa/users/${user.id}/profile?wait=20000`).catch(() => ({ profile: null }));
    check('a profile exists for the signed-in subject, access pending', profile && profile.auth_user_id === user.id && profile.access_status === 'pending', profile ? `profile ${profile.id}, access ${profile.access_status}, verified_email ${profile.verified_email ? 'stamped' : 'empty'}` : 'no profile');

    // 5. (--checkout) Pay for the founding membership through the mock Stripe.
    if (values.checkout && outcome === 'gate') await checkoutFlow({ page, runtime, user, check, shotDir, stamp });

    // 6. Nothing left this machine.
    const mail = (await api(runtime, `/qa/emails?to=${encodeURIComponent(email)}`)).emails;
    console.log(`info  email captured for ${email}: ${mail.length ? mail.map((m) => `"${m.subject}"`).join(', ') : 'none'}`);
    check('the browser reached only this machine', report.external.length === 0, report.external.slice(0, 5).join(', '));
    if (report.pageErrors.length) console.log(`info  uncaught page errors: ${report.pageErrors.slice(0, 5).join(' | ')}`);
    if (report.consoleErrors.length) console.log(`info  console errors: ${report.consoleErrors.slice(0, 5).join(' | ')}`);
    if (report.httpErrors.length) console.log(`info  failed requests: ${report.httpErrors.slice(0, 8).join(' | ')}`);
    console.log(`info  screenshot: ${shot}`);
    if (values['keep-open'] && values.headed) { console.log('Browser left open; Ctrl-C to finish.'); await new Promise(() => {}); }
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (lab) { lab.child.kill('SIGTERM'); await new Promise((r) => lab.child.once('exit', r)); }
  }
  const failed = checks.filter((c) => !c.ok);
  console.log(`\nqa-smoke: ${checks.length - failed.length}/${checks.length} checks passed${failed.length ? `; failed: ${failed.map((c) => c.name).join('; ')}` : ''}`);
  return { checks, ok: failed.length === 0 };
}

if (isMain(import.meta.url)) {
  smoke().then((r) => process.exit(r.ok ? 0 : 1), (e) => { console.error(`qa-smoke: ${e.message}`); process.exit(1); });
}
