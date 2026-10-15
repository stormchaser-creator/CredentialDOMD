import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { build, transformSync } from 'esbuild';
import { mailtoHref } from '../src/utils/helpers.js';

// Use the shipping guide renderers without invoking the sending handler.
// No provider, real address, database or network is used in these tests.
const guideSource = readFileSync(new URL('../supabase/functions/send-guide/index.ts', import.meta.url), 'utf8').replace(/^import .*;\n/gm, '');
const context = { Deno: { env: { get: () => '' } }, serve() {}, answerAuthUnavailable: (_headers, handler) => handler, templates: null };
new vm.Script(transformSync(`${guideSource}\nglobalThis.templates = { emailHtml, emailText, verifiedText };`, { loader: 'ts', format: 'cjs' }).code)
  .runInNewContext(context, { timeout: 1000 });
const guides = JSON.parse(readFileSync(new URL('../supabase/functions/send-guide/stateGuides.json', import.meta.url), 'utf8'));

test('every checked-in state guide renders both readable email formats with valid web-link syntax', () => {
  assert.ok(Object.keys(guides).length >= 50);
  for (const [abbr, guide] of Object.entries(guides)) {
    const state = guide.name || abbr;
    const html = context.templates.emailHtml(state, guide);
    const text = context.templates.emailText(state, guide);
    assert.ok(html.includes('<h1') && html.includes('max-width:640px'), `${abbr}: responsive HTML template`);
    assert.ok(text.includes('\n\n') && text.includes('CredentialDOMD'), `${abbr}: plaintext paragraphs and sender`);
    assert.doesNotMatch(html + text, /\bundefined\b|\bnull(?: for | - | reason:|-equivalent)|loaded pages|page loaded/i, `${abbr}: no internal research markers`);
    for (const match of html.matchAll(/href="([^"]+)"/g)) {
      const href = match[1].replace(/&amp;/g, '&').replace(/&quot;/g, '"');
      const url = new URL(href);
      assert.ok(['https:', 'http:'].includes(url.protocol), `${abbr}: safe web link ${url.protocol}`);
      assert.equal(url.username + url.password, '', `${abbr}: no embedded credentials`);
    }
    for (const field of ['guide', 'portalUrl', 'boardUrl']) if (guide[field]) assert.ok(text.includes(guide[field]), `${abbr}: plaintext keeps ${field}`);
  }
});

test('state guide copy stays in sync across the source, email, app and generated state pages', async () => {
  const source = JSON.parse(readFileSync(new URL('../landing/states/states-data.json', import.meta.url), 'utf8'));
  const { RENEWAL_INFO } = await import('../src/constants/renewalInfo.js');
  for (const abbr of ['CA', 'CT', 'TN', 'WI']) {
    const state = source.states.find(state => state.abbreviation === abbr);
    for (const key of ['processingTime', 'renewalAnchor', 'lateFee', 'doBoardName']) assert.equal(guides[abbr][key] ?? null, state[key] ?? null, `${abbr}: ${key} email/source parity`);
    assert.equal(RENEWAL_INFO[abbr].processing, state.processingTime ?? null);
    assert.equal(RENEWAL_INFO[abbr].due, state.renewalAnchor || state.renewalMonth);
    const page = readFileSync(new URL(`../landing/states/${state.slug}.html`, import.meta.url), 'utf8');
    assert.doesNotMatch(page, /\bnull(?: for | - | reason:|-equivalent)|loaded pages|page loaded/i);
  }
  assert.ok(context.templates.emailText('Florida', guides.FL).includes('null and void'), 'legal language remains intact');
});

test('guide HTML escapes quotes, markup and ampersands while plaintext preserves the readable source', () => {
  const raw = '<script>alert("synthetic")</script> & "quoted"';
  const guide = {
    guide: 'https://example.test/guide?a=1&b="quoted"', boardName: raw, boardUrl: 'https://example.test/board',
    renewalCycle: raw, renewalAnchor: raw, renewalFee: raw, steps: [raw], pitfalls: [raw],
    faqs: [{ question: raw, answer: raw }], sources: [{ url: 'https://example.test/source', what: raw }],
  };
  const html = context.templates.emailHtml(raw, guide);
  assert.doesNotMatch(html, /<script>|<\/script>/);
  assert.ok(html.includes('&lt;script&gt;alert(&quot;synthetic&quot;)&lt;/script&gt; &amp; &quot;quoted&quot;'));
  assert.ok(html.includes('href="https://example.test/guide?a=1&amp;b=&quot;quoted&quot;"'));
  assert.ok(context.templates.emailText('Synthetic State', guide).includes(raw));
});

test('mailto links round-trip accented text, punctuation, recipients and paragraph breaks', () => {
  const recipient = 'jordan+test@example.test';
  const subject = 'Élodie & Jordan: 100% reviewed?';
  const body = 'Hello Élodie,\n\nLicense & CME details: a+b?x=1\nThank you.';
  const href = mailtoHref(recipient, subject, body);
  const [address, query] = href.slice('mailto:'.length).split('?');
  const params = new URLSearchParams(query);
  assert.equal(decodeURIComponent(address), recipient);
  assert.equal(params.get('subject'), subject);
  assert.equal(params.get('body'), body.replace(/\n/g, '\r\n'));
  assert.equal([...params.keys()].join(','), 'subject,body', 'body punctuation cannot create extra mail fields');
});

const bundled = await build({ entryPoints: [fileURLToPath(new URL('../src/utils/notifications.js', import.meta.url))], bundle: true, platform: 'node', format: 'esm', write: false, logLevel: 'silent' });
const { composeText } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);

for (const [name, agent, separator] of [['iPhone', 'iPhone', '&body='], ['Android', 'Android', '?body=']]) {
  test(`${name} text composition keeps Unicode and multiline formatting in its device-specific URI`, () => {
    const previousWindow = globalThis.window;
    const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    let opened;
    try {
      globalThis.window = { open: href => { opened = href; } };
      Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { userAgent: agent } });
      const text = 'Hi Élodie,\n\nReview A&B + C? 100% complete.';
      const result = composeText('+1 (202) 555-0100', text);
      assert.equal(result.truncated, false);
      assert.ok(opened.startsWith(`sms:+12025550100${separator}`));
      assert.equal(decodeURIComponent(opened.split(separator)[1]), text);
    } finally {
      if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow;
      if (previousNavigator) Object.defineProperty(globalThis, 'navigator', previousNavigator); else delete globalThis.navigator;
    }
  });
}


test('guide summaries preserve multi-date, birthday, and individual renewal schedules instead of a misleading single month', () => {
  for (const abbr of ['TX', 'CA', 'AZ', 'ND', 'OH', 'NY', 'AL']) {
    const guide = guides[abbr];
    const text = context.templates.emailText(guide.name, guide);
    const html = context.templates.emailHtml(guide.name, guide);
    assert.ok(text.includes(`Renewal schedule: ${guide.renewalAnchor}`), `${abbr}: existing full schedule is unchanged`);
    assert.ok(html.includes('Renewal schedule'), `${abbr}: HTML has the same summary label`);
    assert.doesNotMatch(text + html, /Renewal month|single-source|verified live|HTTP 200/);
    if (guide.verified) assert.ok(text.includes(context.templates.verifiedText(guide.verified)), `${abbr}: verification date remains`);
    for (const source of guide.sources || []) assert.ok(text.includes(source.url), `${abbr}: every source URL remains`);
  }
  const texas = context.templates.emailText('Texas', guides.TX);
  for (const date of ['February 28th', 'May 31st', 'August 31st', 'November 30th']) assert.ok(texas.includes(date));
  const fallback = context.templates.emailText('Synthetic', { guide: 'https://example.test/state', renewalMonth: 'March' });
  assert.ok(fallback.includes('Renewal schedule: March'), 'month-only legacy data remains readable');
});
