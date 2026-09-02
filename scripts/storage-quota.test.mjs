// Unit-style checks for src/utils/storageQuota.js: the 2 GB per-account
// line every upload entry point checks before a documents row is created.
// Run: node scripts/storage-quota.test.mjs   (pure node, no test runner)

const {
  STORAGE_QUOTA_BYTES, checkStorageQuota, docStorageBytes, usedStorageBytes, fmtQuotaBytes,
} = await import("../src/utils/storageQuota.js");

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; }
  else { fail++; console.log(`FAIL ${name}\n   got  ${g}\n   want ${w}`); }
};
const ok = (name, cond, extra = "") => { if (cond) pass++; else { fail++; console.log(`FAIL ${name} ${extra}`); } };

const MB = 1024 * 1024;
const GB = 1024 * MB;

// ── The line itself ─────────────────────────────────────────────────────
eq("quota is 2 GB", STORAGE_QUOTA_BYTES, 2 * GB);

// ── Byte accounting for every shape a document arrives in ───────────────
eq("File-like: size wins", docStorageBytes({ size: 1234, data: "data:x;base64,AAAA" }), 1234);
eq("synced row: sizeBytes", docStorageBytes({ sizeBytes: 500 }), 500);
eq("raw row: size_bytes", docStorageBytes({ size_bytes: 700 }), 700);
eq("no size: derived from the data URL (3 bytes)", docStorageBytes({ data: "data:text/plain;base64,YWJj" }), 3);
eq("no size: derived from the data URL with padding (4 bytes)", docStorageBytes({ data: "data:text/plain;base64,YWJjZA==" }), 4);
eq("nothing known: 0", docStorageBytes({ name: "x" }), 0);
eq("null: 0", docStorageBytes(null), 0);
eq("a zero size falls through to the data URL", docStorageBytes({ size: 0, data: "data:text/plain;base64,YWJj" }), 3);
eq("used = sum over rows", usedStorageBytes([{ size: 10 }, { sizeBytes: 20 }, null, { data: "data:x;base64,YWJj" }]), 33);
eq("used of nothing is 0", usedStorageBytes(undefined), 0);

// ── The check ───────────────────────────────────────────────────────────
{
  const r = checkStorageQuota([{ size: 100 * MB }], [{ name: "dea.pdf", size: 5 * MB }]);
  ok("well under: ok", r.ok === true && r.message === "");
  eq("well under: totals", [r.used, r.adding, r.total], [100 * MB, 5 * MB, 100 * MB + 5 * MB]);
}
{
  // Exactly at the line is allowed; one byte over is not.
  const at = checkStorageQuota([{ size: 2 * GB - 10 }], [{ name: "a", size: 10 }]);
  ok("exactly 2 GB is allowed", at.ok === true);
  const over = checkStorageQuota([{ size: 2 * GB - 10 }], [{ name: "a", size: 11 }]);
  ok("2 GB + 1 byte is refused", over.ok === false);
}
{
  const r = checkStorageQuota([{ size: 1.95 * GB }], [{ name: "passport.jpg", size: 120 * MB }]);
  ok("over: refused", r.ok === false);
  ok("over: message names the file", r.message.includes('"passport.jpg"'), r.message);
  ok("over: message names the total", r.message.includes("2.1 GB"), r.message);
  ok("over: message names the line", r.message.includes("2.0 GB each account can store"), r.message);
  ok("over: message says what to do", /Delete documents/.test(r.message), r.message);
  ok("over: no em dash", !/[—–]/.test(r.message));
}
{
  // A batch is judged as a whole: five 300 MB files on a 1 GB account.
  const files = Array.from({ length: 5 }, (_, i) => ({ name: `scan-${i}.pdf`, size: 300 * MB }));
  const r = checkStorageQuota([{ size: 1 * GB }], files);
  ok("batch over: refused", r.ok === false);
  ok("batch over: message counts the files", r.message.startsWith("These 5 files (1.5 GB)"), r.message);
  eq("batch over: total", r.total, 1 * GB + 1500 * MB);
}
{
  // A FileList-like iterable, and an empty pick.
  const list = { length: 1, 0: { name: "x", size: 1 }, [Symbol.iterator]: function* () { yield this[0]; } };
  ok("iterable incoming is accepted", checkStorageQuota([], list).adding === 1);
  ok("nothing incoming is ok", checkStorageQuota([{ size: 3 * GB }], []).ok === false, "an account already over stays over");
  ok("nothing incoming on a normal account is ok", checkStorageQuota([{ size: 1 * GB }], []).ok === true);
}
{
  // Staged attachments from DocAttach carry size and data; a Vera attachment
  // carries only the data URL. Both count.
  const staged = [{ name: "a.pdf", size: 1.5 * GB, data: "data:application/pdf;base64,AAAA" }];
  const vera = [{ data: "data:image/jpeg;base64,AAAAAAAA" }]; // 6 bytes
  ok("staged + row bytes are summed", checkStorageQuota([{ size: 0.6 * GB }], staged).ok === false);
  ok("data-URL-only attachment is counted", checkStorageQuota([{ size: 30 }], vera, 35).ok === false);
  ok("data-URL-only attachment under the line is fine", checkStorageQuota([{ size: 30 }], vera, 36).ok === true);
}
{
  // The line is a parameter so a future plan tier can lower or raise it.
  const r = checkStorageQuota([{ size: 40 * MB }], [{ name: "a", size: 20 * MB }], 50 * MB);
  ok("custom quota is honored", r.ok === false && r.message.includes("50 MB each account can store"), r.message);
}

{
  // Receipts staged on a locum expense carry only a data URL (Expenses.jsx
  // maps pendingFiles to { name, data }); they count alongside the new pick.
  const staged = [{ name: "hotel.jpg", data: "data:image/jpeg;base64,AAAAAAAA" }]; // 6 bytes
  const pick = [{ name: "taxi.pdf", size: 10 }];
  const r = checkStorageQuota([{ size: 20 }], [...staged, ...pick], 35);
  ok("expense receipts: staged data URL + new pick are summed", r.adding === 16 && r.total === 36 && r.ok === false);
  ok("expense receipts: under the line is fine", checkStorageQuota([{ size: 20 }], [...staged, ...pick], 36).ok === true);
}

// ── Formatting ──────────────────────────────────────────────────────────
eq("fmt bytes", fmtQuotaBytes(512), "512 bytes");
eq("fmt KB", fmtQuotaBytes(2048), "2.0 KB");
eq("fmt MB", fmtQuotaBytes(240 * MB), "240 MB");
eq("fmt GB", fmtQuotaBytes(1.94 * GB), "1.9 GB");
eq("fmt negative is 0", fmtQuotaBytes(-5), "0 bytes");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
