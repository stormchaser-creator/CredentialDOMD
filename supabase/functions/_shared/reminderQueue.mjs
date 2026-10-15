// One deadline for all queries/RPCs in a request, including every page.
export function reminderDeadline(deadline, { now = () => Date.now(), fetcher = (...args) => fetch(...args) } = {}) {
  const signal = AbortSignal.timeout(Math.max(1, Math.ceil(deadline - now())));
  return { signal, fetch: (input, init = {}) => fetcher(input, {
    ...init, signal: init.signal ? AbortSignal.any([init.signal, signal]) : signal,
  }) };
}

// One leased drain at a time is enforced in SQL, not by process memory.
// Pace sends, reserve enough time for the next provider call, then return
// unfinished work to the durable queue for a later cron invocation.
export async function drainReminderQueue({ db, process, now = () => Date.now(), pause = ms => new Promise(resolve => setTimeout(resolve, ms)), budgetMs = 45000 }) {
  const started = now();
  const claimed = await db.rpc('reminder_queue_claim', { p_limit: 20 });
  if (claimed.error || !Array.isArray(claimed.data)) return { ok: false, error: 'queue_unavailable' };
  const jobs = claimed.data;
  const summary = { ok: true, claimed: jobs.length, sent: 0, skipped: 0, retry: 0, deferred: 0, unconfirmed: 0 };
  if (!jobs.length) return summary;
  let handled = 0;
  try {
    for (const job of jobs) {
      if (now() - started > budgetMs - 15000) break;
      let result;
      try { result = await process(job); } catch { result = { error: 'delivery_unavailable' }; }
      const outcome = result?.sent === true ? 'sent'
        : result?.sent === false && typeof result.reason === 'string' && !result.error ? 'skipped' : 'retry';
      const error = typeof result?.error === 'string' && /^[a-z_]{1,80}$/.test(result.error) ? result.error : 'delivery_unavailable';
      let ack;
      try { ack = await db.rpc('reminder_queue_finish', { p_job: job.id, p_token: job.lease_token, p_outcome: outcome, p_error: outcome === 'retry' ? error : null }); }
      catch { ack = { error: true }; }
      if (ack.error || ack.data !== true) summary.unconfirmed++;
      else summary[outcome]++;
      handled++;
      if (outcome !== 'skipped' && handled < jobs.length) {
        if (now() - started > budgetMs - 16100) break;
        await pause(1100);
      }
    }
  } finally {
    summary.deferred = jobs.length - handled;
    // A failed release leaves leases recoverable after 90 seconds. Never
    // report it as successful or delete the jobs.
    try {
      const released = await db.rpc('reminder_queue_release', { p_token: jobs[0].lease_token, p_unstarted: jobs.slice(handled).map(job => job.id) });
      if (released.error) summary.unconfirmed++;
    } catch { summary.unconfirmed++; }
  }
  return summary;
}
