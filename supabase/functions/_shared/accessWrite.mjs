/**
 * Scope is chosen by the server route; identity comes from verified auth/mailbox binding.
 * @returns {Promise<{allowed: true} | {allowed: false, status: number, error: string}>}
 */
export async function accessWriteDecision(db, profileId, clerkSubject, scope) {
  if (!['credential', 'practice'].includes(scope) || !/^[0-9a-f-]{36}$/i.test(profileId || '')
    || !/^user_[A-Za-z0-9]+$/.test(clerkSubject || '')) return { allowed: false, status: 403, error: 'membership_unavailable' };
  try {
    const { data, error } = await db.rpc('credentialdo_service_write_snapshot', { p_profile_id: profileId, p_clerk_subject: clerkSubject });
    if (error?.code === '42501') return { allowed: false, status: 403, error: 'membership_unavailable' };
    if (error || typeof data?.enforcementEnabled !== 'boolean' || typeof data?.credential !== 'boolean' || typeof data?.practice !== 'boolean') throw Error('Access unavailable');
    return data[scope] ? { allowed: true } : { allowed: false, status: 403, error: 'membership_read_only' };
  } catch { return { allowed: false, status: 503, error: 'access_policy_unavailable' }; }
}
