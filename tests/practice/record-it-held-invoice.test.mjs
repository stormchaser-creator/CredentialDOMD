// Record it (Work log, Days & call, Expenses) records an invoice that already
// went out. Before the first membership answer, fix/no-answer-settings holds
// record writes instead of refusing them, and an invoice record with the work
// it billed is kept even when that answer refuses (SENT_WORK: kept and marked
// refused, no alert; tests/limited-launch/no-answer-records.test.mjs). Record
// it reaches the same invoice write as Mark as sent on every screen, so the
// hold covers it there too: every invoice record and every billed-work stamp
// on these screens must pass SENT_WORK. Source check only; synthetic nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SENT_WORK } from '../../src/utils/limitedLaunchAccess.js';

const read = (f) => readFileSync(new URL(`../../src/components/features/locum/${f}`, import.meta.url), 'utf8');

// The text of each call starting at `start`, up to its matching parenthesis.
function calls(src, start) {
  const out = [];
  for (let i = src.indexOf(start); i !== -1; i = src.indexOf(start, i + 1)) {
    let depth = 0, j = i + start.indexOf("(");
    for (; j < src.length; j++) {
      if (src[j] === '(') depth++;
      else if (src[j] === ')' && --depth === 0) break;
    }
    out.push(src.slice(i, j + 1));
  }
  return out;
}

test('SENT_WORK keeps a refused record of work already sent', () => {
  assert.equal(SENT_WORK.keepOnRefusal, true);
});

for (const [file, billed] of [['WorkLog.jsx', 'editItem("workLog"'], ['DutyLog.jsx', 'editItem("dutyDays"'], ['Expenses.jsx', 'editItem("travelExpenses"']]) {
  test(`${file}: the invoice Record it and Mark as sent write is held and kept (SENT_WORK)`, () => {
    const src = read(file);
    const invoices = calls(src, 'addItem("invoices",');
    assert.ok(invoices.length >= 1, 'the screen records invoices');
    for (const c of invoices) assert.match(c, /,\s*SENT_WORK\)$/, `${c.slice(0, 60)}... passes SENT_WORK`);
    const stamps = calls(src, billed).filter((c) => /\binvoiceId(: invId)?\s*\}/.test(c));
    assert.ok(stamps.length >= 1, 'the work it billed is stamped');
    for (const c of stamps) assert.match(c, /,\s*SENT_WORK\)$/, `${c.slice(0, 60)}... passes SENT_WORK`);
  });
}

test('Record it on Days & call and Expenses goes through Mark as sent, the held write', () => {
  for (const file of ['DutyLog.jsx', 'Expenses.jsx']) {
    const src = read(file);
    assert.match(src, /markSentFromNote\(/, `${file} fills Mark as sent from the note`);
    assert.match(src, /MARKED_SENT/, `${file} records the invoice as marked sent`);
  }
});
