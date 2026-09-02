/**
 * Per-account storage quota, checked on the device before any upload.
 *
 * 2 GB per physician (docs/SCALE-AND-COST-PLAN-2026-09-02.md, section 6,
 * gap 7). The heaviest real account holds 72 MB, so this is a stress line,
 * not a budget: it exists so one account cannot fill the bucket by accident
 * or on purpose. Every place that turns a picked file into a documents row
 * (the Files tab, the camera, DocAttach inside a credential form, the
 * CrudSection picker, onboarding, a Vera attachment being filed) runs this
 * first and refuses the whole batch with the message below. The server-side
 * per-folder check is on the plan's "next" list; until it ships, the bucket
 * cap of 15 MB per object is the only server-side line.
 *
 * Pure: no React, no storage, no network, so scripts/storage-quota.test.mjs
 * imports it as is.
 */

export const STORAGE_QUOTA_BYTES = 2 * 1024 * 1024 * 1024;

/** "240 MB", "1.9 GB". Whole numbers under 10 are shown with one decimal. */
export function fmtQuotaBytes(n) {
  const b = Math.max(0, Number(n) || 0);
  if (b < 1024) return `${Math.round(b)} bytes`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = b / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v = v / 1024; i++; }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

/**
 * Bytes one document (a row, a staged attachment, or a File) accounts for:
 * size, else sizeBytes / size_bytes from a synced row, else derived from the
 * base64 data URL when that is all there is.
 */
export function docStorageBytes(doc) {
  if (!doc) return 0;
  for (const f of ["size", "sizeBytes", "size_bytes"]) {
    const v = Number(doc[f]);
    if (Number.isFinite(v) && v > 0) return v;
  }
  const data = typeof doc.data === "string" ? doc.data : "";
  const comma = data.indexOf(",");
  if (comma < 0) return 0;
  const b64 = data.slice(comma + 1);
  const pad = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((b64.length * 3) / 4) - pad);
}

/** What the account's documents already take up. */
export function usedStorageBytes(docs) {
  let n = 0;
  for (const d of docs || []) n += docStorageBytes(d);
  return n;
}

/**
 * Would adding `incoming` (File objects or {size}/{data} shapes) push the
 * account past `quota`? Returns { ok, used, adding, total, quota, message };
 * `message` is empty when ok and names the total when not.
 */
export function checkStorageQuota(docs, incoming, quota = STORAGE_QUOTA_BYTES) {
  const used = usedStorageBytes(docs);
  const files = Array.isArray(incoming) ? incoming : incoming ? Array.from(incoming) : [];
  const adding = files.reduce((n, f) => n + docStorageBytes(f), 0);
  const total = used + adding;
  const limit = Math.max(0, Number(quota) || 0);
  if (total <= limit) return { ok: true, used, adding, total, quota: limit, message: "" };
  const what = files.length === 1
    ? `"${files[0]?.name || "This file"}" (${fmtQuotaBytes(adding)})`
    : `These ${files.length} files (${fmtQuotaBytes(adding)})`;
  return {
    ok: false, used, adding, total, quota: limit,
    message: `${what} would bring your documents to ${fmtQuotaBytes(total)}, past the ${fmtQuotaBytes(limit)} each account can store. Delete documents you no longer need, then try again.`,
  };
}
