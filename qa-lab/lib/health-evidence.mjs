import { redact } from './report-safety.mjs';

/**
 * Health is evidence, not merely a log footer. Intentional provider errors may
 * be explained only by exact {kind: 'client'|'edge', message, count, reason,
 * test} entries; no regex, prefixes, wildcards or count ranges are accepted.
 * Zombie data, runaway database retries and unavailable health cannot be waived.
 */
export function assessLabHealth(health, intentionalEvidence = []) {
  const reasons = [], unavailable = [], unclassified = [], intentional = [];
  const counts = { client: null, edge: null, zombies: null, runaway: null };
  const missing = (field, detail) => { unavailable.push(field); reasons.push({ code: 'health-unavailable', field, detail }); };
  const supplied = Array.isArray(intentionalEvidence) ? intentionalEvidence : [];
  const valid = value => value && ['client', 'edge'].includes(value.kind) && typeof value.message === 'string' && value.message.length > 0
    && Number.isSafeInteger(value.count) && value.count > 0 && typeof value.reason === 'string' && value.reason.trim().length > 0
    && typeof value.test === 'string' && value.test.trim().length > 0;
  const used = new Set();
  if (health?.claimProblems !== undefined) {
    if (!Array.isArray(health.claimProblems)) reasons.push({ code: 'invalid-health-claim', detail: 'Health claim reconciliation is malformed.' });
    else for (const problem of health.claimProblems) reasons.push({ code: 'invalid-health-claim', detail: redact(problem?.detail || 'Health claim verification failed.') });
  }
  if (!Array.isArray(intentionalEvidence) || supplied.some(value => !valid(value))) reasons.push({ code: 'invalid-health-explanation', detail: 'Intentional health evidence must name an exact message, positive count, reason and test.' });
  for (const [kind, field, textField] of [['client', 'clientErrors', 'message'], ['edge', 'edgeFunctionErrors', 'line']]) {
    const rows = health?.[field];
    if (!Array.isArray(rows)) { missing(field, `${field} was not collected successfully.`); continue; }
    if (rows.some(row => !row || typeof row[textField] !== 'string' || !row[textField] || !Number.isSafeInteger(row.n) || row.n <= 0)) {
      missing(field, `${field} contains malformed error counts.`); continue;
    }
    counts[kind] = rows.reduce((sum, row) => sum + row.n, 0);
    for (const row of rows) {
      const matches = supplied.map((value, index) => ({ value, index })).filter(({ value }) => valid(value)
        && value.kind === kind && value.message === row[textField] && value.count === row.n);
      const normalized = { kind, message: redact(row[textField]), count: row.n };
      if (matches.length === 1 && !used.has(matches[0].index)) {
        const { value, index } = matches[0]; used.add(index);
        intentional.push({ ...normalized, classification: value.classification === 'resolved_retry' ? 'resolved_retry' : 'intentional', reason: redact(value.reason), test: redact(value.test) });
      } else unclassified.push(normalized);
    }
  }
  if (!Array.isArray(health?.zombies)) missing('zombies', 'The deleted-record resurrection check was not collected successfully.');
  else if (health.zombies.some(row => !row || typeof row.tbl !== 'string' || typeof row.id !== 'string')) missing('zombies', 'The deleted-record resurrection check contains malformed rows.');
  else {
    counts.zombies = health.zombies.length;
    if (counts.zombies) reasons.push({ code: 'resurrected-records', count: counts.zombies, detail: 'Rows still exist despite matching deletion-ledger entries.' });
  }
  if (!Number.isSafeInteger(health?.runawayPostgrestRetries) || health.runawayPostgrestRetries < 0) missing('runawayPostgrestRetries', 'The database retry-loop check was not collected successfully.');
  else {
    counts.runaway = health.runawayPostgrestRetries;
    if (counts.runaway) reasons.push({ code: 'runaway-database-retries', count: counts.runaway, detail: 'PostgREST requests are stuck retrying.' });
  }
  if (unclassified.length) reasons.push({ code: 'unclassified-health-errors', count: unclassified.reduce((sum, value) => sum + value.count, 0), detail: 'Observed errors need exact evidence of a deliberate test fault or a completed retry, or a fix and a new verification run.' });
  const unused = supplied.filter((value, index) => valid(value) && !used.has(index));
  if (unused.length) reasons.push({ code: 'unused-health-explanation', count: unused.length, detail: 'Some supplied intentional-error evidence did not match exactly one observed message and count.' });
  return { ready: reasons.length === 0, scope: redact(health?.scope || 'selected local lab'), counts, reasons, unavailable, unclassified, intentional };
}
