// Provenance of the PA and NP rule data (DESIGN 2.2, 2.4, 7.4). The owner's
// rule, enforced: a number reaches the app only through a verified, loaded,
// quoted fact with an https URL. Anything else is "not yet verified" with
// the board link and carries no hour figure. The repository is public: the
// rule data holds no personal data and no copies of the sources.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generate, factUsable, factStatesNumber, resolveScalar } from '../../scripts/generate-app-rules.mjs';
import { PA_STATE_RULES } from '../../src/constants/paStateRules.js';
import { NP_STATE_RULES } from '../../src/constants/npStateRules.js';
import { CERTIFICATION_RULES, APP_GENERAL_SOURCES, DEA_APP_RULES } from '../../src/constants/certificationRules.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const DATA = path.join(ROOT, 'data/app-rules');
const read = (p) => JSON.parse(readFileSync(p, 'utf8'));
const hostOf = (u) => new URL(u).host.replace(/^www\./, '');

function* files(dir) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) yield* files(full); else yield full;
  }
}

test('the generated modules are current (node scripts/generate-app-rules.mjs --check)', () => {
  for (const [rel, content] of Object.entries(generate())) {
    assert.equal(readFileSync(path.join(ROOT, rel), 'utf8'), content, `${rel} is stale`);
  }
});

// The ledger plus later additions (facts reloaded over https, e.g. Florida's
// statutes and North Carolina's rules, whose ledger copies cite plain http).
const ledgerFacts = (st, profession) => {
  const l = read(path.join(DATA, 'ledger', `${st}.json`));
  const addPath = path.join(DATA, 'ledger/additions', `${st}.json`);
  let added = [];
  try { added = (read(addPath).facts || []).filter(f => f.profession === profession); } catch { /* none */ }
  return [...(l[profession]?.facts || []), ...added];
};
// "field#2" names the second fact recorded under a reused field id.
const findFact = (facts, id) => {
  const m = /^(.*)#(\d+)$/.exec(id);
  if (m) return [facts.filter(x => x.field === m[1])[Number(m[2]) - 1]].find(x => x && factUsable(x));
  return facts.find(x => x.field === id && factUsable(x));
};
const kindsOf = (st) => [['pa', PA_STATE_RULES[st]], ['np', NP_STATE_RULES[st].rn], ['np', NP_STATE_RULES[st].aprn]];

test('every rule set: numbers only from verified facts, unverified items carry no hour figure', () => {
  for (const st of Object.keys(PA_STATE_RULES)) {
    for (const [prof, set] of kindsOf(st)) {
      assert.ok(set.source, `${st} ${set.kind}: a source is always named`);
      if (set.total === 0) assert.equal(set.ceMode, 'none', `${st} ${set.kind}: total 0 only in a verified none mode`);
      if (set.ceMode === 'unverified') {
        assert.equal(set.total, null);
        // Only a curated license cycle (New York: triennial) frames the window
        // of an open section, and only through its own fact.
        if (set.cycle !== null) { assert.equal(set.windowRule, 'license'); assert.ok(set.facts.cycle?.length, `${st} ${set.kind}: cycle names its fact`); }
      }
      for (const [key, ids] of Object.entries(set.facts || {})) {
        for (const id of ids) {
          const f = findFact(ledgerFacts(st, prof), id);
          assert.ok(f, `${st} ${set.kind} ${key}: fact ${id} is verified in the ledger`);
        }
      }
      for (const u of set.unverified) {
        // An open item may state a figure only when facts the generator
        // checked state it (statedBy: Arkansas, at least 5 hours, frequency open).
        if (!u.statedBy) assert.doesNotMatch(u.item, /\d+\s*(contact )?(hours?|credits?)/i, `${st} ${set.kind}: "${u.item}" carries no figure`);
        assert.ok(u.boardUrl === null || /^https:\/\//.test(u.boardUrl));
      }
      for (const t of set.topics) if (t.status === 'unverified') assert.equal(t.hours, null);
    }
  }
});

test('board links are https and on a host the state\'s verified facts were loaded from', () => {
  let withLink = 0;
  for (const st of Object.keys(PA_STATE_RULES)) {
    for (const [prof, url] of [['pa', PA_STATE_RULES[st].boardUrl], ['np', NP_STATE_RULES[st].boardUrl]]) {
      if (url === null) continue;
      withLink++;
      assert.match(url, /^https:\/\//);
      const hosts = new Set(ledgerFacts(st, prof).filter(factUsable).map(f => hostOf(f.url)));
      assert.ok(hosts.has(hostOf(url)), `${st} ${prof}: ${url}`);
    }
  }
  assert.ok(withLink >= 80, `most boards have a checked link (${withLink} of 102)`);
  const links = read(path.join(ROOT, 'supabase/functions/send-reminders/appBoardLinks.json'));
  assert.equal(links.TX.pa.url, PA_STATE_RULES.TX.boardUrl);
  assert.equal(links.TX.np.url, NP_STATE_RULES.TX.boardUrl);
});

test('national rules: every value traces to a verified national fact; AANPCB accepted CE and PNCB counting stay unverified', () => {
  const national = read(path.join(DATA, 'ledger/national.json'));
  const byField = new Map(national.facts.map(f => [f.field, f]));
  const canon = read(path.join(DATA, 'national.json'));
  for (const [body, spec] of Object.entries(canon.bodies)) {
    const rule = CERTIFICATION_RULES[body];
    for (const [key, field] of Object.entries(spec)) {
      if (!field || typeof field !== 'object' || !('value' in field) || !(field.fact || field.facts)) continue;
      const ids = field.facts || [field.fact];
      const ok = ids.every(id => factUsable(byField.get(id)));
      if (key === 'url') { assert.equal(rule.url, ok ? field.value : null, `${body} url`); continue; }
      if (ok) {
        assert.deepEqual(rule[key], field.value, `${body} ${key}`);
        if (typeof field.value === 'number' && !field.reason) assert.ok(ids.some(id => factStatesNumber(byField.get(id), field.value)), `${body} ${key} stated by its fact`);
      } else assert.equal(rule[key], null, `${body} ${key} is not verified, so it is null`);
    }
  }
  assert.equal(CERTIFICATION_RULES.AANPCB.accepted, null);
  assert.ok(CERTIFICATION_RULES.PNCB.unverified.some(u => /dates the 15 yearly contact hours/.test(u.item)));
  assert.equal(DEA_APP_RULES.mateHours, 8);
  for (const s of APP_GENERAL_SOURCES) assert.match(s.url, /^https:\/\//);
});

test('the resolver refuses an unverified fact, an unstated number and a TODO', () => {
  const index = new Map([
    ['a', [{ field: 'a', value: '40 hours every 24 months', quote: 'at least 40 credits every 24 months', url: 'https://x.test/a', verified: true, loaded: true }]],
    ['b', [{ field: 'b', value: '40', quote: 'forty', url: 'https://x.test/b', verified: false, loaded: true }]],
    ['c', [{ field: 'c', value: '40', quote: '40', url: 'http://x.test/c', verified: true, loaded: true }]],
  ]);
  assert.equal(resolveScalar({ value: 40, fact: 'a' }, index).ok, true);
  assert.equal(resolveScalar({ value: 2, fact: 'a', reason: '24 months is 2 years' }, index).ok, true);
  assert.equal(resolveScalar({ value: 2, fact: 'a' }, index).ok, true, '"24 months" is the word form of 2');
  assert.equal(resolveScalar({ value: 50, fact: 'a' }, index).ok, false);
  assert.equal(resolveScalar({ value: 40, fact: 'b' }, index).ok, false);
  assert.equal(resolveScalar({ value: 40, fact: 'c' }, index).ok, false, 'http is not https');
  assert.equal(resolveScalar({ value: 40, fact: 'missing' }, index).ok, false);
  assert.equal(resolveScalar({ value: 'TODO', fact: 'a' }, index, { needsNumber: false }).ok, false);
  assert.equal(resolveScalar({ value: 40 }, index).ok, false, 'no fact, no number');
});

test('public repository: ledger quotes are 25 words or fewer, no personal data, no source copies', () => {
  let n = 0;
  for (const f of files(DATA)) {
    assert.match(f, /\.(json|md)$/, `${path.relative(ROOT, f)}: only JSON and the README under data/app-rules`);
    const text = readFileSync(f, 'utf8');
    assert.doesNotMatch(text, /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/, `${f}: no email addresses`);
    assert.doesNotMatch(text, /(?<!\d)\d{10}(?!\d)/, `${f}: no 10-digit numbers`);
    if (!f.includes(`${path.sep}ledger${path.sep}`)) continue;
    const d = JSON.parse(text);
    const facts = d.facts || [...(d.pa?.facts || []), ...(d.np?.facts || [])];
    for (const fact of facts) {
      n++;
      assert.ok(String(fact.quote || '').split(/\s+/).filter(Boolean).length <= 25, `${f} ${fact.field}: quote over 25 words`);
    }
  }
  assert.ok(n > 1800, `${n} ledger facts`);
});
