// A file picked again under another name, when the document it repeats is
// stored but its bytes are not on this device. After a reload the device holds
// stored documents without their bytes, and they come back from Storage one
// document at a time (AppContext reconcileDocumentFiles), so for a while the
// in-memory comparison has nothing to compare against and the copy was saved
// as a second document (QA DOCS-001, 2026-10-01: picked 40 ms before the
// stored file's download landed).
//
// Only documents of exactly the picked file's size are candidates, and each
// is fetched and compared byte for byte. A candidate that cannot be fetched is
// not a duplicate: the pick goes ahead as before.
import { docBytes } from "./docLabel.js";

function sameBytes(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

async function bytesOf(blob) {
  if (!blob) return null;
  if (typeof blob.arrayBuffer === "function") return new Uint8Array(await blob.arrayBuffer());
  return null;
}

/**
 * The stored document whose file has the same bytes as `file`, or null.
 * `download(storagePath)` answers the stored file as a Blob, or null.
 */
export async function findStoredDuplicate(documents, file, { download } = {}) {
  const size = Number(file?.size);
  if (!Number.isFinite(size) || size <= 0 || typeof download !== "function") return null;
  const candidates = (Array.isArray(documents) ? documents : []).filter((d) =>
    d && !d.data && d.storagePath && !d.fileMissing && docBytes(d) === size);
  if (!candidates.length) return null;
  const mine = await bytesOf(file);
  if (!mine) return null;
  for (const doc of candidates) {
    let theirs = null;
    try { theirs = await bytesOf(await download(doc.storagePath)); } catch { theirs = null; }
    if (theirs && sameBytes(mine, theirs)) return doc;
  }
  return null;
}
