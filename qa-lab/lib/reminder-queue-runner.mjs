// The local lab keeps cron inactive. Tests must drive successive minute-drain
// commands instead of assuming a daily enqueue synchronously emails everyone.
// Dependencies come only from the guarded local lab helpers.
export async function runReminderQueueUntilSettled({ read, dispatch, responses, pause, timeoutMs = 180000, now = () => Date.now() }) {
  const deadline = now() + timeoutMs;
  let latest;
  while (now() < deadline) {
    latest = await read();
    if (!latest) throw new Error('The daily reminder did not enqueue this member');
    if (['sent', 'skipped', 'failed'].includes(latest.status)) return latest;
    const run = await dispatch();
    if (!run.ok) throw new Error(`The lab reminder drain failed: ${run.error || 'unknown error'}`);
    const ids = run.requests.map(request => request.id);
    if (ids.length) {
      const answers = await responses(ids, { timeoutMs: Math.max(1, Math.min(60000, deadline - now())) });
      if (answers.length !== ids.length || answers.some(answer => answer.timed_out || answer.status_code < 200 || answer.status_code >= 300 || !answer.status_code)) {
        throw new Error('The lab reminder drain did not answer successfully');
      }
    } else await pause(Math.min(1000, Math.max(1, deadline - now())));
  }
  // A timeout must explain the persisted queue failure without dumping a
  // recipient, frozen message, provider body or lease token into the report.
  const status = /^[a-z_]{1,24}$/.test(latest?.status || '') ? latest.status : 'unknown';
  const attempts = Number.isSafeInteger(latest?.attempts) && latest.attempts >= 0 ? latest.attempts : 'unknown';
  const error = /^[a-z_]{1,80}$/.test(latest?.last_error || '') ? latest.last_error : latest?.last_error ? 'unclassified' : 'none';
  throw new Error(`Reminder queue did not settle within ${timeoutMs}ms (status=${status}, attempts=${attempts}, last_error=${error})`);
}
