// SETTINGS-016: 'Find' beside a mandatory topic (Settings > CME Requirements,
// or a state's CME details) opened Find CME filtered to that topic. For 16
// topics no listed provider carries it (FL Laws and Rules, IL Mandated
// Reporter Training, PA Organ and Tissue Donation, CT Sexual Assault, MA
// Electronic Health Records and more), so the page said only "No providers
// match your filters".
import test from 'node:test';
import assert from 'node:assert/strict';
import { STATE_REQS, getStateEntry } from '../src/constants/stateRequirements.js';
import { CME_PROVIDERS } from '../src/constants/cmeProviders.js';
import { mountComponent } from './component-harness.mjs';

const sources = await import('../src/utils/cmeTopicSources.js').catch(() => null);
const src = rel => new URL(`../src/${rel}`, import.meta.url).href;

test('every mandatory topic with hours has a provider or a board page to send the member to', () => {
  assert.ok(sources, 'src/utils/cmeTopicSources.js exists');
  const carried = new Set(CME_PROVIDERS.flatMap(p => p.topics));
  const stranded = [];
  for (const st of Object.keys(STATE_REQS)) for (const deg of ['MD', 'DO']) {
    for (const t of getStateEntry(st, deg)?.topics || []) {
      if (!(t.hours > 0) || carried.has(t.topic)) continue;
      if (!sources.topicSources(t.topic, [st], deg).length) stranded.push(`${st} ${deg} ${t.topic}`);
    }
  }
  assert.deepEqual(stranded, []);
});

test('the board page is the topic\'s own link when it has one, else the state\'s source', () => {
  const [fl] = sources.topicSources('Florida Laws and Rules', ['FL'], 'DO');
  assert.equal(fl.state, 'FL');
  assert.equal(fl.url, getStateEntry('FL', 'DO').topics.find(t => t.topic === 'Florida Laws and Rules').url || getStateEntry('FL', 'DO').sourceUrl);
  assert.deepEqual(sources.topicSources('Not a topic', ['FL'], 'DO'), []);
  assert.ok(sources.topicSources('Florida Laws and Rules', [], 'DO').length, 'a link from outside the tracked states still finds its state');
});

async function page(topic, states, degreeType) {
  const app = { data: { settings: { degreeType, specialties: [] }, cme: [], licenses: [] }, theme: {}, allTrackedStates: states };
  return mountComponent('src/components/features/CMEResourcesSection.jsx', { app, props: { initialTopicFilter: topic }, modules: {
    cmeProviders: await import(src('constants/cmeProviders.js')), cmeTopicSources: sources,
    compliance: { complianceFor: () => ({ topicResults: [], noGeneralReq: true, totalRequired: 0, totalEarned: 0, cat1Required: 0, cat1Earned: 0, fullyCompliant: true }) },
    creditEquivalence: { providerAoaLine: () => '' },
  } });
}

test('Find on a topic no provider carries shows the board page and a way back to every provider', async () => {
  const c = await page('Florida Laws and Rules', ['FL'], 'DO');
  const text = c.pageText();
  assert.doesNotMatch(text, /No providers match your filters/);
  assert.match(text, /No provider in this list carries Florida Laws and Rules yet/);
  const link = c.nodes().find(n => n.type === 'a' && /FL board/.test(c.text(n)));
  assert.ok(link, 'the board page is linked');
  assert.match(link.props.href, /^https?:\/\//);
  assert.equal(link.props.rel, 'noopener noreferrer');
  const all = c.nodes().find(n => n.type === 'button' && c.text(n) === 'Show all providers');
  all.props.onClick();
  assert.doesNotMatch(c.pageText(), /No provider in this list carries/);
  assert.doesNotMatch(c.pageText(), /—/);
});

// SETTINGS-016 review: the board-page branch fired whenever a topic filter was
// set and the list was empty, so a topic several providers carry, narrowed to
// nothing by Free pricing or the search box, read "No provider in this list
// carries <topic> yet". 'Show all providers' cleared the topic only, so the
// list it promised could stay empty.
const button = (c, label) => c.nodes().find(n => n.type === 'button' && c.text(n) === label);
const everyProvider = new RegExp(`(?<!\\d)${CME_PROVIDERS.length} providers`);
const paidOnly = [...new Set(CME_PROVIDERS.flatMap(p => p.topics))]
  .find(t => CME_PROVIDERS.some(p => p.topics.includes(t)) && CME_PROVIDERS.filter(p => p.topics.includes(t)).every(p => p.pricing !== 'free' && p.pricing !== 'freemium'));

test('a carried topic emptied by the Free filter says the filters match nothing, not that the topic has no provider', async () => {
  assert.ok(paidOnly, 'the synthetic case needs a topic only paid providers carry');
  const c = await page(paidOnly, ['FL'], 'DO');
  assert.doesNotMatch(c.pageText(), /No providers match your filters/, 'the topic alone lists providers');
  button(c, 'Free').props.onClick();
  const text = c.pageText();
  assert.doesNotMatch(text, /No provider in this list carries/);
  assert.match(text, /No providers match your filters/);
  assert.equal(c.nodes().some(n => n.type === 'a' && /board/.test(c.text(n))), false, 'no board link for a topic providers carry');
  button(c, 'Show all providers').props.onClick();
  assert.match(c.pageText(), everyProvider, 'every filter goes, so every provider is listed');
});

test('a carried topic emptied by the search box says the same', async () => {
  const c = await page('Opioid Prescribing', ['FL'], 'DO');
  c.nodes().find(n => n.type === 'input' && /Search providers/.test(n.props.placeholder)).props.onChange({ target: { value: 'synthetic-no-such-provider' } });
  const text = c.pageText();
  assert.doesNotMatch(text, /No provider in this list carries/);
  assert.match(text, /No providers match your filters/);
  button(c, 'Show all providers').props.onClick();
  assert.match(c.pageText(), everyProvider);
});

test('a topic no provider carries keeps the board page under other filters, and Show all providers clears them all', async () => {
  const c = await page('Florida Laws and Rules', ['FL'], 'DO');
  button(c, 'Free').props.onClick();
  assert.match(c.pageText(), /No provider in this list carries Florida Laws and Rules yet/);
  button(c, 'Show all providers').props.onClick();
  assert.match(c.pageText(), everyProvider);
});
