/** Wait only for already observed local delivery work, never reset or waive it. */
export async function settleDeliveryAudit({ since, read, now = Date.now, pause = ms => new Promise(resolve => setTimeout(resolve, ms)), timeoutMs = 15000, intervalMs = 500 }) {
  if (typeof read !== 'function' || !Number.isFinite(Date.parse(since)) || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 15000
    || !Number.isInteger(intervalMs) || intervalMs < 1) throw new Error('Invalid bounded delivery audit fence.');
  const started = now(), deadline = started + timeoutMs;
  let audit, until, checks = 0;
  while (true) {
    until = new Date(now()).toISOString();
    try { audit = await read(until, Math.max(1, deadline - now())); }
    catch { audit = { complete: false, error: 'Local delivery audit is unavailable.' }; }
    checks++;
    const chains = new Map();
    let settled = audit?.complete === true && audit.since === since && audit.until === until
      && Number.isFinite(Date.parse(audit.startedAt)) && audit.startedAt <= since && audit.incompleteAttempts === 0 && Array.isArray(audit.deliveries);
    for (const row of settled ? audit.deliveries : []) {
      if (!row || typeof row.event !== 'string' || typeof row.endpoint !== 'string' || !Number.isFinite(Date.parse(row.at))
        || !Number.isInteger(row.sequence) || typeof row.willRetry !== 'boolean' || typeof row.final !== 'boolean' || row.willRetry === row.final) {
        settled = false; break;
      }
      const key = `${row.event}/${row.endpoint}`, old = chains.get(key);
      if (!old || row.at > old.at || row.at === old.at && row.sequence > old.sequence) chains.set(key, row);
    }
    if ([...chains.values()].some(row => row.willRetry)) settled = false;
    if (settled || now() >= deadline) return { audit, until, settled, checks, waitedMs: now() - started };
    await pause(Math.min(intervalMs, deadline - now()));
  }
}
