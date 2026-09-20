import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { renderHelp } from '../scripts/build-help.mjs';
import { loadVideoCatalog } from '../scripts/help-videos.mjs';
import { fileURLToPath } from 'node:url';
import { renderPublicLaunch, publicLaunchHelp } from '../scripts/public-launch-render.mjs';
import { PUBLIC_LAUNCH_MODE } from '../src/content/publicLaunch.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = file => readFile(new URL(`../${file}`, import.meta.url), 'utf8');
const off = { enabled: false, signupHref: null };

for (const page of ['index', 'locums']) {
  test(`${page}: explicit OFF template keeps future paid invitation and earlier promises distinct`, async () => {
    const source = await read(`landing/${page}.html`);
    const html = renderPublicLaunch(source, page === 'index' ? 'home' : 'locums', off);
    assert.equal(html, source);
    assert.match(html, /Checkout is not open/);
    assert.match(html, /card required at checkout/);
    assert.match(html, /Joining the waitlist does not (?:create a paid account or charge you|charge you or create a paid account)/);
    assert.match(html, /Signed up under our earlier free-beta offer\?/);
    assert.match(html, /30 days free with no card, then an optional \$99\/year Credential membership/);
    assert.match(html, /There is no automatic charge; you must choose to pay to continue/);
    assert.match(html, /Your invitation will confirm eligibility and when the 30 days start/);
    assert.match(html, /New paid Credential members will receive a separate 30-day Practice trial/);
    assert.match(html, /continuing Practice requires an explicit purchase/i);
    assert.match(html, /keep Credential and Practice free for life/);
    assert.match(html, /waitlist entry alone does not qualify/i);
    assert.match(html, /\$245/);
    assert.doesNotMatch(html, /Free invite-only beta|Free beta[,.]|Request beta access|No card is required for beta access|invite beta is free/i);
    const meta = [...html.matchAll(/<meta\b[^>]*>/g)].map(match => match[0]).join('\n');
    assert.doesNotMatch(meta, /free beta|no card/i);
  });
  test(`${page}: production copy offers capped $99 founding signup and preserves protected earlier promises`, async () => {
    assert.equal(PUBLIC_LAUNCH_MODE.enabled, true);
    const html = renderPublicLaunch(await read(`landing/${page}.html`), page === 'index' ? 'home' : 'locums');
    assert.match(html, /href="\/app\/"/);
    assert.match(html, /Review membership offers/);
    assert.match(html, /card (?:is )?required at checkout/i);
    assert.match(html, /Founding Credential is \$99\/year for the first 100 paid founding members/);
    assert.match(html, /30 days free with no card, starting when they first activate their account with a verified email address/);
    assert.match(html, /signing in again does not restart those 30 days/);
    assert.match(html, /opt in to \$99\/year Credential during the beta by adding a card and explicitly agreeing to the annual subscription/);
    assert.match(html, /first charge is scheduled for your original beta end date, when your paid year starts/);
    assert.match(html, /same account and saved records/);
    assert.match(html, /If you never opt in, there is no automatic charge and nothing to cancel/);
    assert.match(html, /full refund of your most recent annual membership payment, including a renewal payment, at any time/);
    assert.match(html, /no request deadline or prorating/);
    assert.match(html, /not all payments from past years/);
    assert.match(html, /separate 30-day Practice trial/);
    assert.match(html, /Continuing Practice requires an explicit purchase/);
    assert.match(html, /Existing Credential members should contact support@credentialdomd.com to review options for adding Practice/);
    assert.match(html, /no change or charge will occur without their agreement/);
    assert.match(html, /Practice records remain available to read and export/);
    assert.match(html, /keep Credential and Practice free for life/);
    assert.match(html, /waitlist entry alone does not qualify for lifetime access/);
    assert.match(html, /\$245\/year total at first purchase/);
    assert.doesNotMatch(html, /Checkout is not open|invitation will confirm eligibility|<form\b[^>]*class="[^"]*wl-form/i);
    assert.doesNotMatch(html, /Founding invitations/i);
  });
}
test('locums visible cost answer and FAQ structured data are identical', async () => {
  const html = await read('landing/locums.html');
  const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map(match => JSON.parse(match[1]));
  const faq = blocks.find(block => block['@type'] === 'FAQPage');
  assert.ok(faq);
  const cost = faq.mainEntity.find(entry => entry.name === 'What does it cost?').acceptedAnswer.text;
  assert.equal(html.split(cost).length - 1, 2, 'Cost answer must appear once in JSON-LD and once visibly');
  assert.match(cost, /earlier free-beta offer/);
  assert.match(cost, /card required at checkout/);
});
test('OFF help fixture is unchanged and production help presents verified beta and separate Practice trial', async () => {
  const help = JSON.parse(await read('public/knowledge/credentialdo-help.json'));
  const html = await read('landing/help.html');
  const videos = await loadVideoCatalog(root);
  assert.equal(renderHelp(help, videos), html);
  assert.strictEqual(publicLaunchHelp(help, off), help);
  assert.equal(renderPublicLaunch(html, 'help', off), html);
  const availability = help.articles.find(article => article.id === 'locum-contract').availability;
  assert.match(availability, /existing invited beta users/);
  assert.match(availability, /new paid Credential members/);
  assert.match(availability, /Earlier free-beta signups/);
  assert.match(html, /Card required at future paid checkout/);
  assert.doesNotMatch(html, /Free invite-only beta/);
  const activeHelp = publicLaunchHelp(help);
  const active = renderPublicLaunch(renderHelp(activeHelp, videos), 'help');
  assert.match(activeHelp.articles.find(article => article.id === 'locum-contract').availability, /first activate their account with a verified email address/);
  assert.match(active, /href="\/app\/"/);
  assert.match(active, /separate 30-day Practice trial/);
  assert.match(active, /most recent annual membership payment, including a renewal payment, at any time/);
  assert.match(active, /Request through Get help in the app or support@credentialdomd.com/);
  assert.doesNotMatch(active, /An invited, signed-in account|new invited physicians/);
  assert.match(active, /signed-in account with active Credential access/);
  assert.doesNotMatch(active, /Card required at future paid checkout|Their invitation will confirm/);
});

test('app metadata and security label remain factual in either launch mode', async () => {
  const app = await read('index.html');
  const security = await read('landing/security.html');
  assert.match(app, /Organize medical licenses, DEA registrations, CME, and professional documents/);
  assert.match(security, /Updated September 18, 2026 &middot; Physician credential management/);
  for (const html of [app, security]) assert.doesNotMatch(html, /Invite-only beta|billing is off/i);
});
