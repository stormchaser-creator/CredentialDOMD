// The state guides after the 2026-11-13 recheck: every guide shows the date
// it was last verified, the federal DEA training line and the disclaimer;
// an item the recheck could not confirm is named without restating its
// value; and the /states hub cards are written from the same data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const data = JSON.parse(await read('landing/states/states-data.json'));
const text = html => html.replace(/<(script|style)\b[\s\S]*?<\/\1>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&ldquo;|&rdquo;/g, '"').replace(/\s+/g, ' ');
const section = (html, heading) => { const at = html.indexOf(heading); return at < 0 ? '' : html.slice(at, html.indexOf('</section>', at)); };

test('every guide states when it was last verified, the MATE Act line and the disclaimer', async () => {
  assert.equal(data.states.length, 51);
  for (const state of data.states) {
    const html = await read(`landing/states/${state.slug}.html`);
    const page = text(html);
    assert.ok(state.lastVerifiedLabel, state.slug);
    assert.ok(page.includes(`Last verified: ${state.lastVerifiedLabel}.`), `${state.slug}: date by the quick facts`);
    assert.ok(page.includes(`Last verified against official sources on ${state.lastVerifiedLabel}.`), `${state.slug}: date in the sources`);
    assert.doesNotMatch(page, /, recently\.|Double-checked against a second official source|From the board's own pages, August 2026/, state.slug);
    const training = text(section(html, '    Required training and audits\n  </h2>'));
    assert.match(training, /Federal: one-time 8 hours on opioid\/substance use disorder treatment for all DEA registrants \(MATE Act\), attested on the first DEA registration or renewal on or after June 27, 2023\./, state.slug);
    assert.ok(html.includes(`href="${state.mateAct.source}"`), `${state.slug}: MATE source link`);
    for (const key of ['firstRenewal', 'audit']) if (state[key]) assert.ok(training.includes(state[key].text.replace(/^First renewal:\s*/i, '').replace(/\.$/, '')), `${state.slug}: ${key}`);
    assert.ok(text(section(html, 'Where this comes from')).trim().endsWith(state.disclaimer), `${state.slug}: disclaimer ends the sources section`);
    for (const source of state.sources) assert.ok(html.includes(`href="${source.url.replace(/&/g, '&amp;')}"`), `${state.slug}: ${source.url}`);
    assert.match(html, new RegExp(`<link rel="canonical" href="https://credentialdomd\\.com/states/${state.slug}">`));
    assert.match(html, new RegExp(`<title>${state.name} Medical License Renewal `));
    assert.doesNotMatch(html, /name="robots" content="noindex/);
  }
});

test('an unconfirmed item is named with its note and never with its unconfirmed value', async () => {
  let open = 0;
  for (const state of data.states) {
    const html = await read(`landing/states/${state.slug}.html`);
    const pending = section(html, 'Still being confirmed with the board');
    if (!state.unverified.length) { assert.equal(pending, '', `${state.slug}: no empty list`); continue; }
    open += 1;
    assert.equal((pending.match(/<li>/g) || []).length, state.unverified.length, state.slug);
    for (const item of state.unverified) assert.ok(text(pending).includes(item.note), `${state.slug}: ${item.field}`);
    assert.match(text(html), /still being confirmed with the board; see "Required training and audits" below\./, state.slug);
    assert.match(html, new RegExp(`${state.lastVerifiedLabel} \\(some items still being confirmed\\)`), `${state.slug}: hero and description say so`);
  }
  assert.equal(open, 33);
  // The list is built from the field and the note only.
  const generator = await read('landing/states/generate.js');
  assert.doesNotMatch(generator, /liveValue/);
});

test('the /states hub cards are written from the guide data', async () => {
  const hub = await read('landing/states/index.html');
  const cards = [...hub.matchAll(/<a href="\/states\/([a-z-]+)" class="state-card"[\s\S]*?<\/a>/g)];
  assert.equal(cards.length, 51);
  for (const [card, slug] of cards) {
    const state = data.states.find(s => s.slug === slug);
    const shown = text(card);
    assert.ok(shown.includes(state.renewalCycle.match(/^(Annual|Biennial|Triennial)/)[1]), `${slug}: cycle`);
    if (state.cmeHours > 0) assert.ok(shown.includes(`${state.cmeHours} CME hrs`), `${slug}: CME hours`);
    else assert.match(shown, /No (general|fixed) CME/, slug);
    const fee = shown.match(/\$[\d,]+/);
    if (fee) assert.ok(state.renewalFee.includes(fee[0]), `${slug}: fee ${fee[0]}`);
  }
});

test('only New York overrides its title and description CME phrase', async () => {
  assert.deepEqual(data.states.filter(s => s.seo).map(s => s.abbreviation), ['NY']);
  const html = await read('landing/states/new-york.html');
  assert.match(html, /<title>New York Medical License Renewal \d{4}: \$600 fee, no hour minimum, mandatory training \| CredentialDOMD<\/title>/);
  assert.match(html, /no CME hour minimum but mandatory infection-control and prescriber training/);
});
