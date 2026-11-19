// The physician assistant and nurse practitioner renewal guides
// (scripts/build-profession-guides.mjs, landing/states/physician-assistant and
// landing/states/nurse-practitioner).
//
// What must hold for all 102 pages:
//   * the page on disk is what the generator makes from the rule data today;
//   * nothing the data marks unverified is printed as a requirement, and every
//     open item is listed under "Not yet verified";
//   * every statement with a number in it carries a link to its source, and
//     every source link is https and listed under Sources;
//   * a license whose rules are not verified is kept out of search;
//   * no fee and no expiration date is stated (the data has neither);
//   * the page passes the paid launch renderer and reaches the sitemap only
//     when it is indexable.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildProfessionGuides, PROFESSIONS, REMINDER_GUIDES_FILE, reminderGuidesJson } from '../scripts/build-profession-guides.mjs';
import { renderPublicLaunch } from '../scripts/public-launch-render.mjs';
import { PROFESSION_GUIDE_DIRS, addGuidePagesToSitemap } from '../scripts/package-site.mjs';
import { PA_STATE_RULES } from '../src/constants/paStateRules.js';
import { NP_STATE_RULES } from '../src/constants/npStateRules.js';

const read = rel => fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
const unescape = s => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&rarr;/g, '').replace(/&#39;/g, "'");
const visible = html => unescape(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
const body = html => html.slice(html.indexOf('<!-- HERO -->'), html.indexOf('<!-- CTA -->'));
const section = (html, heading) => { const i = html.indexOf(`<h2>${heading}</h2>`); if (i < 0) return ''; const j = html.indexOf('</section>', i); return html.slice(i, j); };
const pages = buildProfessionGuides();
const sectionsOf = page => page.profession === 'pa' ? [PA_STATE_RULES[page.state]] : [NP_STATE_RULES[page.state].aprn, NP_STATE_RULES[page.state].rn];

test('there are 102 guides, 51 for each profession, and the pages on disk are current', () => {
  assert.equal(pages.length, 102);
  for (const p of Object.keys(PROFESSIONS)) assert.equal(pages.filter(x => x.profession === p).length, 51);
  assert.deepEqual(Object.values(PROFESSIONS).map(p => p.dir), [...PROFESSION_GUIDE_DIRS]);
  for (const page of pages) assert.equal(read(page.file), page.html, `${page.file} is stale; run node scripts/build-profession-guides.mjs`);
  for (const dir of PROFESSION_GUIDE_DIRS) assert.equal(fs.readdirSync(new URL(`../landing/states/${dir}/`, import.meta.url)).length, 51, `${dir} holds only its 51 pages`);
});

test('a license with no verified rules is kept out of search, and only those are', () => {
  for (const page of pages) {
    const unverified = page.profession === 'pa' ? PA_STATE_RULES[page.state].status === 'unverified' : NP_STATE_RULES[page.state].aprn.status === 'unverified';
    assert.equal(page.indexable, !unverified, page.file);
    assert.equal(/<meta name="robots" content="noindex">/.test(page.html), unverified, page.file);
    if (unverified) assert.match(visible(page.html), /We have not yet verified the .* rules for this license/, page.file);
  }
  assert.ok(pages.filter(p => !p.indexable).length <= 6, 'most pages are indexable');
});

test('only verified rules are printed as requirements; every open item is listed as not yet verified', () => {
  for (const page of pages) {
    const html = body(page.html);
    const text = visible(html);
    const open = section(page.html, 'Not yet verified');
    for (const sec of sectionsOf(page)) {
      const verified = sec.topics.filter(t => t.status === 'verified');
      for (const t of verified) assert.ok(html.includes(`<strong>${t.topic.replace(/&/g, '&amp;')}</strong>`), `${page.file}: ${t.topic}`);
      // The hour total is printed only in hours mode, and then exactly.
      if (sec.ceMode === 'hours') assert.ok(text.includes(`${sec.total.toLocaleString('en-US')} ${sec.total === 1 ? sec.unit.replace(/s$/, '') : sec.unit} every`), `${page.file}: ${sec.kind} total`);
      if (sec.ceMode === 'unverified') assert.match(text, /The continuing education requirement for this license is not yet verified/, page.file);
      if (sec.licenseCycle == null) assert.match(text, /How often this license renews is not yet verified/, page.file);
      for (const item of sec.unverified || []) assert.ok(visible(open).includes(item.item.replace(/\s+/g, ' ').trim()), `${page.file}: open item missing: ${item.item}`);
      // An unverified topic's working text never appears among the requirements.
      for (const t of sec.topics.filter(t => t.status === 'unverified')) {
        const required = html.split('<h2>Not yet verified</h2>')[0];
        if (!verified.some(v => v.topic === t.topic)) assert.ok(!required.includes(`<strong>${t.topic}</strong>`), `${page.file}: unverified topic printed as required: ${t.topic}`);
      }
    }
    const count = (html.match(/<h3>Required topics<\/h3>\s*<ul class="rule-list">([\s\S]*?)<\/ul>/g) || []).reduce((n, block) => n + (block.match(/<li>/g) || []).length, 0);
    assert.equal(count, sectionsOf(page).reduce((n, sec) => n + sec.topics.filter(t => t.status === 'verified').length, 0), `${page.file}: required topic count`);
  }
});

test('every statement with a number carries its source, and every source is https and listed', () => {
  let statements = 0;
  for (const page of pages) {
    const html = body(page.html);
    const sources = section(page.html, 'Sources');
    for (const [, , inner] of html.matchAll(/<(li|p)\b[^>]*>([\s\S]*?)<\/\1>/g)) {
      const text = visible(inner);
      if (!/\d/.test(text)) continue;
      // Category names with a digit in a "not yet verified" line, and the two framing lines, state no figure.
      if (/^Not yet verified toward/.test(text) || /are not in this guide/.test(text) || /checked against the board's own rules in/.test(text)) continue;
      statements++;
      assert.ok(inner.includes('class="cite"'), `${page.file}: no source for: ${text.slice(0, 140)}`);
    }
    for (const [, href] of html.matchAll(/<a class="cite" href="([^"]+)"/g)) {
      assert.match(href, /^https:\/\//, `${page.file}: ${href}`);
      // A board link on an open item is the board, not a cited source.
      if (!section(page.html, 'Not yet verified').includes(`href="${href}"`)) assert.ok(sources.includes(`href="${href}"`), `${page.file}: source not listed: ${href}`);
    }
  }
  assert.ok(statements > 1000, `only ${statements} sourced statements`);
});

test('no fee, no expiration date, and none of the claims the site never makes', () => {
  for (const page of pages) {
    const text = visible(body(page.html));
    assert.match(text, /The renewal fee and the date your own license expires are not in this guide/, page.file);
    assert.doesNotMatch(text, /HIPAA|SOC 2|primary source verif/i, page.file);
    assert.doesNotMatch(page.html, /\{\{[A-Z_]+\}\}|undefined|\bNaN\b|\[object Object\]/, `${page.file}: unfilled value`);
    assert.doesNotMatch(text, /\bnull\b/, `${page.file}: null printed`);
    assert.equal((page.html.match(/<h1>/g) || []).length, 1, page.file);
    assert.match(page.html, new RegExp(`<link rel="canonical" href="https://credentialdomd\\.com${page.path}">`), page.file);
  }
});

test('the wording this script adds has no dashes; the two guides and the physician guide link to each other', () => {
  const source = read('scripts/build-profession-guides.mjs');
  // Strings the script writes itself (curated data text is printed as it is).
  const authored = [...source.matchAll(/(?:p\(|extra\.push\(|items\.push\(|<h2>|<h3>|<p>)[`'"]?([^`'"\n]*)/g)].map(m => m[1].replace(/\$\{[^}]*\}/g, '')).join(' ');
  assert.doesNotMatch(authored, /[–—]/);
  for (const page of pages) {
    const slug = page.path.split('/').pop();
    const other = page.profession === 'pa' ? 'nurse-practitioner' : 'physician-assistant';
    assert.ok(page.html.includes(`href="/states/${other}/${slug}"`), `${page.file}: link to the other guide`);
    assert.ok(page.html.includes(`href="/states/${slug}"`), `${page.file}: link to the physician guide`);
    const physician = read(`landing/states/${slug}.html`);
    assert.ok(physician.includes(`href="/states/physician-assistant/${slug}"`) && physician.includes(`href="/states/nurse-practitioner/${slug}"`), `${slug}: the physician guide links to both`);
  }
});

test('every guide passes the paid launch renderer, and only indexable ones reach the sitemap', () => {
  for (const page of pages) {
    const out = renderPublicLaunch(page.html, 'profession-guides', undefined, { offerEndpoint: 'https://example.supabase.co/functions/v1/public-membership-offer' });
    assert.doesNotMatch(out, /<!-- public-launch:/, page.file);
    assert.match(out, /Sign up today/, page.file);
    assert.doesNotMatch(visible(out.replace(/<script\b[\s\S]*?<\/script>/g, '')), /waitlist|invitation|Request an invite/i, page.file);
  }
  const base = '<urlset>\n</urlset>\n';
  const routes = pages.filter(p => p.indexable).map(p => p.path);
  const sitemap = addGuidePagesToSitemap(base, routes);
  assert.equal((sitemap.match(/<url>/g) || []).length, routes.length);
  for (const p of pages.filter(p => !p.indexable)) assert.ok(!sitemap.includes(p.path), `${p.path} must stay out of the sitemap`);
  assert.throws(() => addGuidePagesToSitemap(sitemap, [routes[0]]), /Duplicate/);
  assert.throws(() => addGuidePagesToSitemap(base, ['/states/../x']), /Invalid guide route/);
});

test('indexable guides carry the reminder form for their own profession and state; the sender facts are current', () => {
  assert.equal(read(REMINDER_GUIDES_FILE), reminderGuidesJson(pages), `${REMINDER_GUIDES_FILE} is stale; run node scripts/build-profession-guides.mjs`);
  for (const page of pages) {
    const forms = (page.html.match(/<form class="reminder-form"/g) || []).length;
    assert.equal(forms, page.indexable ? 1 : 0, `${page.file}: reminder form`);
    if (!page.indexable) { assert.doesNotMatch(page.html, /guide_reminder_signup/, page.file); continue; }
    assert.ok(page.html.includes(`var ABBR = '${page.state}';`), `${page.file}: state`);
    assert.ok(page.html.includes(`p_state: ABBR, p_profession: '${page.profession}',`), `${page.file}: profession`);
    assert.match(page.html, new RegExp(`Get a reminder before your [A-Za-z .]+ ${PROFESSIONS[page.profession].noun} license renews`), page.file);
    assert.doesNotMatch(/<input type="checkbox" name="updates"[^>]*>/.exec(page.html)[0], /checked/, `${page.file}: the product news box starts unticked`);
    // Nothing unverified reaches the email facts.
    assert.ok(page.reminder.lines.every(([, value]) => value !== 'Not yet verified'), page.file);
    assert.equal(page.reminder.guide, `https://credentialdomd.com${page.path}`);
  }
});

test('the states index links each state to its PA and NP guide, and only to guides with verified rules', () => {
  const index = read('landing/states/index.html');
  const cells = [...index.matchAll(/<div class="state-cell" data-state="([^"]+)">\s*<a href="\/states\/([a-z-]+)" class="state-card" data-state="\1">[\s\S]*?<\/a>\s*(?:<div class="state-pro">([\s\S]*?)<\/div>\s*)?<\/div>/g)];
  assert.equal(cells.length, 51);
  const linked = new Set();
  for (const [, , slug, links = ''] of cells) {
    for (const [, href] of links.matchAll(/href="([^"]+)"/g)) {
      assert.match(href, new RegExp(`^/states/(physician-assistant|nurse-practitioner)/${slug}$`), `${slug}: ${href}`);
      linked.add(href);
    }
  }
  assert.deepEqual([...linked].sort(), pages.filter(p => p.indexable).map(p => p.path).sort());
  assert.equal(linked.size, 98);
  // The search hides the whole cell, so no PA or NP link is left behind for a hidden state.
  assert.match(index, /stateGrid\.querySelectorAll\('\.state-cell'\)/);
  assert.doesNotMatch(index, /stateGrid\.querySelectorAll\('\.state-card'\)/);
  renderPublicLaunch(index, 'state-index', undefined, { offerEndpoint: 'https://example.supabase.co/functions/v1/public-membership-offer' });
});
