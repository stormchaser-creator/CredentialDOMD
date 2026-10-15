import test from 'node:test';
import assert from 'node:assert/strict';
import { drainReminderQueue, reminderDeadline } from '../supabase/functions/_shared/reminderQueue.mjs';

function world(n = 20) {
  const jobs = Array.from({ length: n }, (_, i) => ({ id: `job-${i}`, profile_id: `profile-${i}`, lease_token: 'shared-lease' }));
  const calls = [], starts = [], pauses = [];
  let time = 0;
  return { jobs, calls, starts, pauses, now: () => time, tick: ms => { time += ms; },
    pause: async ms => { pauses.push(ms); time += ms; },
    db: { rpc: async (name, args) => { calls.push({ name, args }); return { data: name === 'reminder_queue_claim' ? jobs : true }; } },
  };
}

test('a drain paces provider attempts, skips without delay, and acknowledges each outcome', async () => {
  const w = world(3);
  const result = await drainReminderQueue({ ...w, process: async job => {
    w.starts.push(w.now());
    return job.id === 'job-0' ? { sent: true } : job.id === 'job-1' ? { sent: false, reason: 'snoozed' } : { error: 'send_unconfirmed' };
  } });
  assert.deepEqual(w.starts, [0, 1100, 1100]);
  assert.deepEqual(result, { ok: true, claimed: 3, sent: 1, skipped: 1, retry: 1, deferred: 0, unconfirmed: 0 });
  assert.deepEqual(w.calls.filter(c => c.name === 'reminder_queue_finish').map(c => c.args.p_outcome), ['sent', 'skipped', 'retry']);
  assert.equal(w.calls.at(-1).name, 'reminder_queue_release');
});

test('slow provider work yields before the 45-second budget and returns all unstarted leases', async () => {
  const w = world();
  const result = await drainReminderQueue({ ...w, process: async () => { w.tick(10000); return { error: 'send_unconfirmed' }; } });
  assert.ok(w.now() <= 45000);
  assert.equal(result.retry, 3);
  assert.equal(result.deferred, 17);
  assert.equal(w.calls.at(-1).name, 'reminder_queue_release');
  assert.deepEqual(w.calls.at(-1).args.p_unstarted, w.jobs.slice(3).map(job => job.id));
});

test('failed acknowledgements are visible and leases stay recoverable', async () => {
  const w = world(1);
  w.db.rpc = async name => name === 'reminder_queue_claim' ? { data: w.jobs } : { error: true };
  const result = await drainReminderQueue({ ...w, process: async () => ({ sent: true }) });
  assert.equal(result.sent, 0);
  assert.equal(result.unconfirmed, 2);
});

test('an attempted job with a lost acknowledgement is never released as unstarted', async () => {
  const w = world(1);
  w.db.rpc = async (name, args) => {
    w.calls.push({ name, args });
    if (name === 'reminder_queue_claim') return { data: w.jobs };
    return name === 'reminder_queue_finish' ? { error: true } : { data: true };
  };
  await drainReminderQueue({ ...w, process: async () => ({ sent: true }) });
  assert.deepEqual(w.calls.at(-1).args.p_unstarted, []);
});

test('one deadline aborts database page/RPC and provider signals without extending for later requests', async () => {
  const signals = [];
  const bounded = reminderDeadline(Date.now() + 20, { fetcher: async (_, init) => { signals.push(init.signal); } });
  const other = new AbortController();
  await bounded.fetch('https://db.test/page1');
  await bounded.fetch('https://db.test/page2', { signal: other.signal });
  const provider = AbortSignal.any([bounded.signal, AbortSignal.timeout(10000)]);
  await new Promise(resolve => setTimeout(resolve, 35));
  assert.ok(signals.every(signal => signal.aborted));
  assert.equal(provider.aborted, true);
});

test('a processor exception reschedules the job and never leaks provider error content', async () => {
  const w = world(1);
  const result = await drainReminderQueue({ ...w, process: async () => { throw Error('synthetic private error'); } });
  assert.equal(result.retry, 1);
  assert.equal(w.calls.find(c => c.name === 'reminder_queue_finish').args.p_error, 'delivery_unavailable');
});

test('unavailable or already leased queue never runs a sender', async () => {
  for (const claim of [{ error: true }, { data: [] }]) {
    const result = await drainReminderQueue({ db: { rpc: async () => claim }, process: () => { assert.fail('must not send'); } });
    if (claim.error) assert.deepEqual(result, { ok: false, error: 'queue_unavailable' });
    else assert.equal(result.claimed, 0);
  }
});


test('near the budget boundary a slow attempt defers later jobs instead of removing their pacing', async () => {
  const w = world(3);
  const result = await drainReminderQueue({ ...w, process: async job => {
    w.starts.push(w.now());
    if (job.id === 'job-0') w.tick(29000);
    return { sent: true };
  } });
  assert.deepEqual(w.starts, [0]);
  assert.equal(result.sent, 1);
  assert.equal(result.deferred, 2);
  assert.deepEqual(w.calls.at(-1).args.p_unstarted, w.jobs.slice(1).map(job => job.id));
});
