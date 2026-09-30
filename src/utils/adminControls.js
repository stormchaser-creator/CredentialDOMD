// The words the admin screens use for each stored state. The database says
// 'revoked' for a paused account or invitation; nobody reading Admin should
// have to translate that (the Accounts filter already says Paused).
const STATE_LABELS = {
  profile: { active: 'Active', pending: 'Pending', revoked: 'Paused' },
  invite: { invited: 'Invited', active: 'Active', revoked: 'Paused' },
};

export function accessStateLabel(kind, status) {
  const labels = STATE_LABELS[kind === 'invite' ? 'invite' : 'profile'];
  return Object.hasOwn(labels, status) ? labels[status] : String(status || 'Unknown');
}

/** The one sentence the confirm dialog shows about what will change. */
export function accessChangeSummary(change) {
  if (change.action === 'remove') return 'This removes an unclaimed invitation.';
  if (change.kind === 'invite') {
    return `The invitation will change from ${accessStateLabel('invite', change.row.status)} to ${accessStateLabel('invite', change.status)}.`;
  }
  return `App access will change from ${accessStateLabel('profile', change.row.access_status)} to ${accessStateLabel('profile', change.status)}.`;
}

// admin_change_profile_access and admin_change_invite refuse a change whose
// reviewed row moved on with SQLSTATE PT409, which PostgREST answers as HTTP
// 409 (20260930030000_admin_refusals_not_retryable.sql). Re-sending the same
// reviewed request can never pass that check, so the dialog offers Refresh,
// not Retry.
export const STALE_REVIEW_CODE = 'PT409';

function controlFailure(error) {
  const failure = new Error(error.message || 'The change could not be saved.');
  if (error.code === STALE_REVIEW_CODE) failure.stale = true;
  return failure;
}

export function adminControlRequest(change, reason, requestId) {
  const note = String(reason || '').trim();
  if (note.length < 10 || note.length > 500) throw new Error('Enter a reason between 10 and 500 characters.');
  const row = change.row;
  if (!row?.id || !row.updated_at) throw new Error('Refresh this section before changing access.');
  if (change.kind === 'profile') {
    // Approve or Pause only. Every activation path finishes a pending
    // account, so an administrator's "pending" never held (the server
    // refuses it too: 20260925110000_admin_access_regrant_guard.sql).
    if (!['active', 'revoked'].includes(change.status)) throw new Error('Approve or Pause the account.');
    return { name: 'admin_change_profile_access', args: {
      p_profile_id: row.id, p_status: change.status, p_expected_status: row.access_status,
      p_expected_updated_at: row.updated_at, p_expected_subject: row.auth_user_id,
      p_reason: note, p_request_id: requestId,
    } };
  }
  return { name: 'admin_change_invite', args: {
    p_invite_id: row.id, p_action: change.action, p_status: change.action === 'remove' ? null : change.status,
    p_expected_status: row.status, p_expected_updated_at: row.updated_at,
    p_expected_profile_id: row.profile_id || null, p_reason: note, p_request_id: requestId,
  } };
}

export async function submitAdminControl(client, change, reason, requestId) {
  const request = adminControlRequest(change, reason, requestId);
  const result = await client.rpc(request.name, request.args);
  if (result?.error) throw controlFailure(result.error);
  const receipt = result?.data;
  const validTimestamp = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));
  const validAudit = typeof receipt?.audit_id === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(receipt.audit_id)
    && typeof receipt.duplicate === 'boolean';
  const matchingState = request.name === 'admin_change_profile_access'
    ? receipt?.profile?.id === request.args.p_profile_id && receipt.profile.access_status === request.args.p_status && validTimestamp(receipt.profile.updated_at)
    : request.args.p_action === 'remove'
      ? Object.hasOwn(receipt || {}, 'invite') && receipt.invite === null
      : receipt?.invite?.id === request.args.p_invite_id && receipt.invite.status === request.args.p_status && validTimestamp(receipt.invite.updated_at);
  if (!validAudit || !matchingState) throw new Error('The server did not confirm the matching audited change. Retry the same reviewed change to check its receipt.');
  return receipt;
}
