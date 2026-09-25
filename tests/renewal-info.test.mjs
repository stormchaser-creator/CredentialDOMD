import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { renewalRoute, renewalView, portalLabel, shortCycle, shortBoardName, researchedLabel, DEA_PORTAL } from '../src/utils/renewalRoute.js';
import { renewalEvidence } from '../src/utils/assistantEvidence.js';
import { RENEWAL_INFO } from '../src/constants/renewalInfo.js';
import { STATE_REQS } from '../src/constants/stateRequirements.js';

// Ticket 2343f33d: the renewal paragraph made every licence card twice as tall.
// It is one line now, the portal button sits on that line only when the
// licence is urgent, the labels are short, and the board follows the degree.

const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const licence = (state, over = {}) => ({ id: `lic-${state}`, type: 'State Medical License', state, expirationDate: day(400), ...over });

test('a DO is sent to the osteopathic board, never an MD-only renewal page', () => {
  const az = renewalRoute('AZ', 'DO');
  assert.equal(new URL(az.portal).hostname, 'azdo.gov');
  assert.doesNotMatch(az.portal, /md-renewal-application/);
  assert.match(renewalRoute('WV', 'DO').portal, /wvbdosteo\.org/);
  assert.doesNotMatch(renewalRoute('WV', 'DO').portal, /practitioners\/MD\/renew/);
  assert.equal(renewalRoute('CA', 'DO').board, 'Osteopathic Medical Board of California');
  const md = renewalRoute('CA', 'MD');
  assert.equal(md.board, 'Medical Board of California');
  assert.equal(md.portal, RENEWAL_INFO.CA.portalUrl, 'an MD in California is unchanged');
  assert.equal(renewalRoute('ZZ', 'MD'), null);
});

test("Vera's renewal evidence and the card read one route", () => {
  for (const st of Object.keys(RENEWAL_INFO)) {
    for (const deg of ['MD', 'DO', null]) {
      const e = renewalEvidence(st, deg), r = renewalRoute(st, deg);
      assert.deepEqual([e.board, e.portal, e.boardUrl, e.guide, e.alternativeDOBoard], [r.board, r.portal, r.boardUrl, r.guide, r.alternativeDOBoard], `${st} ${deg}`);
    }
  }
});

test('a DO whose osteopathic route is not on file gets the state guide, not a guessed portal', () => {
  const st = Object.keys(RENEWAL_INFO).find(s => renewalRoute(s, 'DO').unknownDORoute);
  assert.ok(st, 'the dataset has at least one such state');
  const view = renewalView(licence(st, { expirationDate: day(10) }), 'DO');
  assert.equal(view.portal, null);
  assert.equal(view.showPortalOnLine, false);
  assert.ok(view.guide);
  assert.ok(STATE_REQS[st].md || STATE_REQS[st].do);
});

test('every portal button label is 60 characters or fewer, including AK, CO, NV and OR', () => {
  for (const st of ['AK', 'CO', 'NV', 'OR']) assert.ok(portalLabel(RENEWAL_INFO[st].board).length <= 60, st);
  assert.equal(portalLabel(RENEWAL_INFO.CO.board), 'Renew at Colorado Medical Board');
  for (const [st, r] of Object.entries(RENEWAL_INFO)) {
    for (const deg of ['MD', 'DO', null]) {
      const v = renewalView(licence(st), deg);
      assert.ok(v.portalLabel.length <= 60, `${st} ${deg}: ${v.portalLabel}`);
      assert.ok(!v.cycleShort || v.cycleShort.length <= 40, `${st} ${deg}: ${v.cycleShort}`);
    }
    assert.ok(shortBoardName(r.board).length > 0, st);
  }
  assert.equal(portalLabel(RENEWAL_INFO.AL.board), 'Renew online', 'a board name too long for a button falls back');
  assert.equal(portalLabel(''), 'Renew online');
});

test('the cycle is its leading phrase, and a stated degree picks its own', () => {
  assert.equal(shortCycle(RENEWAL_INFO.CO.cycle), 'Biennial (2 years)');
  assert.equal(shortCycle(RENEWAL_INFO.NV.cycle), 'Biennial (2 years)');
  assert.equal(shortCycle(RENEWAL_INFO.OR.cycle), 'Biennial (2 years)');
  assert.equal(shortCycle(RENEWAL_INFO.WA.cycle, 'DO'), 'Annual (1 year)');
  assert.equal(shortCycle(RENEWAL_INFO.WA.cycle, 'MD'), 'Biennial (2 years)');
  assert.equal(shortCycle(''), null);
  assert.equal(researchedLabel('2026-08 (single-source)'), 'Aug 2026');
  assert.equal(researchedLabel('soon'), null);
});

test('the portal goes on the one line only when the licence is urgent', () => {
  assert.equal(renewalView(licence('CO'), 'DO').showPortalOnLine, false);
  assert.equal(renewalView(licence('CO', { expirationDate: day(20) }), 'DO').showPortalOnLine, true);
  assert.equal(renewalView(licence('CO', { expirationDate: day(-5) }), 'DO').showPortalOnLine, true);
  assert.equal(renewalView(licence('CO', { expirationDate: day(-5) }), 'DO', { alertable: false }).showPortalOnLine, false, 'a record that raises no alert is never urgent');
  assert.equal(renewalView(licence('CA', { expirationDate: day(20) }), null).showPortalOnLine, false, 'with MD or DO unknown in CA either board could be the right one');
  assert.equal(renewalView({ type: 'BLS Certification', state: 'CO' }, 'MD'), null);
  assert.equal(renewalView(licence('ZZ'), 'MD'), null);
});

test('the stored fee is labelled with when it was researched, and the DEA line points at the DEA', () => {
  const ak = renewalView(licence('AK'), 'DO');
  assert.equal(ak.fee, RENEWAL_INFO.AK.fee);
  assert.equal(ak.feeCaption, 'last researched Aug 2026, confirm with the board');
  assert.equal(renewalView(licence('CO'), 'DO').feeCaption, null, 'no stored fee, no fee line');
  const dea = renewalView({ type: 'DEA Registration', state: 'ND', expirationDate: day(30) }, 'DO');
  assert.equal(dea.portal, DEA_PORTAL);
  assert.equal(dea.cycleShort, 'every 3 years');
  assert.match(dea.feeCaption, /confirm with the DEA$/);
});

// -- The real component, rendered with a synthetic account ----------------
const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('..', import.meta.url));
const bundled = await build({
  stdin: { contents: 'export {default as RenewalInfo} from "./src/components/features/RenewalInfo.jsx";', resolveDir: root, loader: 'jsx' },
  bundle: true, define: { 'import.meta.env': '{}' }, platform: 'node', format: 'cjs', write: false, jsx: 'automatic', external: ['react', 'react/jsx-runtime'], logLevel: 'silent',
  plugins: [{ name: 'synthetic-account', setup(b) {
    b.onResolve({ filter: /context\/AppContext$/ }, () => ({ path: 'context', namespace: 'fixture' }));
    b.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export const useApp = () => globalThis.__renewalFixture;' }));
  } }],
});
const mod = { exports: {} };
new Function('require', 'module', 'exports', bundled.outputFiles[0].text)(require, mod, mod.exports);
const render = (item, degreeType, props = {}) => {
  globalThis.__renewalFixture = { theme: { text: '#111', textMuted: '#666', border: '#aaa', input: '#fff', accent: '#2a7', warning: '#a60' }, data: { settings: { degreeType } } };
  return renderToStaticMarkup(React.createElement(mod.exports.RenewalInfo, { item, ...props }));
};

test('a CO licence card shows one collapsed line with no board button and no due or fee prose', () => {
  const html = render(licence('CO'), 'DO');
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /How to renew/);
  assert.match(html, /Biennial \(2 years\)/);
  for (const absent of ['Renew at', 'Due:', 'Fee', 'Renew online', 'Department of Regulatory Agencies']) {
    assert.ok(!html.includes(absent), `collapsed card must not contain "${absent}"`);
  }
  const ak = render(licence('AK'), 'MD');
  assert.ok(RENEWAL_INFO.AK.fee && !ak.includes('Fee') && !ak.includes('$350'), 'a stored fee never reaches the one line');
});

test('an urgent licence adds the portal button to the same line', () => {
  const html = render(licence('CO', { expirationDate: day(15) }), 'DO');
  assert.match(html, />Renew online<\/a>/);
  assert.match(html, new RegExp(`href="${RENEWAL_INFO.CO.portalUrl.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}"`));
  assert.ok(!html.includes('Due:'));
});

test('expanded, the box names the board, the guide, the cycle, the due date and the labelled fee', () => {
  const html = render(licence('CO'), 'DO', { defaultExpanded: true });
  assert.match(html, /aria-expanded="true"/);
  assert.match(html, />Renew at Colorado Medical Board<\/a>/);
  assert.match(html, /Steps, fees and pitfalls/);
  assert.match(html, /Due: /);
  const ak = render(licence('AK'), 'MD', { defaultExpanded: true });
  assert.match(ak, /Fee, last researched Aug 2026, confirm with the board: \$350/);
  assert.match(ak, />Renew at Alaska State Medical Board<\/a>/);
});

test('a DO in Arizona is linked to azdo.gov, and an unknown degree in California gets both boards', () => {
  const az = render(licence('AZ'), 'DO', { defaultExpanded: true });
  assert.match(az, /href="https:\/\/azdo\.gov/);
  assert.doesNotMatch(az, /md-renewal-application/);
  const ca = render(licence('CA', { expirationDate: day(10) }), null, { defaultExpanded: true });
  assert.match(ca, /Osteopathic board/);
  assert.match(ca, /Set MD or DO in Profile/);
});

test('nothing in the renewal box uses an em dash', () => {
  for (const st of ['AK', 'CO', 'NV', 'OR', 'CA', 'AZ']) {
    const html = render(licence(st, { expirationDate: day(10) }), 'DO', { defaultExpanded: true });
    const own = html.replace(/Due: [^<]*|Fee, [^<]*|Cycle: [^<]*|Board: [^<]*|renews through [^<]*/g, '');
    assert.doesNotMatch(own, /\u{2014}/u, st);
  }
});
