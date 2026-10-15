// A deliberate fault can explain only the exact persisted rows it produced.
// Matching messages alone must never consume another test's unexpected error.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KINDS = new Set(['error', 'react', 'unhandledrejection']);
const text = value => typeof value === 'string' && value.trim().length > 0;
const identityValid = row => row && UUID.test(row.id) && text(row.message)
  && (row.auth_user_id === null || text(row.auth_user_id));
const rowValid = row => identityValid(row) && KINDS.has(row.kind);
// The current schema stores informational events alongside faults. Validate
// and retain all raw observations, but never use an info row as fault proof.
const observationValid = row => identityValid(row) && (KINDS.has(row.kind) || row.kind === 'info');

export function clientErrorClaims(rows, { message, kind, authUserId, count, reason } = {}) {
  if (!text(message) || !KINDS.has(kind) || !(authUserId === null || text(authUserId))
    || !Number.isSafeInteger(count) || count < 1 || !text(reason)) throw new Error('An intentional client error needs an exact message, kind, account, count and reason.');
  if (!Array.isArray(rows) || rows.length !== count || new Set(rows.map(row => row?.id)).size !== count
    || rows.some(row => !rowValid(row) || row.message !== message || row.kind !== kind || row.auth_user_id !== authUserId)) {
    throw new Error('Observed client error rows did not match the deliberate fault exactly.');
  }
  return rows.map(row => ({ id: row.id, message, kind, auth_user_id: authUserId, reason }));
}

export function aggregateClientErrors(rows) {
  if (!Array.isArray(rows) || rows.some(row => !observationValid(row)) || new Set(rows.map(row => row.id)).size !== rows.length) {
    throw new Error('Client error observations are unavailable or malformed.');
  }
  const groups = new Map();
  for (const row of rows.filter(rowValid)) groups.set(row.message, (groups.get(row.message) || 0) + 1);
  return [...groups].map(([message, n]) => ({ message, n })).sort((a, b) => b.n - a.n || a.message.localeCompare(b.message));
}

/** Reconcile every attempt's claims against the final raw database collection. */
export function reconcileHealthClaims(health, claims = []) {
  const problems = [], evidence = [], matched = [], absent = [];
  const problem = detail => problems.push({ code: 'invalid-health-claim', detail });
  let groups;
  try { groups = aggregateClientErrors(health?.clientErrorObservations); }
  catch { problem('Raw client error observations were not collected successfully.'); return { evidence, problems, matched, absent }; }
  const actual = health.clientErrors;
  if (!Array.isArray(actual) || actual.length !== groups.length || groups.some(group =>
    actual.filter(row => row.message === group.message && row.n === group.n).length !== 1)) {
    problem('Client error totals do not match the raw observations.'); return { evidence, problems, matched, absent };
  }
  if (!Array.isArray(claims)) { problem('Client error claims must be an array.'); return { evidence, problems, matched, absent }; }
  const rows = new Map(health.clientErrorObservations.filter(rowValid).map(row => [row.id, row]));
  const seen = new Set(), accepted = new Map();
  for (const claim of claims) {
    if (!rowValid(claim) || !text(claim.reason) || !text(claim.test) || !text(claim.file)
      || !Number.isSafeInteger(claim.retry) || claim.retry < 0 || !Number.isSafeInteger(claim.repeatEachIndex) || claim.repeatEachIndex < 0) {
      problem('A client error claim is missing its exact row or test-attempt evidence.'); continue;
    }
    if (seen.has(claim.id)) { problem('A client error row was claimed more than once.'); accepted.delete(claim.id); continue; }
    seen.add(claim.id);
    const observed = rows.get(claim.id);
    if (!observed) {
      // Admin tests intentionally delete report groups. An absent row is never
      // converted to an allowance, and cannot explain any surviving error.
      absent.push(claim); continue;
    }
    if (['message', 'kind', 'auth_user_id'].some(key => observed[key] !== claim[key])) {
      problem('A client error claim differs from its observed database row.'); continue;
    }
    accepted.set(claim.id, claim);
  }
  matched.push(...accepted.values());
  for (const group of groups) {
    const members = health.clientErrorObservations.filter(row => rowValid(row) && row.message === group.message);
    if (!members.every(row => accepted.has(row.id))) continue;
    const proven = members.map(row => accepted.get(row.id));
    evidence.push({ kind: 'client', message: group.message, count: group.n,
      reason: [...new Set(proven.map(claim => claim.reason))].join('; '),
      test: [...new Set(proven.map(claim => `${claim.file}: ${claim.test} (retry ${claim.retry}, repeat ${claim.repeatEachIndex})`))].join('; '),
      rowIds: members.map(row => row.id) });
  }
  return { evidence, problems, matched, absent };
}
