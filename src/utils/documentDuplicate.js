// A reloaded document row can arrive before its file bytes. Verify plausible
// stored matches before calling a renamed upload new; an unavailable read is
// not evidence that the file is different. No hashes or bytes are persisted.
function bytesOfDataUrl(value) {
  const comma = typeof value === "string" ? value.indexOf(",") : -1;
  if (comma < 0) return null;
  try {
    return /;base64$/i.test(value.slice(0, comma))
      ? Uint8Array.from(atob(value.slice(comma + 1)), c => c.charCodeAt(0))
      : new TextEncoder().encode(decodeURIComponent(value.slice(comma + 1)));
  } catch { return null; }
}

const equalBytes = (left, right) => left.length === right.length && left.every((byte, index) => byte === right[index]);

/** {duplicate: row|null}, {unavailable: row}, or {cancelled:true}.
 * downloadBlob uses downloadDocumentBlob(path,{detail:true,signal}). */
export async function findDocumentDuplicate(documents, file, dataUrl, {
  downloadBlob, isCurrent = () => true, timeoutMs = 20000,
} = {}) {
  if (!isCurrent()) return { cancelled: true };
  const rows = (documents || []).filter(Boolean);
  const direct = rows.find(doc => (dataUrl && doc.data === dataUrl)
    || (file.name && doc.name === file.name && doc.size === file.size));
  if (direct) return { duplicate: direct };
  const candidates = rows.filter(doc => Number(doc.size) === file.size);
  if (!candidates.length) return { duplicate: null };
  const bytes = bytesOfDataUrl(dataUrl);
  if (!bytes) return { unavailable: candidates[0] };
  let unavailable = null;
  let timedOut = false;
  const abort = new AbortController();
  let timer;
  const deadline = new Promise(resolve => {
    timer = setTimeout(() => { timedOut = true; abort.abort(); resolve({ failed: true }); }, timeoutMs);
  });
  try {
    for (const doc of candidates) {
      if (!isCurrent()) return { cancelled: true };
      const local = bytesOfDataUrl(doc.data);
      if (local) {
        if (equalBytes(bytes, local)) return { duplicate: doc };
        continue;
      }
      if (timedOut) return { unavailable: unavailable || doc };
      if (!doc.storagePath || typeof downloadBlob !== "function") { unavailable ||= doc; continue; }
      let found;
      try { found = await Promise.race([downloadBlob(doc.storagePath, { detail: true, signal: abort.signal }), deadline]); }
      catch { found = { failed: true }; }
      if (!isCurrent()) return { cancelled: true };
      if (!found?.blob) { unavailable ||= doc; continue; }
      let remote;
      try {
        const result = await Promise.race([found.blob.arrayBuffer(), deadline]);
        if (result?.failed) { unavailable ||= doc; continue; }
        remote = new Uint8Array(result);
      }
      catch { unavailable ||= doc; continue; }
      if (!isCurrent()) return { cancelled: true };
      if (equalBytes(bytes, remote)) return { duplicate: doc };
    }
    return unavailable ? { unavailable } : { duplicate: null };
  } finally { clearTimeout(timer); abort.abort(); }
}
