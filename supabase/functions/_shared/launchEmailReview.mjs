/**
 * Owner review hold for launch mail only. Deliberately no environment switch,
 * request override, or admin bypass: release needs an implementation that binds
 * the owner's approval to exact content and a versioned recipient list.
 * Credential replies, requested guides, support, and security mail do not use it.
 */
export function launchEmailReviewHold(purpose) {
  if (!['welcome', 'invitation'].includes(purpose)) {
    throw new Error('Unsupported launch email purpose');
  }
  return {
    ok: false,
    sent: false,
    held: true,
    code: 'owner_review_required',
    error: purpose === 'invitation'
      ? 'Invitation held for owner review of the exact email and recipient list. No email was sent and no access was changed.'
      : 'Welcome email held for owner review of the exact email and recipient list. No email was sent.',
  };
}
