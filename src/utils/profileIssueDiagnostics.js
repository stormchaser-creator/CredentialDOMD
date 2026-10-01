// Support references contain fixed vocabulary only. Never include provider
// messages, response bodies, receipts, identifiers, or on-device values.
const STAGES = new Map([
  ['initialize', 'INIT'], ['binding', 'BIND'], ['recovery', 'RECOVER'],
  ['profile', 'PROFILE'], ['purge', 'PURGE'],
]);
const CODES = new Map([
  ...['continuity_unavailable', 'continuity_disabled', 'identity_conflict', 'account_unavailable',
    'verified_primary_required', 'unauthorized', 'membership_information_unavailable',
    'continuity_invalid_receipt', 'continuity_account_changed', 'continuity_stale_receipt',
    'continuity_invalid_binding', 'continuity_invalid_journal', 'continuity_storage_unavailable',
    'continuity_digest_failed', 'continuity_invalid_digest', 'continuity_invalid_adapter',
    'continuity_journal_conflict', 'continuity_recovery_conflict', 'continuity_retirement_unavailable',
    'profile_missing', 'profile_mismatch'].map(code => [code, code.replace(/^continuity_/, '').replace(/^membership_information_/, '').toUpperCase()]),
  ...['42501', '42P17', 'PGRST301', 'PGRST302', 'PGRST303'].map(code => [code, code]),
]);
const BROWSER_ERRORS = new Map([
  ['SecurityError', 'BROWSER_SECURITY'], ['NotSupportedError', 'BROWSER_UNSUPPORTED'],
  ['InvalidStateError', 'BROWSER_STATE'], ['QuotaExceededError', 'BROWSER_QUOTA'],
  ['TypeError', 'BROWSER_TYPE'], ['ReferenceError', 'BROWSER_REFERENCE'],
]);
// Where an initialize-clerk-profile request stopped (limitedLaunchClient
// phases), so a reference tells a timeout, a network failure, a cut-off
// answer and a changed session apart. Only for the client's own
// "membership_information_unavailable"; a server answer has its own code,
// and an HTTP failure already shows its status (ID-INIT-UNAVAILABLE-H426).
const CLIENT_PHASES = new Map([
  ['session', 'SESSION'], ['token', 'TOKEN'], ['network', 'NETWORK'], ['response', 'BODY'], ['timeout', 'TIMEOUT'],
]);
const statusCode = value => Number.isInteger(value) && value >= 100 && value <= 599 ? value : null;

export function profileSupportReference(error) {
  const stage = STAGES.get(error?.profileStage) || (error?.code === 'continuity_retirement_unavailable' ? 'PURGE' : 'UNKNOWN');
  const code = CODES.get(error?.profileCauseCode) || BROWSER_ERRORS.get(error?.profileBrowserError)
    || CODES.get(error?.code) || 'UNKNOWN';
  const status = statusCode(error?.httpStatus);
  const phase = CLIENT_PHASES.get(error?.profileCausePhase);
  const during = phase === 'TIMEOUT' ? CLIENT_PHASES.get(error?.profileCauseDuring) : null;
  return `ID-${stage}-${code}${phase ? `-${phase}` : ''}${during ? `-${during}` : ''}${status === null ? '' : `-H${status}`}`;
}

/**
 * The reference for an account load that fell back to this device's copy:
 * DATA-LOAD-LOCAL, the stage it reached (PROFILE: the profile never became
 * ready, so no membership check can run until a reload; RECORDS: it had),
 * and an allowlisted error code or browser error name, else UNKNOWN.
 */
export function localFallbackReference(stage, error) {
  const where = stage === 'records' ? 'RECORDS' : 'PROFILE';
  const cause = CODES.get(error?.code) || BROWSER_ERRORS.get(error?.name) || 'UNKNOWN';
  return `DATA-LOAD-LOCAL-${where}-${cause}`;
}

export function profileInitializationError(stage, cause, httpStatus = cause?.httpStatus) {
  const error = new Error('Your account identity could not be verified. Your existing records have not changed.');
  error.code = 'continuity_initialization_failed';
  error.profileStage = STAGES.has(stage) ? stage : null;
  error.profileCauseCode = CODES.has(cause?.code) ? cause.code : null;
  error.profileBrowserError = BROWSER_ERRORS.has(cause?.name) ? cause.name : null;
  error.httpStatus = statusCode(httpStatus);
  const clientFailure = cause?.code === 'membership_information_unavailable';
  error.profileCausePhase = clientFailure && CLIENT_PHASES.has(cause?.phase) ? cause.phase : null;
  error.profileCauseDuring = error.profileCausePhase === 'timeout' && CLIENT_PHASES.has(cause?.during) ? cause.during : null;
  error.recoveryConflict = cause?.code === 'continuity_recovery_conflict';
  return error;
}
