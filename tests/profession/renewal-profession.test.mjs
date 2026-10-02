// Where a PA or NP renews (DESIGN 3.9, 6.1): their own board, never a
// medical board portal, physician fee or physician guide; MD and DO exactly
// as before (renewalView is in the goldens; the reminder line is pinned here
// against the line send-reminders built inline before it was extracted).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renewalView, renewalRoute } from '../../src/utils/renewalRoute.js';
import { renewalLineFor } from '../../supabase/functions/_shared/reminderRenewalLine.mjs';
import { RECIPIENT_COLUMNS } from '../../supabase/functions/_shared/reminderRecipients.mjs';
import { RENEWAL_INFO } from '../../src/constants/renewalInfo.js';
import { PA_STATE_RULES } from '../../src/constants/paStateRules.js';
import { NP_STATE_RULES } from '../../src/constants/npStateRules.js';

const renewalLinks = JSON.parse(readFileSync(new URL('../../supabase/functions/send-reminders/renewalLinks.json', import.meta.url), 'utf8'));
const appBoardLinks = JSON.parse(readFileSync(new URL('../../supabase/functions/send-reminders/appBoardLinks.json', import.meta.url), 'utf8'));
const soon = (() => { const d = new Date(); d.setDate(d.getDate() + 20); return d.toISOString().slice(0, 10); })();
const medicalSites = new Set(Object.values(RENEWAL_INFO).flatMap(r => [r.portalUrl, r.boardUrl, r.doBoardUrl, r.guideUrl].filter(Boolean)));

test('a PA, RN or APRN licence box: the board name and link only', () => {
  for (const st of Object.keys(PA_STATE_RULES)) {
    for (const [deg, type, kind] of [['PA', 'State Physician Assistant License', 'pa'], ['NP', 'APRN License (NP)', 'aprn'], ['NP', 'RN License (Multistate)', 'rn'], ['', 'State Physician Assistant License', 'pa']]) {
      const v = renewalView({ id: 'x', type, state: st, expirationDate: soon }, deg);
      const board = kind === 'pa' ? PA_STATE_RULES[st] : NP_STATE_RULES[st];
      assert.ok(v, `${st} ${type}`);
      assert.equal(v.boardOnly, true);
      assert.equal(v.portal, null);
      assert.equal(v.fee, null);
      assert.equal(v.guide, null);
      assert.equal(v.showPortalOnLine, false);
      assert.equal(v.boardUrl, board.boardUrl);
      // The interval is the license's own verified renewal cycle, never the
      // CE counting cycle and never a physician figure; absent, none is shown.
      const set = kind === 'pa' ? PA_STATE_RULES[st] : NP_STATE_RULES[st][kind];
      const lc = set.licenseCycle;
      assert.equal(v.cycleShort, lc ? (lc === 1 ? 'Every year' : `Every ${lc} years`) : null, `${st} ${kind}`);
      assert.ok(!medicalSites.has(v.boardUrl) || v.boardUrl === (kind === 'pa' ? PA_STATE_RULES : NP_STATE_RULES)[st].boardUrl);
    }
  }
  assert.equal(renewalRoute('TX', 'PA', 'pa').portal, null);
});

test('a PA or NP member: DEA keeps its box; a medical, CSR or other record gets none', () => {
  assert.equal(renewalView({ id: 'd', type: 'DEA Registration', state: 'TX', expirationDate: soon }, 'PA').isDea, true);
  for (const type of ['State Medical License', 'State Controlled Substance', 'Prescriptive Authority', 'Practice Agreement', 'BLS Certification']) {
    assert.equal(renewalView({ id: 'x', type, state: 'TX', expirationDate: soon }, 'NP'), null, type);
  }
});

// The line send-reminders built inline before 2026-10-01, kept verbatim.
const oldLine = (i) => {
  if (i.isDea) return '\n      Renew: https://www.deadiversion.usdoj.gov/online_forms_apps.html';
  if (!i.isLicense || !i.state) return '';
  const r = renewalLinks[i.state];
  if (!r?.portal) return '';
  return `\n      Renew: ${r.portal}${r.guide ? `\n      Steps and fees: ${r.guide}` : ''}`;
};

test('reminder line: MD, DO and blank medical rows are exactly the old line, every state and type', () => {
  const types = ['State Medical License', 'State Medical License (DO)', 'DEA Registration', 'State Controlled Substance', 'BLS Certification', null];
  for (const st of [...Object.keys(renewalLinks), 'ZZ', null]) {
    for (const type of types) {
      for (const deg of ['MD', 'DO', '']) {
        for (const isLicense of [true, false]) {
          const i = { isDea: /dea/i.test(String(type ?? '')), isLicense, state: st, type };
          assert.equal(renewalLineFor(i, deg, { renewalLinks, appBoardLinks }), oldLine(i), `${st} ${type} ${deg}`);
        }
      }
    }
  }
});

test('reminder line: a PA, RN or APRN row names its board, never the medical portal', () => {
  const line = (type, deg, st = 'TX') => renewalLineFor({ isDea: false, isLicense: true, state: st, type }, deg, { renewalLinks, appBoardLinks });
  assert.equal(line('State Physician Assistant License', 'PA'), `\n      Board: ${appBoardLinks.TX.pa.url}`);
  assert.equal(line('APRN License (NP)', 'NP'), `\n      Board: ${appBoardLinks.TX.np.url}`);
  assert.equal(line('RN License', 'NP'), `\n      Board: ${appBoardLinks.TX.np.url}`);
  assert.equal(line('State Physician Assistant License', ''), `\n      Board: ${appBoardLinks.TX.pa.url}`, 'blank member: the PA board too');
  for (const type of ['State Medical License', 'State Controlled Substance', 'Practice Agreement']) assert.equal(line(type, 'PA'), '', type);
  assert.equal(renewalLineFor({ isDea: true, isLicense: true, state: 'TX', type: 'DEA Registration' }, 'NP', { renewalLinks, appBoardLinks }), '\n      Renew: https://www.deadiversion.usdoj.gov/online_forms_apps.html');
  const noLink = Object.keys(appBoardLinks).find(st => !appBoardLinks[st].pa.url);
  if (noLink) assert.equal(line('State Physician Assistant License', 'PA', noLink), '', 'no verified link: no line, never a guess');
  assert.match(RECIPIENT_COLUMNS, /, degree_type$/);
  const fn = readFileSync(new URL('../../supabase/functions/send-reminders/index.ts', import.meta.url), 'utf8');
  assert.match(fn, /renewalLineFor\(i, p\.degree_type \?\? "", \{ renewalLinks, appBoardLinks \}\)/);
  assert.match(fn, /type: r\.type \?\? null/);
});
