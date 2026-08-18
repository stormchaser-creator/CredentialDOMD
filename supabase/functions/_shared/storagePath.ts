/**
 * Every user's storage object lives at exactly "<auth_user_id>/<id>".
 *
 * A prefix test alone is not enough: documents.storage_path is a
 * client-writable column, and WHATWG URL parsing collapses dot segments, so
 * "<mine>/../<theirs>/<doc>" would pass startsWith and then resolve to the
 * other account's file when the service role fetches it. Demand the exact
 * two-segment shape instead.
 */
export function isOwnStorageObject(
  authUserId: string | null | undefined,
  path: string | null | undefined,
): boolean {
  if (!authUserId || !path) return false;
  if (path.includes("..") || path.includes("\\") || path.includes("//")) return false;
  if (!/^[^/]+\/[A-Za-z0-9._-]+$/.test(path)) return false;
  return path.startsWith(`${authUserId}/`);
}
