// The mock server's saved state: test physicians and sessions (mock Clerk),
// Stripe objects, AI usage, operator alerts and the email index. Written
// atomically to .generated/mocks/state.json at most once a second after a
// change (and on exit), so a lab restart keeps its test physicians (their
// profiles live on in the database).
// Email bodies are stored one file each under .generated/mocks/emails/.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, readdirSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { createDeliveryAudit } from './delivery-audit.mjs';

/** How long a change waits before the state is written, so changes made together are written once. */
export const SAVE_AFTER_MS = 1000;

export function emptyState() {
  return {
    version: 1,
    clerk: { users: {}, sessions: {}, webhooks: [] },
    stripe: { customers: {}, products: {}, prices: {}, sessions: {}, subscriptions: {}, invoices: {}, invoiceItems: {}, charges: {}, refunds: {}, refundFailures: {}, portalSessions: {}, events: [], idempotency: {}, deliveries: [], plans: {} },
    emails: [],
    inbound: {},
    inboundDeliveries: {},
    telegram: [],
    ai: { usage: {}, calls: [], script: [] },
    beacons: [],
    batchIdempotency: [],
  };
}

export function createStore(dir) {
  mkdirSync(path.join(dir, 'emails'), { recursive: true });
  const file = path.join(dir, 'state.json');
  const deliveryAudit = createDeliveryAudit(path.join(dir, 'stripe-deliveries.jsonl'));
  let state = emptyState();
  if (existsSync(file)) {
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    state = { ...state, ...saved, clerk: { ...state.clerk, ...saved.clerk }, stripe: { ...state.stripe, ...saved.stripe }, ai: { ...state.ai, ...saved.ai } };
  }
  // The whole state was serialized and written synchronously on every change. After a day of
  // journeys it held 57 MB (4,700 Checkout sessions, 10,000 Clerk sessions), each save blocked
  // this one process for 0.2 to 0.5 s, and under the journeys' load its answers waited up to
  // 10 s: a Clerk session token past the app's own wait (ID-INIT-UNAVAILABLE), Clerk's key set
  // past jose's 5 s (a valid token answered 401), Stripe calls past the app's 9 s Checkout wait
  // (2026-10-01, full regression pass 2). Changes are now written together, a second after the
  // first, and on exit; what is served comes from memory, as it always did.
  let timer = null;
  const writeNow = () => {
    if (timer) { clearTimeout(timer); timer = null; }
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
    renameSync(tmp, file);
  };
  const save = () => {
    if (timer) return;
    timer = setTimeout(writeNow, SAVE_AFTER_MS);
    timer.unref?.();
  };
  const emailFile = (id) => {
    if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error('bad email id');
    return path.join(dir, 'emails', `${id}.json`);
  };
  return {
    get state() { return state; },
    save,
    deliveryAudit,
    /** Writes a change still waiting for its turn (on exit). */
    flush() { if (timer) writeNow(); },
    /** Runs fn(state) and saves. */
    update(fn) { const out = fn(state); save(); return out; },
    putEmail(email) { writeFileSync(emailFile(email.id), JSON.stringify(email), { mode: 0o600 }); },
    getEmail(id) { try { return JSON.parse(readFileSync(emailFile(id), 'utf8')); } catch { return null; } },
    clearEmails() {
      for (const name of readdirSync(path.join(dir, 'emails'))) if (name.endsWith('.json')) unlinkSync(path.join(dir, 'emails', name));
      state.emails = []; save();
    },
    /** Forget everything (test physicians, Stripe objects, email). The database is not touched. */
    reset() { this.clearEmails(); state = emptyState(); deliveryAudit.reset(); save(); },
  };
}
