// The hero tiles beside the compliance ring. They must count only the records
// that can lapse, on the same rule the ring uses, so the two never disagree.
// Mirrors the credStats memo in src/App.jsx.
const MS = 86400000;
function credStats(allCreds, missingExpiration, lead = 90, now = new Date()) {
  const needsDate = new Set(missingExpiration.map(m => m.item.id));
  let active = 0, expiring = 0, expired = 0, undated = 0;
  for (const c of allCreds) {
    if (c.expirationDate) {
      const days = Math.ceil((new Date(c.expirationDate) - now) / MS);
      if (days < 0) expired += 1;
      else if (days <= lead) expiring += 1;
      else active += 1;
    } else if (needsDate.has(c.id)) undated += 1;
  }
  return { active, expiring, expired, undated, total: active + expiring + expired + undated };
}

let pass = 0, fail = 0;
const ok = (n, c, x = "") => { if (c) pass++; else { fail++; console.log(`FAIL ${n} ${x}`); } };
const NOW = new Date("2026-09-03T12:00:00Z");
const d = (n) => new Date(NOW.getTime() + n * MS).toISOString().slice(0, 10);

{
  // The real shape that produced "1617 Active": 1,538 case logs and other
  // never-expiring records alongside a handful of real credentials.
  const cases = Array.from({ length: 1538 }, (_, i) => ({ id: `case${i}`, _sec: "caseLogs" }));
  const creds = [
    { id: "ins1", _sec: "insurance", expirationDate: d(36) },
    { id: "ins2", _sec: "insurance", expirationDate: d(36) },
    { id: "priv", _sec: "privileges", expirationDate: d(55) },
    { id: "co", _sec: "licenses", expirationDate: d(240) },
    { id: "ca", _sec: "licenses", expirationDate: d(393) },
    { id: "dea", _sec: "licenses", expirationDate: d(1002) },
    { id: "old", _sec: "licenses", expirationDate: d(-3) },
    { id: "nodate", _sec: "privileges" },
  ];
  const r = credStats([...cases, ...creds], [{ item: { id: "nodate" } }], 90, NOW);
  ok("case logs are not credentials and are never counted", r.total === 8, `total ${r.total}`);
  ok("Active counts only what expires beyond the window", r.active === 3, `active ${r.active}`);
  ok("three expiring inside the window are reported", r.expiring === 3, `expiring ${r.expiring}`);
  ok("an expired credential is its own count", r.expired === 1, `expired ${r.expired}`);
  ok("a record owing a date is not called active", r.undated === 1, `undated ${r.undated}`);
  ok("the four buckets account for every counted record",
    r.active + r.expiring + r.expired + r.undated === r.total);
}
{
  // Acknowledging silences the reminder; it does not renew the credential, so
  // the tile must still report it. This is the "none expiring but there are
  // three" contradiction.
  const creds = [{ id: "a", expirationDate: d(36) }, { id: "b", expirationDate: d(55) }];
  const r = credStats(creds, [], 90, NOW);
  ok("an acknowledged item is still expiring", r.expiring === 2, `expiring ${r.expiring}`);
}
{
  const r = credStats([{ id: "x", expirationDate: d(91) }], [], 90, NOW);
  ok("the day past the window is active", r.active === 1 && r.expiring === 0);
  const r2 = credStats([{ id: "x", expirationDate: d(90) }], [], 90, NOW);
  ok("the last day inside the window is expiring", r2.expiring === 1 && r2.active === 0);
}
ok("an empty file counts nothing", credStats([], [], 90, NOW).total === 0);

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
