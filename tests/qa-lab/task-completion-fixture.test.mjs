import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(process.env.QA_TASK_SPEC_FILE || new URL('../../qa-lab/e2e/practice-todo-invoices.spec.mjs', import.meta.url), 'utf8');
const start = source.indexOf('    const done = ');
const end = source.indexOf('\n\n    // Build an invoice', start);
assert.ok(start >= 0 && end > start);
const block = source.slice(start, end);
const profile = { id: 'profile-a' }, renamed = { id: 'task-a' }, entry = { id: 'work-a' };
const completed = { id: renamed.id, user_id: profile.id, completed_at: '2026-10-01T02:36:50.826Z', notes: null, work_log_id: entry.id };

// Run the journey's actual completion read/check, supplying controlled saved
// rows. Nothing writes a task or repeats a user action to make it pass.
async function run(sequence, { currentEntry = entry, readError = false } = {}) {
  let reads = 0, waits = 0;
  const context = {
    profile, renamed, entry: currentEntry,
    row(sql) {
      assert.match(sql, /from public\.task_notes where id = 'task-a'/);
      reads++;
      if (readError) throw Error('database unavailable');
      return sequence[Math.min(reads - 1, sequence.length - 1)];
    },
    async waitFor(label, predicate, options) {
      waits++;
      assert.equal(label, 'the completed task and its work link');
      assert.equal(options.timeoutMs, 20000);
      for (let i = 0; i < 4; i++) { const value = await predicate(); if (value) return value; }
      throw Error('bounded wait expired');
    },
    qa: { check(name, ok, detail) { assert.equal(name, 'the task is marked done'); assert.equal(Boolean(ok), true, name); assert.equal(detail.id, renamed.id); } },
  };
  await vm.runInNewContext(`(async () => { ${block} })()`, context);
  return { reads, waits };
}

test('the actual completion check waits through the work/task persistence gap for the matching link', async () => {
  const result = await run([{ ...completed, completed_at: null, work_log_id: null }, completed]);
  assert.deepEqual(result, { reads: 2, waits: 1 });
});
test('a fully saved matching task passes after one bounded read', async () => {
  const result = await run([completed]);
  assert.equal(result.reads, 1);
  assert.ok(result.waits <= 1);
});
for (const [name, change] of [
  ['another task', { id: 'task-b' }], ['another owner', { user_id: 'profile-b' }],
  ['another work entry', { work_log_id: 'work-b' }], ['no work link', { work_log_id: null }],
  ['no completion', { completed_at: null }],
]) test(`${name} cannot satisfy this task's completion`, async () => {
  await assert.rejects(run([{ ...completed, ...change }]), /the task is marked done/);
});
test('a missing work entry cannot be treated as a completed task', async () => {
  await assert.rejects(run([completed], { currentEntry: null }), /the task is marked done/);
});
test('an unavailable database remains a failed assertion after the bounded wait', async () => {
  await assert.rejects(run([completed], { readError: true }), /the task is marked done/);
});
test('the cloud read is scoped to both the exact task and profile', () => {
  assert.match(block, /where id = '\$\{renamed\.id\}' and user_id = '\$\{profile\.id\}'/);
});

// This additional acceptance check covers the separate scalar-default product
// fix. A completed task wait must never hide the user-visible recovery banner.
for (const shown of [false, true]) test(`ordinary reloaded data ${shown ? 'refuses' : 'passes without'} a recovery notice`, async () => {
  const assertion = source.split('\n').find(line => line.includes("qa.check('after a reload, unchanged saved data does not need recovery review'"));
  assert.ok(assertion);
  const check = vm.runInNewContext(`(async () => { ${assertion} })()`, {
    page: { getByText(text, options) {
      assert.equal(text, 'Saved copies need your review'); assert.equal(options.exact, true);
      return { count: async () => shown ? 1 : 0 };
    } },
    qa: { check(name, ok) { assert.equal(Boolean(ok), true, name); } },
  });
  if (shown) await assert.rejects(check, /unchanged saved data does not need recovery review/);
  else await check;
});
