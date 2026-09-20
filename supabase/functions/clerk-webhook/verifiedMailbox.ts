/**
 * The verified-mailbox decision, with no I/O in it.
 *
 * profiles.verified_email is a live routing permission: email-inbound files a
 * forwarded credentialing document into the account that holds it. So the
 * interesting questions here are not about writing a column, they are about
 * when a permission is granted and, much more importantly, when it is taken
 * away. A review of the first version reproduced four ways the permission
 * outlived the fact behind it, and all four are decided in this file:
 *
 *   1. MISSING IS NOT EMPTY. The first version asked how many addresses the
 *      payload listed and treated zero as "we learned nothing". But an event
 *      whose email_addresses is an explicit [] is the provider saying this
 *      user has no addresses at all, which is a withdrawal. Only an event with
 *      no email_addresses KEY teaches us nothing. listPresence() is that
 *      distinction, and it is the reason the raw payload is inspected rather
 *      than a `?? []` default.
 *
 *   2. ORDER. Webhooks arrive out of order and get retried. An unverify
 *      followed by a delayed, older "verified" event restored a permission the
 *      provider had already withdrawn, and every signature was valid, because
 *      the old event WAS genuine when it was signed. Each decision therefore
 *      carries the provider's own clock (Clerk's user.updated_at) and a write
 *      is refused if the profile already holds the result of a NEWER event.
 *      Equal is allowed, so a Svix retry of the same event still completes.
 *
 *   3. CONFLICT. Two accounts cannot both hold one verified address: there is
 *      a unique index, and Clerk will not verify one address on two users. So
 *      a unique violation means the row we are holding is stale, not that the
 *      new claim is suspect. The first version swallowed the violation and
 *      left the OLD address in place, which is the worst of the three
 *      outcomes: the account keeps routing a mailbox the provider has just
 *      said belongs elsewhere. clearFirst() is why the clear is a separate
 *      write that cannot collide.
 *
 *   4. FAILURE IS NOT SUCCESS. A revocation that could not be written is not a
 *      revocation. Every path here reports whether the intended state was
 *      reached, so the caller can answer the provider with a retryable error
 *      rather than 200.
 *
 *   5. THE OTHER PROOF. email-inbound accepts two proofs that an account reads
 *      a mailbox: a confirmed forwarding_addresses row, and this column. When
 *      one account holds each for the same address, forwarding-address/lib.ts
 *      inboundMatch answers "ambiguous" and email-inbound files the document
 *      for NEITHER account. Adding a forwarding address already refuses when
 *      another account holds it here (provenByAnotherAccount); this file did
 *      not look at forwarding_addresses at all, so the write path was free to
 *      manufacture the deadlock the read path then refuses on. There is no
 *      in-app signal when it happens: the forwarding row still says Confirmed
 *      and the route is simply dead. The claim now refuses instead, so the
 *      account that already proved it reads the mailbox keeps working;
 *      forwardingHolder is that check.
 */

export type ListPresence = "missing" | "empty" | "present";
export type MailboxAction = "skip" | "write" | "clear";

export interface MailboxState {
  verified_email: string | null;
  verified_email_event_ms: number | null;
}

export interface MailboxIntent {
  action: MailboxAction;
  /** The address to hold after this event; null for a clear. */
  address: string | null;
  /** The provider clock this decision is stamped with, and the new watermark. */
  eventMs: number;
  reason: string;
}

export function normalizeAddress(e: unknown): string | null {
  const t = typeof e === "string" ? e.trim().toLowerCase() : "";
  return t.length > 0 ? t : null;
}

/**
 * Whether the payload carried an address list at all, and whether it was empty.
 *
 * Deliberately reads the raw object rather than a typed field: `?? []` is
 * exactly the coercion that made an explicit [] indistinguishable from a
 * missing key, and an explicit [] is a withdrawal.
 */
export function listPresence(payload: unknown): ListPresence {
  if (!payload || typeof payload !== "object") return "missing";
  if (!("email_addresses" in (payload as Record<string, unknown>))) return "missing";
  const list = (payload as { email_addresses?: unknown }).email_addresses;
  if (list === null || list === undefined) return "missing";
  if (!Array.isArray(list)) return "missing";
  return list.length === 0 ? "empty" : "present";
}

/**
 * The provider's own clock for this event, in milliseconds.
 *
 * Clerk sends user.updated_at as epoch ms. When it is absent or unusable the
 * receipt time stands in: ordering by arrival is worse than ordering by the
 * source, and far better than not ordering at all. `fromProvider` says which
 * happened so the log can be honest about it.
 */
export function eventClock(payload: unknown, nowMs: number): { ms: number; fromProvider: boolean } {
  const raw = (payload as { updated_at?: unknown } | null)?.updated_at;
  const n = typeof raw === "number" ? raw : Number(raw);
  if (Number.isFinite(n) && n > 0) return { ms: Math.floor(n), fromProvider: true };
  return { ms: nowMs, fromProvider: false };
}

/**
 * Is this event older than the state the profile already holds?
 *
 * Strictly older, so a retry of the same event is not mistaken for a stale one
 * and can finish work an earlier attempt left half done.
 */
export function isStale(eventMs: number, current: MailboxState): boolean {
  const seen = current.verified_email_event_ms;
  return typeof seen === "number" && Number.isFinite(seen) && eventMs < seen;
}

export interface IntentInput {
  eventType: string;
  payload: unknown;
  /** The first verified address in the payload, already normalized, or null. */
  verified: string | null;
  current: MailboxState;
  nowMs: number;
}

export function verifiedMailboxIntent(input: IntentInput): MailboxIntent {
  const { ms, fromProvider } = eventClock(input.payload, input.nowMs);
  const clock = fromProvider ? "" : " (no provider clock; using receipt time)";

  // Deletion is terminal and carries no address list. It clears
  // unconditionally and raises the watermark to now, so an event that was
  // already in flight when the account was deleted cannot restore the route.
  if (input.eventType === "user.deleted") {
    return {
      action: "clear",
      address: null,
      eventMs: input.nowMs,
      reason: "the provider deleted this user, so the verification behind the route is withdrawn",
    };
  }

  if (isStale(ms, input.current)) {
    return {
      action: "skip",
      address: input.current.verified_email,
      eventMs: ms,
      reason: `event is older than the state already recorded (${ms} < ${input.current.verified_email_event_ms}); a newer event has already been applied${clock}`,
    };
  }

  const presence = listPresence(input.payload);
  if (presence === "missing") {
    return {
      action: "skip",
      address: input.current.verified_email,
      eventMs: ms,
      reason: "payload carried no email_addresses field, so it says nothing about this account's mailboxes",
    };
  }

  if (presence === "empty") {
    return {
      action: "clear",
      address: null,
      eventMs: ms,
      reason: `the provider reports this account has no addresses at all${clock}`,
    };
  }

  const verified = normalizeAddress(input.verified);
  if (!verified) {
    return {
      action: "clear",
      address: null,
      eventMs: ms,
      reason: `addresses are listed and none is verified${clock}`,
    };
  }

  const held = normalizeAddress(input.current.verified_email);
  if (held === verified && typeof input.current.verified_email_event_ms === "number" && input.current.verified_email_event_ms >= ms) {
    return { action: "skip", address: verified, eventMs: ms, reason: "already held, and already recorded at or after this event" };
  }

  return {
    action: "write",
    address: verified,
    eventMs: ms,
    reason: held && held !== verified
      ? `the provider's verified address changed${clock}`
      : `the provider verified an address for this account${clock}`,
  };
}

/**
 * Whether a conflicting holder of the same address may be cleared so this
 * event can take it.
 *
 * The conflict itself is not ambiguous: the provider verifies an address for
 * at most one user, and the database has a unique index saying the same, so a
 * violation means the row we are holding predates the fact. What could still
 * be wrong is the direction of time, so the older record yields to the newer
 * one and never the reverse. An unknown watermark on the holder counts as
 * older, because it was written before this ordering existed.
 */
export function mayDisplaceHolder(eventMs: number, holder: MailboxState | null | undefined): boolean {
  if (!holder) return false;
  const seen = holder.verified_email_event_ms;
  if (typeof seen !== "number" || !Number.isFinite(seen)) return true;
  return eventMs >= seen;
}

// ─── Applying it ─────────────────────────────────────────────────────────────

/**
 * The narrowest shape of a PostgREST client this needs, so a test can hand it
 * a stub and reproduce every failure without a network or a database. The
 * failures are the interesting half of this file, and they are exactly the
 * half that a test which only calls the pure decision cannot reach.
 */
export interface MailboxDb {
  /** public.apply_account_mailbox, the routing authority. (claim_mailbox and revoke_mailbox were retired by 20260918a.) */
  rpc(fn: string, args: Record<string, unknown>): Promise<{ data: unknown; error: { message: string } | null }>;
  from(table: string): {
    update(patch: Record<string, unknown>): { eq(col: string, val: unknown): Promise<{ error: { message: string; code?: string } | null }> };
    select(cols: string): {
      eq(col: string, val: unknown): {
        neq(col: string, val: unknown): {
          maybeSingle(): Promise<{ data: unknown; error: { message: string } | null }>;
          /** The forwarding lookup: .not("verified_at", "is", null).limit(n) */
          not(col: string, op: string, val: unknown): { limit(n: number): Promise<{ data: unknown; error: { message: string } | null }> };
        };
      };
    };
  };
}

export interface MailboxProfile extends MailboxState {
  id: string;
}

export interface MailboxResult {
  ok: boolean;
  /** True when the caller should answer the provider with a retryable error. */
  retry: boolean;
  detail: string;
  /** What the account holds once this returns, as far as we could make it so. */
  held: string | null;
}

// The three helpers that used to live here are gone: writeMailbox,
// mailboxHolder and forwardingHolder. Each was one atomic round trip, and the
// SEQUENCE of them was what a review found five ways through. The whole
// account event is one transaction now, in public.apply_account_mailbox.

/**
 * ONE call. The whole account event, fenced and applied in one transaction.
 *
 * This used to be three round trips: release the old address, claim the new
 * one, mirror it onto the profile. Each was atomic on its own and the sequence
 * was not, and a review with real PostgreSQL found five ways through. The one
 * that matters most: per-ADDRESS locks cannot order ACCOUNT events, so an old
 * grant for address X and a newer revocation of the account took different
 * locks, did not order, and the old grant restored the route afterwards and
 * lowered the watermark with it.
 *
 * public.apply_account_mailbox locks the PROFILE first, fences on the account
 * watermark, reconciles every provider claim that account holds, moves the
 * displaced holder's mirror out of the way and writes ours, all in one
 * transaction. The outcomes it can return are named and logged verbatim.
 */
async function applyAccountEvent(
  db: MailboxDb, profile: string, eventMs: number, address: string | null, terminal: boolean,
) {
  const { data, error } = await db.rpc("apply_account_mailbox", {
    p_profile: profile, p_event_ms: eventMs, p_address: address, p_terminal: terminal,
  });
  if (error) return { outcome: "unavailable", why: error.message } as Record<string, unknown>;
  return (data ?? { outcome: "unavailable", why: "no answer" }) as Record<string, unknown>;
}

export async function applyVerifiedMailbox(
  db: MailboxDb,
  eventType: string,
  payload: unknown,
  verified: string | null,
  profile: MailboxProfile,
  now: string,
  log: MailboxLog = CONSOLE_LOG,
): Promise<MailboxResult> {
  const nowMs = Date.parse(now) || Date.now();
  const intent = verifiedMailboxIntent({
    eventType,
    payload,
    verified,
    current: { verified_email: profile.verified_email, verified_email_event_ms: profile.verified_email_event_ms },
    nowMs,
  });

  if (intent.action === "skip") {
    log.info(`verified mailbox: profile ${profile.id} unchanged: ${intent.reason}`);
    return { ok: true, retry: false, detail: intent.reason, held: profile.verified_email };
  }

  const terminal = eventType === "user.deleted";
  const address = intent.action === "write" ? intent.address : null;
  const r = await applyAccountEvent(db, profile.id, intent.eventMs, address, terminal);
  const outcome = String(r.outcome ?? "unavailable");

  if (outcome === "unavailable") {
    log.error(`verified mailbox: profile ${profile.id}: the claims ledger could not answer: ${String(r.why ?? "")}. Asking for a retry.`);
    return { ok: false, retry: true, detail: `apply failed: ${String(r.why ?? "")}`, held: null };
  }
  if (outcome === "refused") {
    // Bad input from us, not a transient condition. Retrying sends the same
    // thing again, so it is acknowledged and logged loudly instead.
    log.error(`verified mailbox: profile ${profile.id}: refused: ${String(r.why ?? "")}`);
    return { ok: true, retry: false, detail: `refused: ${String(r.why ?? "")}`, held: null };
  }

  // stale, held, terminal_address, stale_address: all real answers about who
  // owns what, and all final. Retrying produces the same answer forever, so
  // the event is acknowledged and the account holds no route.
  const took = outcome === "claimed" || outcome === "unchanged";
  if (!took && outcome !== "cleared" && outcome !== "terminal") {
    log.warn(`verified mailbox: profile ${profile.id} did not take the address (${outcome}): ${String(r.why ?? "")}`);
  } else {
    log.info(`verified mailbox: profile ${profile.id}: ${outcome} (${intent.reason})`);
  }
  return {
    ok: true, retry: false,
    detail: `${outcome}: ${intent.reason}`,
    held: took ? address : null,
  };
}
