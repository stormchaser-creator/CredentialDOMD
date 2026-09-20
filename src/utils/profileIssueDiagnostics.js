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
const statusCode = value => Number.isInteger(value) && value >= 100 && value <= 599 ? value : null;

export function profileSupportReference(error) {
  const stage = STAGES.get(error?.profileStage) || (error?.code === 'continuity_retirement_unavailable' ? 'PURGE' : 'UNKNOWN');
  const code = CODES.get(error?.profileCauseCode) || BROWSER_ERRORS.get(error?.profileBrowserError)
    || CODES.get(error?.code) || 'UNKNOWN';
  const status = statusCode(error?.httpStatus);
  return `ID-${stage}-${code}${status === null ? '' : `-H${status}`}`;
}

export function profileInitializationError(stage, cause, httpStatus = cause?.httpStatus) {
  const error = new Error('Your account identity could not be verified. Your existing records have not changed.');
  error.code = 'continuity_initialization_failed';
  error.profileStage = STAGES.has(stage) ? stage : null;
  error.profileCauseCode = CODES.has(cause?.code) ? cause.code : null;
  error.profileBrowserError = BROWSER_ERRORS.has(cause?.name) ? cause.name : null;
  error.httpStatus = statusCode(httpStatus);
  error.recoveryConflict = cause?.code === 'continuity_recovery_conflict';
  return error;
}
