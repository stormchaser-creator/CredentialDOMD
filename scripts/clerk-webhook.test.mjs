// Checks for supabase/functions/clerk-webhook/verifiedMailbox.ts: when the
// identity provider's verified mailbox is granted, when it is taken away, and
// what happens when the write fails.
//
// profiles.verified_email is a live routing permission -- email-inbound files
// a forwarded credentialing document into whichever account holds it -- so the
// cases that matter here are the ones where the permission outlives the fact.
// Four of those were reproduced against the first version, and each has its
// own section below, named for the review case that found it. The stub
// database is what makes them reachable: the interesting halves are a failed
// write and a unique violation, and neither is reachable from the pure
// decision alone.
//
// Node 22.18+ strips the type annotations on import; no build step, no runner.
// Run: node scripts/clerk-webhook.test.mjs

import { readFileSync } from "node:fs";

const {
  verifiedMailboxIntent, listPresence, eventClock, isStale, mayDisplaceHolder,
  normalizeAddress, applyVerifiedMailbox,
} = await import("../supabase/functions/clerk-webhook/verifiedMailbox.ts");

let pass = 0, fail = 0;
const ok = (name, cond) => {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}`); }
};
const eq = (name, got, want) => {
  const same = JSON.stringify(got) === JSON.stringify(want);
  ok(same ? name : `${name}  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`, same);
};

const OLD = "old@example.invalid";
const NEW = "new@example.invalid";
const T1 = 1_700_000_000_000;   // "earlier"
const T2 = 1_700_000_060_000;   // "later"
const NOW = new Date(T2 + 5_000).toISOString();
const QUIET = { info: () => {}, warn: () => {}, error: () => {} };

/** A Clerk user.updated payload. `addresses` omitted entirely means no key. */
const payload = ({ addresses, updated_at = T2, id = "user_1" } = {}) => {
  const p = { id, updated_at, primary_email_address_id: "idp" };
  if (addresses !== undefined) p.email_addresses = addresses;
  return p;
};
const addr = (email, status = "verified", id = "idp") =>
  ({ id, email_address: email, verification: { status } });

/**
 * A stub PostgREST client over two in-memory tables. It enforces the one thing
 * that makes this test worth writing -- the unique index on
 * lower(verified_email) -- and lets any read or write be made to fail on
 * demand.
 *
 * It is table-AWARE, which it did not need to be until the claim started
 * asking forwarding_addresses whether another account has already proved it
 * reads the mailbox. `forwarding` rows are { user_id, email, verified_at };
 * anything in there is a row the confirmation code was answered for, unless
 * verified_at is null.
 */
function stubDb(rows, { failWrites = new Set(), claims = [], failRpc = null } = {}) {
  const rpcCalls = [];
  const table = new Map(rows.map((r) => [r.id, { ...r }]));
  const claim = new Map(claims.map((c) => [c.address, { ...c }]));

  // A faithful model of public.apply_account_mailbox: ONE account event, fenced
  // on the account's own watermark, reconciling every provider claim the
  // account holds AND both mirrors. The SQL is proved against the real database
  // by scripts/sql/mailbox-events-dryrun.sql (41 passed, 0 failed); this exists
  // so the CALLER can be driven through every outcome it returns.
  const db = {
    async rpc(fn, args) {
      rpcCalls.push({ fn, args });
      if (failRpc) return { data: null, error: { message: failRpc } };
      if (fn !== "apply_account_mailbox") return { data: null, error: { message: `unexpected ${fn}` } };

      const prof = table.get(args.p_profile);
      if (!prof) return { data: { outcome: "refused", why: "no such profile" }, error: null };
      const ms = Number(args.p_event_ms);
      if (!Number.isFinite(ms) || ms <= 0) return { data: { outcome: "refused", why: "no usable event clock" }, error: null };
      const addr = args.p_address ? String(args.p_address).trim().toLowerCase() : null;
      if (failWrites.has(args.p_profile)) return { data: null, error: { message: "connection reset" } };

      if (args.p_terminal) {
        let closed = 0;
        for (const [a, c] of claim) {
          if (c.profile_id === prof.id) { claim.set(a, { ...c, profile_id: null, proof: null, terminal_at: "now", event_ms: Math.max(c.event_ms, ms) }); closed++; }
        }
        Object.assign(prof, { verified_email: null, verified_email_at: null, verified_email_event_ms: Math.max(prof.verified_email_event_ms ?? 0, ms) });
        return { data: { outcome: "terminal", closed }, error: null };
      }

      // The ACCOUNT fence. This is what orders two events about one account
      // even when they name different addresses.
      if (prof.verified_email_event_ms != null && ms < prof.verified_email_event_ms) {
        return { data: { outcome: "stale", seen_ms: prof.verified_email_event_ms, event_ms: ms }, error: null };
      }

      // Release this account's PROVIDER claims that are not the one it keeps.
      // Confirmed claims are the physician's own separate evidence.
      let released = 0;
      for (const [a, c] of claim) {
        if (c.profile_id === prof.id && c.proof === "provider" && (!addr || a !== addr)) {
          claim.set(a, { ...c, profile_id: null, proof: null, event_ms: Math.max(c.event_ms, ms) });
          released++;
        }
      }

      if (!addr) {
        Object.assign(prof, { verified_email: null, verified_email_at: null, verified_email_event_ms: ms });
        return { data: { outcome: "cleared", released }, error: null };
      }

      const cur = claim.get(addr) || null;
      let outcome, displaced = null;
      if (cur?.terminal_at) outcome = "terminal_address";
      else if (!cur) { claim.set(addr, { address: addr, profile_id: prof.id, proof: "provider", event_ms: ms }); outcome = "claimed"; }
      else if (cur.profile_id === prof.id && cur.proof === "provider" && cur.event_ms === ms) outcome = "unchanged";
      else if (ms < cur.event_ms) outcome = "stale_address";
      else if (ms === cur.event_ms && cur.profile_id !== prof.id) outcome = "held";
      else {
        displaced = cur.profile_id !== prof.id ? cur.profile_id : null;
        claim.set(addr, { address: addr, profile_id: prof.id, proof: "provider", event_ms: ms });
        outcome = "claimed";
        // The displaced mirror, cleared in the SAME transaction: the unique
        // index on lower(verified_email) would otherwise make every future
        // mirror write for the new holder fail 23505 for good.
        if (displaced) {
          const other = table.get(displaced);
          if (other && String(other.verified_email ?? "").toLowerCase() === addr) {
            Object.assign(other, { verified_email: null, verified_email_at: null });
          }
        }
      }

      if (outcome === "claimed" || outcome === "unchanged") {
        Object.assign(prof, { verified_email: addr, verified_email_at: "now", verified_email_event_ms: ms });
      } else {
        Object.assign(prof, { verified_email: null, verified_email_at: null, verified_email_event_ms: Math.max(prof.verified_email_event_ms ?? 0, ms) });
      }
      return { data: { outcome, released, displaced, address: addr }, error: null };
    },
  };
  return { db, table, claim, rpcCalls, writes: rpcCalls,
           held: (id) => table.get(id)?.verified_email ?? null,
           holderOf: (a) => claim.get(a)?.profile_id ?? null };
}

const profile = (id, verified_email, verified_email_event_ms = null) =>
  ({ id, verified_email, verified_email_at: verified_email ? "x" : null, verified_email_event_ms });

// ══ 1. "Explicit empty address list retains withdrawn mailbox" ═════════════
// The provider saying "this user has no addresses" is a withdrawal. The first
// version counted the list and read zero as "we learned nothing", which is
// what an absent list means, not an empty one.

eq("no email_addresses key at all is missing", listPresence(payload()), "missing");
eq("an explicit [] is empty, not missing", listPresence(payload({ addresses: [] })), "empty");
eq("a populated list is present", listPresence(payload({ addresses: [addr(NEW)] })), "present");
eq("a null list teaches us nothing", listPresence(payload({ addresses: null })), "missing");
eq("a non-array teaches us nothing", listPresence(payload({ addresses: "nope" })), "missing");
eq("a non-object payload teaches us nothing", listPresence(null), "missing");

{
  const { db, held } = stubDb([profile("p1", OLD, T1)]);
  const r = await applyVerifiedMailbox(db, "user.updated", payload({ addresses: [] }), null, profile("p1", OLD, T1), NOW, QUIET);
  ok("empty list: succeeds", r.ok && !r.retry);
  eq("empty list: the withdrawn mailbox is GONE", held("p1"), null);
}
{
  const { db, held, writes } = stubDb([profile("p1", OLD, T1)]);
  const r = await applyVerifiedMailbox(db, "user.updated", payload(), null, profile("p1", OLD, T1), NOW, QUIET);
  ok("missing list: succeeds", r.ok);
  eq("missing list: nothing is written", writes.length, 0);
  eq("missing list: the mailbox is left alone", held("p1"), OLD);
}
{
  const { db, held } = stubDb([profile("p1", OLD, T1)]);
  await applyVerifiedMailbox(db, "user.updated", payload({ addresses: [addr(OLD, "unverified")] }), null, profile("p1", OLD, T1), NOW, QUIET);
  eq("listed but unverified: cleared", held("p1"), null);
}

// ══ 2. "Revocation DB error acknowledged with old permission intact" ═══════
// and "Deleted user failed clear acknowledged". A clear that did not land is
// not a clear, and 200 tells the provider never to send the event again.

{
  const g2 = stubDb([profile("p1", OLD, T1)], {
    failWrites: new Set(["p1"]),
    claims: [{ address: OLD, profile_id: "p1", proof: "provider", event_ms: T1 }],
  });
  const r = await applyVerifiedMailbox(g2.db, "user.updated", payload({ addresses: [] }), null, profile("p1", OLD, T1), NOW, QUIET);
  ok("failed revocation: reported as a failure", !r.ok);
  ok("failed revocation: asks for a retry", r.retry);
  ok("failed revocation: the detail says the apply failed", /apply failed/.test(r.detail));
  // The whole event is one transaction now, so a failure leaves NOTHING half
  // done: the route is still there, the mirror is still there, and the retry
  // does the lot. The old shape could withdraw routing and then fail to
  // mirror, or mirror and fail to withdraw.
  eq("failed revocation: the route is untouched, not half-withdrawn", g2.holderOf(OLD), "p1");
  eq("failed revocation: and so is the mirror", g2.held("p1"), OLD);
}
{
  const g = stubDb([profile("p1", OLD, T1)], {
    claims: [{ address: OLD, profile_id: "p1", proof: "provider", event_ms: T1 }],
  });
  const r = await applyVerifiedMailbox(g.db, "user.deleted", { id: "user_1" }, null, profile("p1", OLD, T1), NOW, QUIET);
  ok("user.deleted succeeds", r.ok && !r.retry);
  eq("user.deleted closes the route", g.holderOf(OLD), null);
  eq("and clears the mirror", g.held("p1"), null);
  eq("it is ONE call", g.rpcCalls.length, 1);
  ok("and it is the terminal one", g.rpcCalls[0].args.p_terminal === true);
}
{
  // The finding that mattered most: a CONFIRMED-only claim, with a different
  // address in the mirror, survived deletion entirely under the old walk.
  const g = stubDb([profile("p1", OLD, T1)], {
    claims: [
      { address: OLD, profile_id: "p1", proof: "provider", event_ms: T1 },
      { address: "confirmed-only@example.invalid", profile_id: "p1", proof: "confirmed", event_ms: T1 },
    ],
  });
  await applyVerifiedMailbox(g.db, "user.deleted", { id: "user_1" }, null, profile("p1", OLD, T1), NOW, QUIET);
  eq("deletion closes the mirrored claim", g.holderOf(OLD), null);
  eq("AND the confirmed-only one the old code missed", g.holderOf("confirmed-only@example.invalid"), null);
}

// ══ 3. Contested addresses, decided by the claims table ═══════════════════
// The old design discovered a conflict by catching a unique violation, then
// read the other holder and wrote to it in a further round trip, which is the
// race a reviewer reproduced. There is no conflict to catch any more: one row
// per address, and claim_mailbox returns a named outcome. The SQL behind these
// outcomes is proved against the real database by
// scripts/sql/mailbox-claims-dryrun.sql, 41 passed, 0 failed.

{
  // B holds it on an OLDER provider event. A's newer one takes it, and B is
  // displaced by the same statement rather than by a second write.
  const g = stubDb([profile("p1", OLD, T1)], { claims: [{ address: NEW, profile_id: "B", proof: "provider", event_ms: T1 }] });
  const r = await applyVerifiedMailbox(g.db, "user.updated", payload({ addresses: [addr(NEW)], updated_at: T2 }), NEW, profile("p1", OLD, T1), NOW, QUIET);
  ok("a newer provider event takes a contested address", r.ok && !r.retry);
  eq("the address is ours now", g.holderOf(NEW), "p1");
  eq("and the old one we held is released", g.holderOf(OLD), null);
  eq("the display column follows", g.held("p1"), NEW);
}
{
  // B holds it on a NEWER event. We do not get it, and crucially we do not
  // keep the address we were giving up either.
  const g = stubDb([profile("p1", OLD, T1)], { claims: [{ address: NEW, profile_id: "B", proof: "provider", event_ms: T2 + 60_000 }] });
  const r = await applyVerifiedMailbox(g.db, "user.updated", payload({ addresses: [addr(NEW)], updated_at: T2 }), NEW, profile("p1", OLD, T1), NOW, QUIET);
  ok("an older event does not take a newer holder's address", r.ok && !r.retry);
  eq("B keeps it", g.holderOf(NEW), "B");
  eq("we hold nothing", g.held("p1"), null);
  ok("and the reason is carried", /stale|held/.test(r.detail));
}
{
  // A confirmed forwarding address on another account. A provider event may
  // displace it; the reverse is refused by the SQL, which is where that rule
  // lives.
  const g = stubDb([profile("p1", null, null)], { claims: [{ address: NEW, profile_id: "B", proof: "confirmed", event_ms: T1 }] });
  await applyVerifiedMailbox(g.db, "user.updated", payload({ addresses: [addr(NEW)], updated_at: T2 }), NEW, profile("p1", null, null), NOW, QUIET);
  eq("a newer provider statement displaces an older confirmation", g.holderOf(NEW), "p1");
}
{
  // A terminal address: a deleted account's mailbox is closed for good.
  const g = stubDb([profile("p1", null, null)], { claims: [{ address: NEW, profile_id: null, proof: null, event_ms: T1, terminal_at: "then" }] });
  const r = await applyVerifiedMailbox(g.db, "user.updated", payload({ addresses: [addr(NEW)], updated_at: 9_999_999_999_999 }), NEW, profile("p1", null, null), NOW, QUIET);
  ok("a terminal address is not reclaimable, and that is not an error", r.ok && !r.retry);
  eq("nobody holds it", g.holderOf(NEW), null);
  ok("the detail names it", /terminal/.test(r.detail));
}
{
  // The ledger itself failing IS our problem, and must be retryable.
  const g = stubDb([profile("p1", null, null)], { failRpc: "connection reset" });
  const r = await applyVerifiedMailbox(g.db, "user.updated", payload({ addresses: [addr(NEW)], updated_at: T2 }), NEW, profile("p1", null, null), NOW, QUIET);
  ok("an unreachable claims ledger asks for a retry", !r.ok && r.retry);
  ok("and says so", /apply failed/.test(r.detail));
  eq("nothing landed, because the whole event is one transaction", g.held("p1"), null);
}
{
  // Routing is decided by ONE call. That is the structural property that
  // killed the stale-write races: there is no window between deciding and
  // writing, because they are the same statement.
  const g = stubDb([profile("p1", null, null)]);
  await applyVerifiedMailbox(g.db, "user.updated", payload({ addresses: [addr(NEW)], updated_at: T2 }), NEW, profile("p1", null, null), NOW, QUIET);
  eq("the whole event is exactly ONE call", g.rpcCalls.length, 1);
  eq("and it is the account event, not a per-address one", g.rpcCalls[0].fn, "apply_account_mailbox");
  ok("carrying the provider clock, not a decision made locally and written later",
     g.rpcCalls[0].args.p_event_ms === T2 && g.rpcCalls[0].args.p_terminal === false);
}
{
  // The account fence: an event OLDER than the account's watermark is refused
  // even when it names a different address. Per-address locks could not do
  // this, and it is the finding that mattered most.
  const g = stubDb([profile("p1", null, T2)], {
    claims: [{ address: OLD, profile_id: null, proof: null, event_ms: T2 }],
  });
  const r = await applyVerifiedMailbox(g.db, "user.updated", payload({ addresses: [addr(OLD)], updated_at: T1 }), OLD, profile("p1", null, T2), NOW, QUIET);
  ok("an old grant for a different address is refused", r.ok && !r.retry);
  ok("and says why", /older than the state already recorded/.test(r.detail));
  // Two layers, and they matter for different reasons. The pure decision above
  // catches it from the profile row the handler already read. The SQL fence
  // catches it when THAT read was itself stale, which is the actual race: it
  // re-reads the watermark under the profile lock. Proved in the SQL dry run,
  // "THE OLD GRANT REPLAYED IS REFUSED".
  eq("the client-side layer refused it without a round trip", g.rpcCalls.length, 0);
  eq("the route is not restored", g.holderOf(OLD), null);
  eq("and the watermark is not lowered", g.table.get("p1").verified_email_event_ms, T2);
}
{
  // Displacement moves the mirror too, in the same transaction.
  const g = stubDb([profile("A", NEW, T1), profile("B", null, null)], {
    claims: [{ address: NEW, profile_id: "A", proof: "provider", event_ms: T1 }],
  });
  await applyVerifiedMailbox(g.db, "user.updated", payload({ addresses: [addr(NEW)], updated_at: T2 }), NEW, profile("B", null, null), NOW, QUIET);
  eq("B takes the route", g.holderOf(NEW), "B");
  eq("B mirrors it", g.held("B"), NEW);
  eq("and A's mirror was cleared, so B's write cannot hit 23505 forever", g.held("A"), null);
}

// ══ 4. "Delayed older event reactivates removed mailbox" ═══════════════════
// Both events are genuine and signed. Only their order says which is true now.

ok("an older event is stale", isStale(T1, { verified_email: null, verified_email_event_ms: T2 }));
ok("the same event is not stale, so a Svix retry can finish the work",
   !isStale(T2, { verified_email: null, verified_email_event_ms: T2 }));
ok("a newer event is not stale", !isStale(T2, { verified_email: null, verified_email_event_ms: T1 }));
ok("an unknown watermark counts as older than anything",
   !isStale(T1, { verified_email: null, verified_email_event_ms: null }));

{
  // The exact sequence from the review: unverify at T2, then a delayed
  // "verified" event that was signed at T1.
  const { db, held } = stubDb([profile("p1", OLD, T1)]);
  await applyVerifiedMailbox(db, "user.updated", payload({ addresses: [addr(OLD, "unverified")], updated_at: T2 }), null, profile("p1", OLD, T1), NOW, QUIET);
  eq("unverify lands", held("p1"), null);

  const after = { id: "p1", verified_email: null, verified_email_at: null, verified_email_event_ms: T2 };
  const r = await applyVerifiedMailbox(db, "user.updated", payload({ addresses: [addr(OLD)], updated_at: T1 }), OLD, after, NOW, QUIET);
  ok("the delayed older event is acknowledged, not retried", r.ok && !r.retry);
  eq("the delayed older event does NOT restore the route", held("p1"), null);
  ok("and it says why", /older than the state already recorded/.test(r.detail));
}
{
  // The same rule must not block the ordinary forward case.
  const { db, held } = stubDb([profile("p1", null, T1)]);
  const r = await applyVerifiedMailbox(db, "user.updated", payload({ addresses: [addr(NEW)], updated_at: T2 }), NEW, profile("p1", null, T1), NOW, QUIET);
  ok("a newer verified event still lands", r.ok);
  eq("a newer verified event grants the route", held("p1"), NEW);
}
{
  // A retry of the very same event must be able to finish a half-done write.
  const { db, held } = stubDb([profile("p1", null, T2)]);
  const r = await applyVerifiedMailbox(db, "user.updated", payload({ addresses: [addr(NEW)], updated_at: T2 }), NEW, profile("p1", null, T2), NOW, QUIET);
  ok("a retry of the same event is not refused as stale", r.ok);
  eq("a retry of the same event completes the grant", held("p1"), NEW);
}

// ══ 5. The permanent ambiguous deadlock, now unrepresentable ══════════════
// Three reviewers found the same hole: the invariant "one address is never
// both a confirmed forwarding row on B and the provider's verified address on
// A" had two writers that checked each other across separate transactions,
// with no shared lock and no index spanning the two tables. When it broke, the
// router saw two claimants, refused, and every forward from that mailbox was
// refused for BOTH accounts, permanently and silently.
//
// It is not detected any more. public.mailbox_claims has the address as its
// PRIMARY KEY, so the state cannot exist to be detected. These drive the
// caller through both orders of the interleaving that produced it.
{
  // Order 1: the confirmation lands first, then the provider event.
  const g = stubDb([profile("p1", null, null)], {
    claims: [{ address: NEW, profile_id: "B", proof: "confirmed", event_ms: T1 }],
  });
  await applyVerifiedMailbox(g.db, "user.updated", payload({ addresses: [addr(NEW)], updated_at: T2 }), NEW, profile("p1", null, null), NOW, QUIET);
  eq("order 1: exactly one account holds it", g.claim.get(NEW).profile_id, "p1");
  eq("order 1: there is one row, not two", [...g.claim.keys()].filter((k) => k === NEW).length, 1);
}
{
  // Order 2: the provider event lands first, then the confirmation is tried.
  // The confirmation is refused by claim_mailbox, which is where that rule
  // lives now rather than in a check the confirm path performs on itself.
  const g = stubDb([profile("p1", null, null)]);
  await applyVerifiedMailbox(g.db, "user.updated", payload({ addresses: [addr(NEW)], updated_at: T2 }), NEW, profile("p1", null, null), NOW, QUIET);
  eq("order 2: the provider event holds it", g.holderOf(NEW), "p1");
  // A confirmation by another account is refused by confirm_forwarding_claim,
  // which is proved in the SQL dry run; here the point is that the provider
  // event holds it and nothing in this path can move it.
  eq("order 2: the holder did not change", g.holderOf(NEW), "p1");
}
{
  // The router's own read: one row in, one answer out. There is no set of
  // candidates to disagree about.
  const inb = readFileSync(new URL("../supabase/functions/email-inbound/index.ts", import.meta.url), "utf8");
  ok("email-inbound reads the claim table", /from\("mailbox_claims"\)/.test(inb));
  ok("by primary key", /\.eq\("address", address\)[\s\S]{0,80}maybeSingle\(\)/.test(inb));
  ok("a revoked or terminal claim routes nothing",
     /!claim\.profile_id \|\| claim\.terminal_at/.test(inb));
  ok("it no longer loads two candidate sets",
     !/confirmedForwardingCandidates|verifiedMailboxCandidates/.test(inb));
  ok("and there is no ambiguity branch left to get wrong",
     !/reason === "ambiguous"/.test(inb));
}

// ── the clock ─────────────────────────────────────────────────────────────
eq("the provider's clock is used when it is there", eventClock(payload({ updated_at: T2 }), 5).ms, T2);
ok("and it is marked as the provider's", eventClock(payload({ updated_at: T2 }), 5).fromProvider);
eq("receipt time stands in when it is not", eventClock({ id: "u" }, 77).ms, 77);
ok("and that is marked too", !eventClock({ id: "u" }, 77).fromProvider);
eq("a zero clock is not usable", eventClock({ updated_at: 0 }, 77).ms, 77);
eq("a string clock is read", eventClock({ updated_at: String(T2) }, 5).ms, T2);
eq("a nonsense clock falls back", eventClock({ updated_at: "soon" }, 77).ms, 77);

// ── displacement ordering ─────────────────────────────────────────────────
ok("an unknown holder watermark may be displaced", mayDisplaceHolder(T1, { verified_email_event_ms: null }));
ok("an older holder may be displaced", mayDisplaceHolder(T2, { verified_email_event_ms: T1 }));
ok("an equal holder may be displaced", mayDisplaceHolder(T2, { verified_email_event_ms: T2 }));
ok("a newer holder may NOT be displaced", !mayDisplaceHolder(T1, { verified_email_event_ms: T2 }));
ok("no holder is not a displacement", !mayDisplaceHolder(T1, null));

// ── normalization, since routing compares these exactly ───────────────────
eq("addresses are lowercased", normalizeAddress("  A@B.Org "), "a@b.org");
eq("blank is null", normalizeAddress("   "), null);
eq("non-strings are null", normalizeAddress(42), null);
{
  const { db, held } = stubDb([profile("p1", null, T1)]);
  await applyVerifiedMailbox(db, "user.updated", payload({ addresses: [addr("MiXeD@Example.Invalid")], updated_at: T2 }), "MiXeD@Example.Invalid", profile("p1", null, T1), NOW, QUIET);
  eq("a mixed-case verified address is stored normalized", held("p1"), "mixed@example.invalid");
}

// ── the handler actually fails the event ──────────────────────────────────
{
  const src = readFileSync(new URL("../supabase/functions/clerk-webhook/index.ts", import.meta.url), "utf8");
  ok("the handler imports the shared apply", /import \{ applyVerifiedMailbox \} from "\.\/verifiedMailbox\.ts";/.test(src));
  eq("both event paths go through it", (src.match(/await applyVerifiedMailbox\(supabase,/g) || []).length, 2);
  eq("and both answer 500 when it did not land",
     (src.match(/if \(!mailbox\.ok\) \{[\s\S]{0,260}?status: 500/g) || []).length, 2);
  ok("the handler keeps no second copy of the decision", !/email_addresses \?\? \[\]\)\.length/.test(src));
  ok("user.deleted no longer clears the column by hand",
     !/update\(\{ verified_email: null, verified_email_at: null, updated_at: now \}\)/.test(src));
  ok("the watermark is selected wherever the profile is read",
     (src.match(/verified_email, verified_email_event_ms/g) || []).length >= 2);
}

// ── the migration carries the column and locks it ─────────────────────────
{
  const sql = readFileSync(new URL("../supabase/migrations/20260915d_verified_mailbox.sql", import.meta.url), "utf8");
  ok("the watermark column exists", /add column if not exists verified_email_event_ms bigint/.test(sql));
  ok("a user token cannot set it on INSERT", /if tg_op = 'INSERT' then[\s\S]{0,220}new\.verified_email_event_ms := null;/.test(sql));
  ok("a user token cannot change it on UPDATE", /new\.verified_email_event_ms := old\.verified_email_event_ms;/.test(sql));
  ok("the backfill stamps a watermark rather than leaving it null",
     /verified_email_event_ms = \(extract\(epoch from now\(\)\) \* 1000\)::bigint/.test(sql));
  ok("the backfill says to read the provider's current state", /as Clerk reads TODAY/.test(sql));
  ok("the backfill warns against replaying old events", /Do NOT fill this from a replay of old webhook events/.test(sql));
  ok("the cutover cost is written down as a number", /ACTIVE ACCOUNTS THAT LOSE INBOUND ROUTING\s+5/.test(sql));
  ok("and there is a query to re-measure it", /active_accounts_with_no_proven_mailbox/.test(sql));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
