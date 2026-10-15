import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(process.env.QA_DUTY_SPEC_FILE || new URL('../../qa-lab/e2e/practice-days.spec.mjs', import.meta.url), 'utf8');
const start = source.indexOf('    const billed = ');
const end = source.indexOf("\n    qa.check('the preview says", start);
assert.ok(start >= 0 && end > start);
const block = source.slice(start, end);
const profile = { id: 'owner-a' }, contract = { id: 'contract-a' };
const expectedDutyIds = ['duty-1', 'duty-2', 'duty-3'];
const inv = { id: 'invoice-a', entry_ids: [...expectedDutyIds] };
const linked = expectedDutyIds.map(id => ({ id, user_id: profile.id, contract_id: contract.id, invoice_id: inv.id }));

// Execute the journey's actual read/predicate/check block. Reads are controlled;
// there is no browser, database, interaction replay or publication path here.
async function run(sequence, options = {}) {
  let reads = 0, waits = 0;
  await vm.runInNewContext(`(async () => { ${block} })()`, {
    profile, contract, expectedDutyIds: options.ids || expectedDutyIds,
    inv: options.invoice === undefined ? inv : options.invoice,
    rows(sql) {
      assert.match(sql, /from public\.duty_days where user_id = 'owner-a'/);
      reads++;
      if (options.readError) throw Error('storage unavailable');
      return structuredClone(sequence[Math.min(reads - 1, sequence.length - 1)]);
    },
    async waitFor(label, predicate, config) {
      waits++; assert.equal(label, 'the exact duty days linked to this invoice');
      assert.equal(config.timeoutMs, 20000);
      for (let n = 0; n < 4; n++) { const result = await predicate(); if (result) return result; }
      throw Error('bounded wait expired');
    },
    qa: { check(name, ok) { assert.equal(name, 'each duty day now carries the invoice id'); assert.equal(Boolean(ok), true, name); } },
  });
  return { reads, waits };
}

test('the actual check waits for all three exact invoice links without replaying any action', async () => {
  const pending = linked.map(row => ({ ...row, invoice_id: null }));
  const partial = pending.map((row, index) => index ? row : linked[index]);
  assert.deepEqual(await run([pending, partial, linked]), { reads: 3, waits: 1 });
});
test('already persisted exact links pass immediately', async () => {
  const result = await run([linked]); assert.equal(result.reads, 1); assert.ok(result.waits <= 1);
});
for (const [name, rows] of [
  ['partial link', linked.map((row, index) => index === 1 ? { ...row, invoice_id: null } : row)],
  ['foreign owner', linked.map((row, index) => index === 1 ? { ...row, user_id: 'owner-b' } : row)],
  ['foreign agreement', linked.map((row, index) => index === 1 ? { ...row, contract_id: 'contract-b' } : row)],
  ['wrong invoice', linked.map((row, index) => index === 1 ? { ...row, invoice_id: 'invoice-b' } : row)],
  ['wrong duty id', linked.map((row, index) => index === 1 ? { ...row, id: 'duty-other' } : row)],
  ['duplicate duty id', [linked[0], linked[0], linked[2]]],
  ['extra duty row', [...linked, { ...linked[0], id: 'duty-extra' }]],
  ['missing duty row', linked.slice(0, 2)],
]) test(`${name} cannot satisfy the invoice-link wait`, async () => {
  await assert.rejects(run([rows]), /each duty day now carries the invoice id/);
});
test('missing invoice or wrong invoice-entry set cannot pass', async () => {
  for (const invoice of [null, { ...inv, entry_ids: ['duty-1', 'duty-2', 'wrong'] }, { ...inv, entry_ids: ['duty-1', 'duty-1', 'duty-3'] }]) {
    await assert.rejects(run([linked], { invoice }), /each duty day now carries the invoice id/);
  }
});
test('an empty or duplicate expected set is not vacuous success', async () => {
  for (const ids of [[], ['duty-1', 'duty-1', 'duty-3']]) await assert.rejects(run([linked], { ids }), /each duty day now carries the invoice id/);
});
test('read failure remains a failed check after the bounded wait', async () => {
  await assert.rejects(run([linked], { readError: true }), /each duty day now carries the invoice id/);
});
test('persistent incomplete links time out and fail the original assertion', async () => {
  await assert.rejects(run([linked.map(row => ({ ...row, invoice_id: null }))]), /each duty day now carries the invoice id/);
});
for (const prefix of ['before reloading, saved', 'after reloading, unchanged']) for (const shown of [false, true]) {
  test(`${prefix} duty data ${shown ? 'rejects' : 'passes without'} recovery notice`, async () => {
    const assertion = source.split('\n').find(line => line.includes(`qa.check('${prefix} duty days do not need recovery review'`));
    assert.ok(assertion, 'The real journey must check recovery visibility');
    const check = vm.runInNewContext(`(async () => { ${assertion} })()`, {
      page: { getByText(text, options) { assert.equal(text, 'Saved copies need your review'); assert.equal(options.exact, true); return { count: async () => Number(shown) }; } },
      qa: { check(name, ok) { assert.equal(Boolean(ok), true, name); } },
    });
    if (shown) await assert.rejects(check, /duty days do not need recovery review/); else await check;
  });
}
