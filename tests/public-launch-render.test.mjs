import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { renderPublicLaunch, publicLaunchHelp, publicLaunchCostAnswer } from '../scripts/public-launch-render.mjs';
import { PUBLIC_LAUNCH_MODE, publicLaunchPresentation } from '../src/content/publicLaunch.mjs';
import { renderHelp } from '../scripts/build-help.mjs';
import { renderWatchPages } from '../scripts/watch-pages.mjs';
import { loadVideoCatalog } from '../scripts/help-videos.mjs';
import { getLegalDocuments, PRIVACY, TERMS, LEGAL_OPERATOR } from '../src/content/legalText.js';
import { renderLegalPages } from '../scripts/generate-legal-pages.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
// This route is an offline fixture, not a claim that signup is deployed.
const paid = { enabled: true, signupHref: '/signup/' };
const off = { enabled: false, signupHref: null };
const scripts = html => [...html.matchAll(/<script\b[^>]*>[\s\S]*?<\/script>/g)].map(match => match[0]).filter(script => !script.includes('src="/membership-offer.js"'));
const assets = html => [...html.matchAll(/(?:src|poster)="([^"]+)"/g)].map(match => match[1]).filter(path => path !== '/membership-offer.js');
const jsonLd = html => [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map(match => JSON.parse(match[1]));

test('explicit OFF mode leaves source HTML bytes intact, and no source has a waitlist form left', async () => {
  for (const [path, surface] of [['index', 'home'], ['locums', 'locums'], ['help', 'help'], ['cme', 'cme'], ['states/ohio', 'state-guides'], ['states/index', 'state-index'], ['terms', 'legal-navigation']]) {
    const html = await read(`landing/${path}.html`);
    assert.equal(renderPublicLaunch(html, surface, off), html, path);
    assert.doesNotMatch(html, /wl-form|name="waitlist"|\/api\/waitlist|waitlist-signup\.js|Join the waitlist/i, path);
  }
});

test('production defaults render every packaged surface with the real app signup route', async () => {
  assert.deepEqual(PUBLIC_LAUNCH_MODE, { enabled: true, signupHref: '/app/?start=signup' });
  for (const [path, surface] of [['index', 'home'], ['locums', 'locums'], ['help', 'help'], ['cme', 'cme'], ['states/ohio', 'state-guides'], ['states/index', 'state-index'], ['terms', 'legal-navigation']]) {
    // The packager first compiles the mode-specific help knowledge; raw authored
    // help intentionally remains the OFF fixture and must not bypass that step.
    const html = surface === 'help'
      ? renderHelp(publicLaunchHelp(JSON.parse(await read('public/knowledge/credentialdo-help.json'))), await loadVideoCatalog(root))
      : await read(`landing/${path}.html`);
    const output = renderPublicLaunch(html, surface);
    assert.equal(output, renderPublicLaunch(html, surface, { enabled: true, signupHref: '/app/?start=signup' }), path);
    assert.match(output, /data-public-launch="founding-signup"/, path);
    assert.equal((output.match(/src="\/membership-offer\.js"/g) || []).length, 1, path);
    // Owner, 2026-11-16: every surface's signup links are printed as plain
    // "Sign up" or "Sign up today"; the live offer repaints none of them, and
    // no surface prints a later price while founding lasts.
    assert.match(output, />Sign up(?: today)?(?: <svg\b[\s\S]*?<\/svg>)?<\/a>/, path);
    assert.doesNotMatch(output, /Create your account|data-membership-action|Join for \$|>Sign in</, path);
    assert.doesNotMatch(output.replace(/\$149&ndash;\$1,206/, ''), /\$\s?(?:149|199|245)\b/, path);
    // Every Sign up opens the sign-up-and-pay page (owner, 2026-11-24: one step).
    assert.match(output, /href="\/app\/\?start=signup"/, path);
    for (const [, href] of output.matchAll(/<a\b[^>]*href="([^"]*)"[^>]*>\s*Sign up(?: today)?\b/g)) assert.equal(href, '/app/?start=signup', path);
    assert.doesNotMatch(output, /href="\/signup\/"|href="\/#join"|<!-- public-launch:/, path);
    assert.doesNotMatch(output, /<form\b[^>]*class="[^"]*\bwl-form\b|<fieldset\b[^>]*class="guide-choice"/, path);
  }
});

test('paid locums exposes static navigation and cannot submit a disguised waitlist form', async () => {
  const source = await read('landing/locums.html');
  const output = renderPublicLaunch(source, 'locums', paid);
  assert.doesNotMatch(output, /<form\b[^>]*\bclass="[^"]*wl-form/);
  assert.doesNotMatch(output, /type="email"/);
  assert.ok((output.match(/href="\/signup\/"/g) || []).length >= 4);
  assert.match(output, /class="btn-primary nav-cta" href="\/signup\/">Sign up<\/a>/);
  assert.match(output, /<a class="btn-primary" href="\/signup\/"[^>]*>Sign up today<\/a>/);
  assert.doesNotMatch(output, /Create your account|data-membership-action/);
  assert.match(output, /Founding Credential is \$99\/year while Founder spots last/);
  assert.doesNotMatch(output, /Their invitation will confirm eligibility|Your invitation will confirm eligibility/);
  assert.match(output, /less polished/);
  assert.match(output, /support tickets/);
  assert.match(output, /locked for life while membership remains continuously active/);
  assert.doesNotMatch(output, /\$\s?(?:149|199|245)\b|early bird|Credential \+ Practice is/i, 'the Founder plan is the only plan printed');
  assert.doesNotMatch(output, /no founding (?:or early.bird )?discount/);
  assert.match(output, /earlier free-beta wording/);
  assert.match(output, /30 days free with no card/);
  assert.match(output, /Founding Credential members have Practice included for as long as their membership stays active\./);
  assert.deepEqual(assets(output), assets(source), 'preserve physician photos and all runtime sources');
  assert.match(output, /href="\/app\/"/, 'existing sign-in remains available');
});

// Unified home page (owner approval 2026-11-15). Its signup links are plain
// links that say "Sign up today" ("Sign up" in the header and footer); the
// mode only supplies where they lead.
test('paid home exposes static signup links, keeps sign-in, and submits no form', async () => {
  const source = await read('landing/index.html');
  const output = renderPublicLaunch(source, 'home', paid);
  assert.doesNotMatch(output, /<form\b|type="email"/);
  assert.equal((output.match(/<a\b[^>]*href="\/signup\/"[^>]*>Sign up today<\/a>/g) || []).length, 5);
  assert.equal((output.match(/<a\b[^>]*href="\/signup\/"[^>]*>Sign up<\/a>/g) || []).length, 2, 'header and footer');
  assert.equal((output.match(/href="\/signup\/"/g) || []).length, 7, 'nothing else points at signup');
  assert.ok((output.match(/<a\b[^>]*href="\/app\/"[^>]*>Log in<\/a>/g) || []).length >= 3, 'existing sign-in remains available');
  assert.doesNotMatch(output, /Create your account|data-membership-action|Join for \$/);
  assert.match(output, /less polished/);
  assert.match(output, /support tickets/);
  assert.match(output, /earlier free-beta wording/);
  assert.match(output, /30 days free with no card/);
  assert.match(output, /keep Credential and Practice free for life/);
  assert.deepEqual(assets(output), assets(source), 'preserve photographs and all runtime sources');
  // The beacon and the https switch are the page's own, untouched by rendering.
  assert.deepEqual(scripts(output), scripts(source));
});

test('home shows the Founder plan before sign-in, with its signup link right under the offer', async () => {
  const output = renderPublicLaunch(await read('landing/index.html'), 'home');
  const hero = output.slice(output.indexOf('<section class="hero"'), output.indexOf('<section id="how">'));
  assert.match(hero, /<div class="offer" data-founder-only>\s*<strong>Founder plan: \$99\/year, everything included<\/strong>/);
  assert.match(hero, /Your rate stays locked for life while your membership is active/);
  assert.match(hero, /<span class="spots" data-founder-spots>Limited Founder spots at \$99\/year<\/span>/, 'no number is printed');
  const offer = hero.indexOf('data-founder-spots');
  const signup = hero.indexOf('<a class="btn" href="/app/?start=signup">Sign up today</a>');
  assert.ok(offer > 0 && signup > offer && signup < hero.indexOf('Take a look inside'), 'after the offer box, before the tour link');
  assert.match(hero, /100% money-back guarantee, any time/);
  const header = output.slice(output.indexOf('<header'), output.indexOf('</header>'));
  assert.match(header, /<a class="login" href="\/app\/">Log in<\/a>\s*<a class="btn sm" href="\/app\/\?start=signup">Sign up<\/a>/);
  assert.match(header, /<a href="#pricing">Pricing<\/a>/);
  // Links to the previous home page's sections still land.
  for (const id of ['planned-pricing', 'how-it-works', 'features', 'founder', 'faq', 'join', 'early-access']) assert.match(output, new RegExp(`\\bid="${id}"`), id);
  const card = output.slice(output.indexOf('<div class="price-card" data-founder-only>'), output.indexOf('<div class="terms">'));
  assert.match(card, /<div class="price">\$99<small>\/year<\/small><\/div>/);
  assert.ok(card.indexOf('class="price"') < card.indexOf('href="/app/?start=signup"'), 'the price is above the signup link');
  assert.match(output, /<span data-home-status role="status" aria-live="polite">Your offer is confirmed before payment\./);
  assert.doesNotMatch(output, /data-membership-(?!endpoint)/, 'none of the hooks that repaint the older wording');
});

test('locums visible cost and structured data share the same active offer and exceptions', async () => {
  const source = await read('landing/locums.html');
  const output = renderPublicLaunch(source, 'locums', paid);
  const answer = publicLaunchCostAnswer(publicLaunchPresentation(paid));
  const faq = jsonLd(output).find(item => item['@type'] === 'FAQPage');
  assert.equal(faq.mainEntity.find(item => item.name === 'What does it cost?').acceptedAnswer.text, answer);
  assert.ok(output.includes(answer), 'visible cost answer uses the identical text');
  const before = jsonLd(source).find(item => item['@type'] === 'FAQPage');
  assert.deepEqual(faq.mainEntity.filter(item => item.name !== 'What does it cost?'), before.mainEntity.filter(item => item.name !== 'What does it cost?'));
});

test('home FAQ answers are the same in the page and its structured data', async () => {
  const source = await read('landing/index.html');
  assert.equal(renderPublicLaunch(source, 'home', off), source);
  const output = renderPublicLaunch(source, 'home');
  const graph = jsonLd(output).flatMap(item => item['@graph'] || [item]);
  const faq = graph.find(item => item['@type'] === 'FAQPage');
  assert.equal(faq.mainEntity.length, 5);
  const visible = output.replace(/<script\b[\s\S]*?<\/script>/g, '').replace(/<[^>]+>/g, '');
  for (const answer of faq.mainEntity) {
    assert.ok(visible.includes(answer.name));
    assert.ok(visible.includes(answer.acceptedAnswer.text), `${answer.name}: same answer in HTML and JSON-LD`);
  }
  assert.equal(faq.mainEntity.find(item => item.name === 'Who is CredentialDOMD for?').acceptedAnswer.text, 'DOs, MDs, NPs and PAs. It tracks licenses and certifications for all four.');
  const cost = faq.mainEntity.find(item => item.name === 'How much does it cost?').acceptedAnswer.text;
  assert.match(cost, /^The Founder plan is \$99 a year while Founder spots last/);
  assert.match(cost, /Card required at checkout; the app confirms your offer before you pay\.$/);
  const offer = graph.find(item => item['@type'] === 'SoftwareApplication').offers;
  assert.deepEqual([offer.name, offer.price, offer.priceCurrency], ['Founder plan', '99', 'USD']);
  assert.match(visible, /Can my group use it\?Not yet\. Group features are on the roadmap\. Email support@credentialdomd\.com/);
  assert.doesNotMatch(output, /field testing right now|waitlist first, in order|Leave your email above|when your spot is ready|earliest names on the list|practices get priority onboarding/i);
  for (const slot of ['early-release', 'participation', 'promised-beta', 'lifetime-exception', 'practice-trial', 'refund-guarantee']) {
    const missing = source.replace(new RegExp(`<!-- public-launch:${slot} -->[\\s\\S]*?<!-- /public-launch:${slot} -->`), '');
    assert.throws(() => renderPublicLaunch(missing, 'home'), /Incomplete home migration/, slot);
  }
});

test('the home page cannot be printed with an older label, a later price or a reordered credential list', async () => {
  const source = await read('landing/index.html');
  const withText = text => source.replace('</main>', `<p>${text}</p></main>`);
  for (const text of ['Create your account', 'Create an account to begin', 'Then $149 a year', '$199/year', 'Credential + Practice is $245/year', 'For MDs and DOs', 'For DOS, MDS, NPS and PAS']) {
    assert.throws(() => renderPublicLaunch(withText(text), 'home'), /Founder home page must not print/, text);
  }
  assert.throws(() => renderPublicLaunch(source.replace('</main>', '<a href="/pricing">Sign up today</a></main>'), 'home'), /Sign up today link must open the app/);
  assert.throws(() => renderPublicLaunch(source.replace('<!-- public-launch:signup-link --><a class="btn" href="/app/">Sign up today</a>', '<!-- public-launch:signup-link --><a class="btn" href="/app/">Join now</a>'), 'home'), /signup link slot/);
  // The price in a structured answer is checked too, not only visible text.
  assert.throws(() => renderPublicLaunch(source.replace('</head>', '<script type="application/ld+json">{"@type":"Offer","price":"$149"}</script></head>'), 'home'), /Founder home page must not print/);
});

test('launch render rejects observed stale promises in visible copy and JSON-LD', async () => {
  const source = await read('landing/index.html');
  for (const text of ['CredentialDOMD is in field testing right now.',
    'Early access opens to the waitlist first, in order.', 'Leave your email above.',
    'You will get one message when your spot is ready.', 'The earliest names on the list get founding-member perks.',
    'Join the early-access list and mention your group size.', 'Practices get priority onboarding when the team features ship.',
    'Founding invitations', 'Invite-only beta', 'Billing is off.', 'An invited, signed-in account.', 'new invited physicians']) {
    assert.throws(() => renderPublicLaunch(source + `<p>${text}</p>`, 'home'), /Unmigrated public launch wording/, text);
    const schema = { '@type': 'FAQPage', mainEntity: [{ name: 'Availability', acceptedAnswer: { text } }] };
    assert.throws(() => renderPublicLaunch(source + `<script type="application/ld+json">${JSON.stringify(schema)}</script>`, 'home'), /Unmigrated public launch wording/, `structured: ${text}`);
  }
});

test('all 51 guides keep four requested-guide forms and facts while removing waitlist choices', async () => {
  const files = (await readdir(new URL('../landing/states/', import.meta.url))).filter(file => file.endsWith('.html') && file !== 'index.html');
  assert.equal(files.length, 51);
  let forms = 0;
  for (const file of files) {
    const source = await read(`landing/states/${file}`);
    const output = renderPublicLaunch(source, 'state-guides', paid);
    const count = (output.match(/<form\b[^>]*class="guide-form"/g) || []).length;
    assert.equal(count, 4, file);
    forms += count;
    assert.equal((output.match(/This form requests one guide\./g) || []).length, 4, file);
    assert.doesNotMatch(output, /<fieldset\b[^>]*class="guide-choice"/);
    assert.doesNotMatch(output, /<input\b[^>]*name="waitlist"/);
    assert.equal((output.match(/href="\/signup\/"/g) || []).length, 9, file);
    // The guides carry most of the traffic: each must state the founding offer once,
    // above the guide form, and point locums physicians at the practice tools.
    assert.equal((output.match(/class="guide-offer"/g) || []).length, 1, file);
    assert.match(output, /Founding Credential: \$99\/year while Founder spots last, Practice included while you are a member/, file);
    assert.ok(output.indexOf('class="guide-offer"') < output.indexOf('class="guide-form"'), `${file}: offer sits above the guide form`);
    assert.match(output, /href="\/locums"/, file);
    assert.match(output.slice(output.indexOf('class="guide-offer"'), output.indexOf('class="guide-form"')), /No-hassle 100% money-back guarantee/, `${file}: the offer button states the guarantee`);
    // Off mode leaves the page byte-for-byte as generated.
    assert.equal(renderPublicLaunch(source, 'state-guides', { ...paid, enabled: false }), source, `${file}: off mode unchanged`);
    assert.deepEqual(jsonLd(output), jsonLd(source), `${file}: preserve source-backed answers`);
    assert.deepEqual(scripts(output), scripts(source), `${file}: preserve search/guide/FAQ behavior`);
    assert.deepEqual(assets(output), assets(source), file);
  }
  assert.equal(forms, 204);
});

test('actual guide controller sends guide requests only, in either mode, even with a stale waitlist radio in a cached page', async () => {
  const source = await read('landing/states/ohio.html');
  const controller = scripts(source).find(script => script.includes("var ABBR = 'OH'"));
  assert.ok(controller);
  assert.doesNotMatch(source, /name="waitlist"|guide-choice"|wl-form/);
  for (const enabled of [false, true]) for (const selected of ['yes', 'no', null]) {
    const calls = [];
    const callbacks = [];
    const messages = [];
    const forms = ['hero', 'inline', 'end', 'sticky'].map(placement => {
      const message = { textContent: '', style: {} }; messages.push(message);
      const button = { textContent: 'Email me the guide', dataset: {} };
      return {
        parentElement: { querySelector: () => message },
        querySelector: selector => ({
          'input[type="email"]': { value: 'fixture@example.invalid' },
          'button[type="submit"]': button,
          '.guide-hp': { value: '' },
          '.guide-choice': { classList: { remove() {} } },
          'input[name="waitlist"]:checked': selected ? { value: selected } : null,
        })[selector],
        getAttribute: () => placement,
        addEventListener: (event, fn) => { assert.equal(event, 'submit'); callbacks.push(fn); },
        reset() {},
      };
    });
    vm.runInNewContext(controller.replace(/^<script[^>]*>|<\/script>$/g, ''), {
      document: { getElementById: () => null, querySelectorAll: () => forms,
        documentElement: { getAttribute: () => enabled ? 'founding-signup' : null } },
      location: { pathname: '/states/ohio' },
      localStorage: { setItem() {}, getItem() {} },
      fetch: async (path, options) => { calls.push({ path, payload: JSON.parse(options.body) }); return { ok: true, status: 200 }; },
      Date,
    });
    callbacks.forEach(fn => fn({ preventDefault() {} }));
    await new Promise(resolve => setImmediate(resolve));
    const submissions = calls.filter(call => call.path === '/api/guide-request');
    assert.equal(submissions.length, 4);
    assert.equal(calls.length, 4, 'one requested-guide write per form, and no attempt trace');
    for (const { payload } of submissions) {
      assert.deepEqual(Object.keys(payload).sort(), ['p_email', 'p_note', 'p_source']);
      assert.match(payload.p_note, /guide-email OH/);
    }
    messages.forEach(message => assert.doesNotMatch(message.textContent, /waitlist|spot opens/));
  }
});

test('help compilation adds refund request terms and updates Practice availability while preserving media and dates', async () => {
  const help = JSON.parse(await read('public/knowledge/credentialdo-help.json'));
  const original = structuredClone(help);
  const output = publicLaunchHelp(help, paid);
  assert.deepEqual(help, original, 'do not mutate the shared authored knowledge');
  for (const article of output.articles) {
    const old = original.articles.find(item => item.id === article.id);
    if (article.id === 'first-license') {
      assert.deepEqual(article.audience, ['physicians with active Credential access']);
      assert.match(article.availability, /signed-in account with active Credential access/);
      assert.match(article.availability, /NPI lookup needs a connection/);
      assert.deepEqual(article.notes.slice(0, -1), old.notes);
      assert.equal(article.notes.at(-1), publicLaunchPresentation(paid).availability);
      assert.deepEqual({ ...article, notes: old.notes, availability: old.availability, audience: old.audience }, old);
    } else if (article.id === 'locum-contract') {
      assert.match(article.availability, /^Founding Credential members have Practice included for as long as their membership stays active\. Eligible people/);
      assert.doesNotMatch(article.availability, /early bird/i);
      assert.deepEqual({ ...article, availability: old.availability }, old);
    } else if (article.id === 'get-help') {
      assert.deepEqual(article.notes.slice(0, -1), old.notes);
      assert.equal(article.notes.at(-1), publicLaunchPresentation(paid).refundGuarantee);
      assert.deepEqual({ ...article, notes: old.notes }, old);
    } else assert.deepEqual(article, old);
  }
  const catalog = await loadVideoCatalog(root);
  const originalHtml = renderHelp(help, catalog);
  const html = renderPublicLaunch(renderHelp(output, catalog), 'help', paid);
  assert.deepEqual(assets(html), assets(originalHtml));
  assert.deepEqual(scripts(html), scripts(originalHtml));
  const pages = renderWatchPages(output, catalog);
  assert.ok(pages.length > 0);
  for (const page of pages) {
    const published = renderPublicLaunch(page.html, 'watch-pages', paid);
    assert.deepEqual(assets(published), assets(page.html));
    assert.match(published, /href="\/signup\/"/);
    assert.ok(published.includes(output.articles.find(article => article.id === page.id).updatedAt));
  }
});

test('CME search, filters, source register, public facts and resource destinations stay unchanged', async () => {
  const source = await read('landing/cme.html');
  const output = renderPublicLaunch(source, 'cme', paid);
  const start = source.indexOf('<section id="vera-guide"');
  const end = source.indexOf('<section id="next-step"');
  assert.ok(start > 0 && end > start);
  assert.ok(output.includes(source.slice(start, end)));
  const register = source.match(/<details id="sources"[\s\S]*?<\/details>/)[0];
  assert.ok(output.includes(register));
  assert.deepEqual(scripts(output), scripts(source));
  assert.deepEqual(assets(output), assets(source));
});

test('paid rendering rejects missing or stray slots and current legal contradictions', async () => {
  const home = await read('landing/index.html');
  assert.throws(() => renderPublicLaunch(home.replace(/<!-- public-launch:signup-link -->[\s\S]*?<!-- \/public-launch:signup-link -->/g, ''), 'home', paid), /Incomplete home migration: signup-link/);
  assert.throws(() => renderPublicLaunch(home + '<a href="/#join">Join the waitlist</a>', 'home', paid), /Unmigrated public launch wording/);
  assert.throws(() => renderPublicLaunch(home + '<!-- public-launch:unknown -->x<!-- /public-launch:unknown -->', 'home', paid), /Unknown public launch slot/);
  const staleTerms = renderLegalPages(off)['terms.html'];
  assert.throws(() => renderPublicLaunch(staleTerms, 'legal-navigation', paid), /Unmigrated public launch wording.*(?:invite-only beta|billing is off)/i);
  const currentTerms = await read('landing/terms.html');
  assert.doesNotThrow(() => renderPublicLaunch(currentTerms, 'legal-navigation'));
});

test('public and in-app legal documents use production defaults and retain an explicit OFF fixture', async () => {
  const prior = getLegalDocuments(off);
  const current = getLegalDocuments();
  assert.deepEqual(PRIVACY, current.privacy);
  assert.deepEqual(TERMS, current.terms);
  assert.match(prior.terms.sections[0].blocks[0], /billing is off/);
  assert.match(current.terms.sections[0].blocks[0], /paid membership in an early release/);
  assert.doesNotMatch(JSON.stringify(current.terms), /billing is off|Paid membership has not launched/);
  const on = getLegalDocuments(paid);
  assert.deepEqual(on, current, 'alternate reviewed signup route does not change legal terms');
  assert.equal(on.privacy.updated, 'September 25, 2026');
  assert.equal(on.terms.updated, 'November 16, 2026');
  const privacy = structuredClone(on.privacy);
  privacy.intro[1] = privacy.intro[1].replace('is in early release.', 'is in free beta.');
  privacy.updated = prior.privacy.updated;
  assert.deepEqual(privacy, prior.privacy, 'mode changes only release description and publication date');
  for (let i = 0; i < on.terms.sections.length; i++) {
    const section = on.terms.sections[i];
    const old = prior.terms.sections[i];
    if (i === 0) {
      assert.equal(section.title, '1. Membership, early release and pricing');
      assert.equal(section.blocks[1], old.blocks[1], 'existing September 19 lifetime promise');
      assert.match(section.blocks[2], /30 days free with no card/);
      assert.match(section.blocks[2], /opt in to \$99 per year Credential during the beta/);
      assert.match(section.blocks[2], /first charge is scheduled for your original beta end date, when your paid year starts/);
      assert.match(section.blocks[2], /If an unfinished checkout is completed after the original beta end date/);
      // Owner approved, 2026-11-16: the $99 founding terms, and no later price.
      assert.match(section.blocks[3], /^Paid founding members get Credential for \$99 per year while Founder spots last\. Founding members keep their annual rate/);
      assert.match(section.blocks[3], /for life while their membership remains continuously active/);
      assert.equal(section.blocks[4], 'Founding Credential at $99 per year includes Practice while you are a member.');
      assert.doesNotMatch(JSON.stringify(on.terms), /\$\s?(?:149|199|245)\b/);
      // One price style per block: "per year", never "/year".
      assert.doesNotMatch(section.blocks[4], /\/year/);
      // Founding Credential includes Practice, so the terms never also say the
      // package has "no founding discount".
      assert.doesNotMatch(section.blocks[4], /no founding/);
      assert.equal(section.blocks[5], publicLaunchPresentation(paid).practiceTrial);
      assert.match(section.blocks[5], /first annual payment is confirmed/);
      assert.match(section.blocks[5], /Early bird and standard members who want Practice after the trial can contact support@credentialdomd.com to review options/);
      assert.match(section.blocks[5], /no change or charge will occur without their agreement/);
      assert.match(section.blocks[5], /read and export/);
      assert.equal(section.blocks[6], old.blocks[5]);
      assert.equal(section.blocks[7], publicLaunchPresentation(paid).refundGuarantee);
    } else if (i === 7) assert.equal(section.blocks[0], old.blocks[0].replace('During beta', 'During early release'));
    else if (i === 9) assert.equal(section.blocks[0], old.blocks[0].replace(', which during the free beta is zero', '') + ' These warranty and liability limitations do not limit the annual-payment refund guarantee in section 1.');
    else assert.deepEqual(section, old, old.title);
  }
  assert.deepEqual(on.terms.intro, prior.terms.intro, 'legal operator and acceptance unchanged');
  assert.ok(on.terms.intro[0].includes(LEGAL_OPERATOR));
  const sourcePages = renderLegalPages();
  const paidPages = renderLegalPages(paid);
  for (const name of ['privacy.html', 'terms.html']) {
    assert.equal(sourcePages[name], await read(`landing/${name}`));
    assert.equal(sourcePages[name], await read(`public/${name}`));
    const output = renderPublicLaunch(paidPages[name], 'legal-navigation', paid);
    assert.match(output, /href="\/signup\/"/);
    assert.ok(output.includes(LEGAL_OPERATOR));
  }
  assert.match(paidPages['terms.html'], /opt in to \$99 per year Credential during the beta/);
  assert.match(paidPages['terms.html'], /most recent annual membership payment, including a renewal payment, at any time/);
  assert.match(paidPages['terms.html'], /no request deadline or prorating/);
  assert.match(paidPages['terms.html'], /not all payments from past years/);
  assert.match(paidPages['terms.html'], /limitations do not limit the annual-payment refund guarantee/);
  assert.match(paidPages['privacy.html'], /is in early release/);
});

test('both legal modes retain factual device-storage and AI-provider disclosures', () => {
  for (const mode of [off, PUBLIC_LAUNCH_MODE]) {
    const { privacy, terms } = getLegalDocuments(mode);
    const privacyText = JSON.stringify(privacy);
    const termsText = JSON.stringify(terms);
    assert.match(privacyText, /Cached records and private notes are not separately encrypted by the app/);
    assert.match(privacyText, /Gemini API or Anthropic’s Claude API/);
    assert.match(privacyText, /Signing out, clearing browser storage or losing the device can remove the local copy/);
    assert.match(termsText, /not separately encrypted by the app, and manual exports are readable files/);
    assert.doesNotMatch(privacyText + termsText, /private (?:vault|notes).*end-to-end encrypted/i);
  }
});

// Signup review 2026-10-07: on a phone the home page's first screen had no
// signup button. The unified home page (2026-11-15) keeps one in the hero,
// right under the offer (asserted above), and "Sign up" in its header, which
// stays on screen; the older page's separate sticky bar is gone with it.
test('home: a signup link is in the header and the hero; other pages unchanged', async () => {
  const source = await read('landing/index.html');
  const output = renderPublicLaunch(source, 'home');
  assert.match(await read('public/unified.css'), /header\.site\{position:sticky;top:0/);
  assert.match(output.slice(output.indexOf('<header'), output.indexOf('</header>')), />Sign up<\/a>/);
  assert.match(output.slice(output.indexOf('<section class="hero"'), output.indexOf('<section id="how">')), />Sign up today<\/a>/);
  assert.doesNotMatch(renderPublicLaunch(await read('landing/locums.html'), 'locums'), /data-hero-signup/);
  assert.equal(renderPublicLaunch(source, 'home', { enabled: false }), source);
});
