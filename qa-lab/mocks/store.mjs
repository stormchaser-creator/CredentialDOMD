// The mock server's saved state: test physicians and sessions (mock Clerk),
// Stripe objects, AI usage, operator alerts and the email index. Written
// atomically to .generated/mocks/state.json after every change, so a lab
// restart keeps its test physicians (their profiles live on in the database).
// Email bodies are stored one file each under .generated/mocks/emails/.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, readdirSync, unlinkSync } from 'node:fs';
import path from 'node:path';

export function emptyState() {
  return {
    version: 1,
    clerk: { users: {}, sessions: {}, webhooks: [] },
    stripe: { customers: {}, products: {}, prices: {}, sessions: {}, subscriptions: {}, invoices: {}, invoiceItems: {}, portalSessions: {}, events: [], idempotency: {}, deliveries: [] },
    emails: [],
    inbound: {},
    telegram: [],
    ai: { usage: {}, calls: [], script: [] },
    beacons: [],
  };
}

export function createStore(dir) {
  mkdirSync(path.join(dir, 'emails'), { recursive: true });
  const file = path.join(dir, 'state.json');
  let state = emptyState();
  if (existsSync(file)) {
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    state = { ...state, ...saved, clerk: { ...state.clerk, ...saved.clerk }, stripe: { ...state.stripe, ...saved.stripe }, ai: { ...state.ai, ...saved.ai } };
  }
  const save = () => {
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 1), { mode: 0o600 });
    renameSync(tmp, file);
  };
  const emailFile = (id) => {
    if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error('bad email id');
    return path.join(dir, 'emails', `${id}.json`);
  };
  return {
    get state() { return state; },
    save,
    /** Runs fn(state) and saves. */
    update(fn) { const out = fn(state); save(); return out; },
    putEmail(email) { writeFileSync(emailFile(email.id), JSON.stringify(email), { mode: 0o600 }); },
    getEmail(id) { try { return JSON.parse(readFileSync(emailFile(id), 'utf8')); } catch { return null; } },
    clearEmails() {
      for (const name of readdirSync(path.join(dir, 'emails'))) if (name.endsWith('.json')) unlinkSync(path.join(dir, 'emails', name));
      state.emails = []; save();
    },
    /** Forget everything (test physicians, Stripe objects, email). The database is not touched. */
    reset() { this.clearEmails(); state = emptyState(); save(); },
  };
}
