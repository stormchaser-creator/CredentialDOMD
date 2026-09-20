import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { renderHelp } from '../scripts/build-help.mjs';
import { loadVideoCatalog } from '../scripts/help-videos.mjs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = file => readFile(new URL(`../${file}`, import.meta.url), 'utf8');

for (const page of ['index', 'locums']) {
  test(`${page}: public paid invitation, promised beta, and lifetime exception are distinct`, async () => {
    const html = await read(`landing/${page}.html`);
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
test('regenerated help retains content and distinguishes current beta from paid Practice trial', async () => {
  const help = JSON.parse(await read('public/knowledge/credentialdo-help.json'));
  const html = await read('landing/help.html');
  const videos = await loadVideoCatalog(root);
  assert.equal(renderHelp(help, videos), html);
  const availability = help.articles.find(article => article.id === 'locum-contract').availability;
  assert.match(availability, /existing invited beta users/);
  assert.match(availability, /new paid Credential members/);
  assert.match(availability, /Earlier free-beta signups/);
  assert.match(html, /Card required at future paid checkout/);
  assert.doesNotMatch(html, /Free invite-only beta/);
});
