import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { renderPublicLaunch, publicLaunchHelp, publicLaunchCostAnswer } from '../scripts/public-launch-render.mjs';
import { publicLaunchPresentation } from '../src/content/publicLaunch.mjs';
import { renderHelp } from '../scripts/build-help.mjs';
import { renderWatchPages } from '../scripts/watch-pages.mjs';
import { loadVideoCatalog } from '../scripts/help-videos.mjs';
import { getLegalDocuments, PRIVACY, TERMS, LEGAL_OPERATOR } from '../src/content/legalText.js';
import { renderLegalPages } from '../scripts/generate-legal-pages.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
// This route is an offline fixture, not a claim that signup is deployed.
const paid = { enabled: true, signupHref: '/signup/' };
const scripts = html => [...html.matchAll(/<script\b[^>]*>[\s\S]*?<\/script>/g)].map(match => match[0]);
const assets = html => [...html.matchAll(/(?:src|poster)="([^"]+)"/g)].map(match => match[1]);
const jsonLd = html => [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map(match => JSON.parse(match[1]));

test('default mode leaves source HTML bytes, waitlist fields and widget choices intact', async () => {
  for (const [path, surface] of [['index', 'home'], ['locums', 'locums'], ['help', 'help'], ['cme', 'cme'], ['states/ohio', 'state-guides'], ['states/index', 'state-index'], ['terms', 'legal-navigation']]) {
    const html = await read(`landing/${path}.html`);
    assert.equal(renderPublicLaunch(html, surface), html, path);
  }
});

test('paid home and locums expose static navigation and cannot submit a disguised waitlist form', async () => {
  for (const [path, surface] of [['index', 'home'], ['locums', 'locums']]) {
    const source = await read(`landing/${path}.html`);
    const output = renderPublicLaunch(source, surface, paid);
    assert.doesNotMatch(output, /<form\b[^>]*\bclass="[^"]*wl-form/);
    assert.doesNotMatch(output, /type="email"/);
    assert.ok((output.match(/href="\/signup\/"/g) || []).length >= 4);
    assert.match(output, />Sign up as a founding member<\/a>/);
    assert.match(output, /less polished/);
    assert.match(output, /support tickets/);
    assert.match(output, /locked for life while their membership remains active/);
    assert.match(output, /no founding or early-bird discount/);
    assert.match(output, /earlier free-beta wording/);
    assert.match(output, /30 days free with no card/);
    assert.match(output, /separate 30-day Practice trial/);
    assert.deepEqual(assets(output), assets(source), 'preserve physician photos and all runtime sources');
    assert.match(output, /href="\/app\/"/, 'existing sign-in remains available');
  }
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
    assert.equal((output.match(/href="\/signup\/"/g) || []).length, 8, file);
    assert.deepEqual(jsonLd(output), jsonLd(source), `${file}: preserve source-backed answers`);
    assert.deepEqual(scripts(output), scripts(source), `${file}: preserve search/guide/FAQ behavior`);
    assert.deepEqual(assets(output), assets(source), file);
  }
  assert.equal(forms, 204);
});

test('actual guide controller forces guide-only even with a stale selected waitlist radio', async () => {
  const source = await read('landing/states/ohio.html');
  const controller = scripts(source).find(script => script.includes("var ABBR = 'OH'"));
  assert.ok(controller);
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
    const submissions = calls.filter(call => call.path === '/api/waitlist');
    assert.equal(submissions.length, 4);
    assert.equal(calls.length, 8, 'one best-effort attempt trace and one requested-guide write per form');
    for (const { payload } of submissions) {
      assert.equal(payload.p_stage, 'guide');
      assert.equal(payload.p_waitlist, !enabled && selected === 'yes');
      assert.match(payload.p_note, /guide-email OH/);
    }
    if (enabled) messages.forEach(message => assert.doesNotMatch(message.textContent, /waitlist|spot opens/));
  }
});

test('help compilation changes only Practice availability and preserves all reviewed media and dates', async () => {
  const help = JSON.parse(await read('public/knowledge/credentialdo-help.json'));
  const original = structuredClone(help);
  const output = publicLaunchHelp(help, paid);
  assert.deepEqual(help, original, 'do not mutate the shared authored knowledge');
  for (const article of output.articles) {
    const old = original.articles.find(item => item.id === article.id);
    if (article.id === 'locum-contract') {
      assert.match(article.availability, /separate 30-day Practice trial/);
      assert.deepEqual({ ...article, availability: old.availability }, old);
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
  assert.throws(() => renderPublicLaunch(home.replace(/<!-- public-launch:form -->[\s\S]*?<!-- \/public-launch:form -->/, ''), 'home', paid), /Incomplete home migration: form/);
  assert.throws(() => renderPublicLaunch(home + '<a href="/#join">Join the waitlist</a>', 'home', paid), /Unmigrated public launch wording/);
  assert.throws(() => renderPublicLaunch(home + '<!-- public-launch:unknown -->x<!-- /public-launch:unknown -->', 'home', paid), /Unknown public launch slot/);
  const terms = await read('landing/terms.html');
  assert.throws(() => renderPublicLaunch(terms, 'legal-navigation', paid), /Unmigrated public launch wording.*billing is off/i);
});

test('public and in-app legal documents share the mode and change only approved commercial passages', async () => {
  const off = getLegalDocuments();
  assert.strictEqual(PRIVACY, off.privacy);
  assert.strictEqual(TERMS, off.terms);
  const on = getLegalDocuments(paid);
  const privacy = structuredClone(on.privacy);
  privacy.intro[1] = privacy.intro[1].replace('is in early release.', 'is in free beta.');
  assert.deepEqual(privacy, off.privacy, 'privacy changes only release description');
  for (let i = 0; i < on.terms.sections.length; i++) {
    const section = on.terms.sections[i];
    const old = off.terms.sections[i];
    if (i === 0) {
      assert.equal(section.title, '1. Membership, early release and pricing');
      assert.equal(section.blocks[1], old.blocks[1], 'existing September 19 lifetime promise');
      assert.match(section.blocks[2], /30 days free with no card/);
      assert.match(section.blocks[2], /explicit \$99 per year Credential purchase/);
      assert.match(section.blocks[3], /\$99.*\$149.*\$199/);
      assert.match(section.blocks[3], /for life while their membership stays active/);
      assert.equal(section.blocks[4], old.blocks[3], '$245 undiscounted package unchanged');
      assert.equal(section.blocks[5], old.blocks[4].replace('At paid launch, a new Credential membership will include', 'A new paid Credential membership includes'));
      assert.match(section.blocks[5], /read and export/);
      assert.equal(section.blocks[6], old.blocks[5]);
    } else if (i === 7) assert.equal(section.blocks[0], old.blocks[0].replace('During beta', 'During early release'));
    else if (i === 9) assert.equal(section.blocks[0], old.blocks[0].replace(', which during the free beta is zero', ''));
    else assert.deepEqual(section, old, old.title);
  }
  assert.deepEqual(on.terms.intro, off.terms.intro, 'legal operator and acceptance unchanged');
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
  assert.match(paidPages['terms.html'], /requires an explicit \$99 per year Credential purchase/);
  assert.match(paidPages['privacy.html'], /is in early release/);
});
