// A stored document's bytes as a data URL, from the device when they are
// there and from Storage when they are not. After a reload the device holds
// stored documents without their bytes until they are fetched back
// (AppContext reconcileDocumentFiles), so a reader that used `doc.data` alone
// read nothing: Setup's "Start from your CV" said "That PDF could not be
// read" for the CV already in Files (QA CV-001, 2026-10-01: picked 160 ms
// before its download landed).

/**
 * `{ dataUrl }`, or `{ missing: true }` when Storage has no file for it, or
 * `{ failed: true }`. `download(storagePath, { detail: true })` answers as
 * lib/supabase downloadDocumentFile does.
 */
export async function storedDataUrl(doc, { download } = {}) {
  if (doc?.data) return { dataUrl: doc.data };
  if (!doc?.storagePath || typeof download !== "function") return { failed: true };
  try {
    const got = await download(doc.storagePath, { detail: true });
    if (got?.dataUrl) return { dataUrl: got.dataUrl };
    return got?.missing ? { missing: true } : { failed: true };
  } catch {
    return { failed: true };
  }
}
