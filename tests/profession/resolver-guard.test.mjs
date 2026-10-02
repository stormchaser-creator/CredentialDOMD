// A PA or NP never receives a physician rule set or DEFAULT_STATE_REQ, in any
// state, for any licence kind (DESIGN 3.2, 7.3). MD and DO lookups return the
// very objects they always did.
import test from 'node:test';
import assert from 'node:assert/strict';
import { STATE_REQS, DEFAULT_STATE_REQ, getStateEntry, getStateReq } from '../../src/constants/stateRequirements.js';
import { PA_STATE_RULES } from '../../src/constants/paStateRules.js';
import { NP_STATE_RULES } from '../../src/constants/npStateRules.js';
import { ruleSetFor } from '../../src/utils/ruleResolver.js';

const physicianSets = new Set([DEFAULT_STATE_REQ]);
for (const e of Object.values(STATE_REQS)) for (const r of (e.md || e.do) ? [e.md, e.do].filter(Boolean) : [e]) physicianSets.add(r);
const states = [...new Set([...Object.keys(STATE_REQS), ...Object.keys(PA_STATE_RULES), 'ZZ'])];

test('every state, PA and NP, every kind: never a physician rule set, never the default', () => {
  for (const st of states) {
    for (const [deg, kinds] of [['PA', ['pa', undefined]], ['NP', ['aprn', 'rn', undefined]]]) {
      for (const kind of kinds) {
        const set = ruleSetFor(st, deg, kind);
        const entry = getStateEntry(st, deg, kind);
        const req = getStateReq(st, deg, kind);
        assert.ok(set && !physicianSets.has(set) && !physicianSets.has(entry), `${st} ${deg} ${kind}`);
        assert.deepEqual(entry, set);
        // Any hour figure is the PA or NP rule set's own (a verified fact),
        // never DEFAULT_STATE_REQ's or a physician entry's.
        assert.equal(req.hours, set.total, `${st} ${deg} ${kind}: hours come from the PA/NP rule set`);
        assert.equal(req.cycle, set.cycle);
        assert.equal(req.moc, null);
        assert.ok(entry.source && !/^$/.test(entry.source), 'a source is always named, never left for "State medical board rule"');
        assert.doesNotMatch(String(entry.source), /State medical board rule/);
        if (entry.ceMode !== 'none') assert.notEqual(entry.total, 0, `${st} ${deg} ${kind}: total 0 only for a verified none mode`);
        if (entry.ceMode === 'unverified') {
          assert.equal(entry.total, null);
          assert.equal(req.hours, null);
          // A settled license cycle still frames the window for verified
          // topics when the hours are open (New York: triennial).
          if (entry.windowRule !== 'license') assert.equal(req.cycle, null);
          assert.ok(entry.unverified.length > 0);
          for (const u of entry.unverified) assert.ok(u.boardUrl === null || /^https:\/\//.test(u.boardUrl));
        }
      }
    }
  }
});

test('PA and NP data covers all 51 jurisdictions; a state outside it gets a board-less stub', () => {
  assert.equal(Object.keys(PA_STATE_RULES).length, 51);
  assert.equal(Object.keys(NP_STATE_RULES).length, 51);
  const zz = ruleSetFor('ZZ', 'NP', 'rn');
  assert.equal(zz.board, null);
  assert.equal(zz.boardUrl, null);
  assert.equal(zz.status, 'unverified');
});

test('MD and DO lookups are the old objects, referentially', () => {
  for (const st of Object.keys(STATE_REQS)) {
    const e = STATE_REQS[st];
    assert.equal(getStateEntry(st, 'MD'), e.md || e.do ? (e.md || e.do) : e);
    assert.equal(getStateEntry(st, 'DO'), e.md || e.do ? (e.do || e.md) : e);
    assert.equal(getStateEntry(st, ''), e.md || e.do ? (e.md || e.do) : e, 'blank keeps the MD stand-in');
    assert.equal(ruleSetFor(st, 'MD'), null);
    assert.equal(ruleSetFor(st, ''), null);
  }
  assert.equal(getStateEntry('ZZ', 'MD'), DEFAULT_STATE_REQ);
});
