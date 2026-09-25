// Runs supabase/functions/email-inbound/index.ts under node with every
// network edge replaced: the Svix check, the Supabase client (an in-memory
// database), the Resend API and Gemini. Nothing leaves the machine.
//
// The edge function imports three https modules; a resolve hook points them at
// the stubs below. Node strips the TypeScript. Deno.serve hands the handler to
// the harness, which calls it with a signed-looking webhook body.
//
// Used by scripts/email-inbound-intake.test.mjs. Import this module once per
// process: the function reads its environment at load time.
import { registerHooks } from "node:module";

const STUBS = {
  "https://esm.sh/svix@1.40.0": `export class Webhook { constructor() {} verify(raw) { return JSON.parse(raw); } }`,
  "https://esm.sh/@supabase/supabase-js@2.97.0": `export function createClient() { return globalThis.__inboundHarness.db; }`,
  "https://deno.land/std@0.224.0/encoding/base64.ts": `export function encodeBase64(b) { return Buffer.from(b).toString("base64"); }`,
};

registerHooks({
  resolve(specifier, context, next) {
    if (STUBS[specifier]) return { url: `data:text/javascript,${encodeURIComponent(STUBS[specifier])}`, shortCircuit: true };
    return next(specifier, context);
  },
});

// --- In-memory database with the query-builder surface index.ts uses --------
export function createDb() {
  const tables = new Map();
  const files = new Map();
  const rows = (t) => { if (!tables.has(t)) tables.set(t, []); return tables.get(t); };
  const log = [];

  class Query {
    constructor(table) { this.table = table; this.filters = []; this.op = "select"; this.payload = null; this.opts = {}; this.mode = null; this.returning = false; }
    select(_cols, opts = {}) { if (this.op === "select") this.opts = opts; else this.returning = true; return this; }
    insert(p) { this.op = "insert"; this.payload = p; return this; }
    update(p) { this.op = "update"; this.payload = p; return this; }
    delete() { this.op = "delete"; return this; }
    upsert(p) { this.op = "insert"; this.payload = p; return this; }
    eq(c, v) { this.filters.push((r) => r[c] === v); return this; }
    neq(c, v) { this.filters.push((r) => r[c] !== v); return this; }
    in(c, vs) { this.filters.push((r) => vs.includes(r[c])); return this; }
    is(c, v) { this.filters.push((r) => (v === null ? r[c] == null : r[c] === v)); return this; }
    not(c, op, v) { this.filters.push((r) => (op === "is" && v === null ? r[c] != null : r[c] !== v)); return this; }
    gte(c, v) { this.filters.push((r) => String(r[c] ?? "") >= String(v)); return this; }
    ilike(c, pat) {
      const re = new RegExp(`^${String(pat).replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*").replace(/_/g, ".")}$`, "i");
      this.filters.push((r) => re.test(String(r[c] ?? "")));
      return this;
    }
    order() { return this; }
    limit() { return this; }
    maybeSingle() { this.mode = "maybe"; return this; }
    single() { this.mode = "one"; return this; }
    match(r) { return this.filters.every((f) => f(r)); }
    run() {
      const t = rows(this.table);
      log.push({ table: this.table, op: this.op, payload: this.payload });
      if (this.op === "insert") {
        const list = (Array.isArray(this.payload) ? this.payload : [this.payload]).map((r) => ({ id: r.id ?? crypto.randomUUID(), created_at: new Date().toISOString(), ...r }));
        const hook = globalThis.__inboundHarness.failInsert?.(this.table, list);
        if (hook) return { data: null, error: { message: hook, code: "XX000" } };
        if (this.table === "inbound_emails" && list.some((r) => t.some((x) => x.message_id === r.message_id))) {
          return { data: null, error: { message: "duplicate", code: "23505" } };
        }
        t.push(...list);
        const data = this.mode ? list[0] : list;
        return { data, error: null };
      }
      const hit = t.filter((r) => this.match(r));
      if (this.op === "update") {
        for (const r of hit) Object.assign(r, this.payload);
        return { data: this.mode ? hit[0] ?? null : hit, error: null };
      }
      if (this.op === "delete") {
        for (const r of hit) t.splice(t.indexOf(r), 1);
        return { data: hit, error: null };
      }
      if (this.opts.head) return { data: null, count: hit.length, error: null };
      if (this.mode === "one") return hit.length === 1 ? { data: hit[0], error: null } : { data: null, error: { message: "not one row" } };
      if (this.mode === "maybe") return { data: hit[0] ?? null, error: null };
      return { data: hit.map((r) => ({ ...r })), error: null, count: hit.length };
    }
    then(res, rej) { try { res(this.run()); } catch (e) { rej(e); } }
  }

  return {
    tables, files, log, rows,
    reset() { tables.clear(); files.clear(); log.length = 0; },
    from: (t) => new Query(t),
    rpc: async (name) => {
      if (name === "credentialdo_service_write_snapshot") return { data: { enforcementEnabled: true, ...harness.access }, error: null };
      return { data: null, error: { message: `no rpc ${name}` } };
    },
    storage: {
      from: () => ({
        upload: async (path, bytes) => { files.set(path, new Uint8Array(bytes)); return { data: { path }, error: null }; },
        download: async (path) => (files.has(path) ? { data: new Blob([files.get(path)]), error: null } : { data: null, error: { message: "missing" } }),
        remove: async (paths) => {
          const fail = globalThis.__inboundHarness.failRemove?.(paths);
          if (fail) return { data: null, error: { message: fail } };
          for (const p of paths) files.delete(p);
          return { data: null, error: null };
        },
      }),
    },
  };
}

// --- The world outside: Resend and Gemini ---------------------------------
export const RESEND = "https://resend.test";
export const harness = {
  db: null,
  emails: new Map(),        // email id -> { email, attachments: [{meta, bytes}] }
  sent: [],                 // payloads POSTed to /emails
  gemini: [],               // request bodies sent to Gemini
  geminiReply: () => null,  // (body) => scan object, or { status, text }
  failInsert: null,
  failRemove: null,         // (paths) => an error message to fail a Storage removal with
  // The raw message's top-most Authentication-Results. The default is a
  // DMARC pass for the physician's domain; a forward that merely fails to
  // fail is "mx.resend.com; spf=pass smtp.mailfrom=attacker.example; dkim=none; dmarc=none".
  rawAuth: "mx.resend.com; dmarc=pass header.from=elryx.com",
  access: { credential: true, practice: true },   // what the membership snapshot answers
};
globalThis.__inboundHarness = harness;

const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = String(input instanceof Request ? input.url : input);
  const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
  if (url.startsWith(`${RESEND}/emails/receiving/`)) {
    const m = url.slice(`${RESEND}/emails/receiving/`.length).split("?")[0].split("/");
    const e = harness.emails.get(decodeURIComponent(m[0]));
    if (!e) return json({ error: "not found" }, 404);
    if (m[1] === "attachments") return json({ data: e.attachments.map((a) => ({ ...a.meta, size: a.bytes.byteLength, download_url: `https://files.test/${e.email.id}/${a.meta.id}` })) });
    return json(e.email);
  }
  if (url.startsWith("https://files.test/")) {
    const [, eid, aid] = url.slice("https://files.test".length).split("/");
    const a = harness.emails.get(eid)?.attachments.find((x) => x.meta.id === aid);
    return a ? new Response(a.bytes) : new Response("gone", { status: 404 });
  }
  if (url.startsWith("https://raw.test/")) {
    return new Response(`Authentication-Results: ${harness.rawAuth}\r\n\r\nbody`);
  }
  if (url === `${RESEND}/emails`) {
    harness.sent.push(JSON.parse(init.body));
    return json({ id: `sent-${harness.sent.length}` });
  }
  if (url.startsWith("https://generativelanguage.googleapis.com/")) {
    const body = JSON.parse(init.body);
    harness.gemini.push({ url, body });
    const r = harness.geminiReply(body);
    if (r && r.status) return new Response(r.text ?? "{}", { status: r.status, headers: { "content-type": "application/json" } });
    return json({
      candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify(r) }] } }],
      usageMetadata: { promptTokenCount: 1200, candidatesTokenCount: 150, thoughtsTokenCount: 40 },
      modelVersion: "gemini-3.8-flash",
    });
  }
  return realFetch(input, init);
};

const env = {
  RESEND_API_KEY: "re_test",
  RESEND_API_BASE: RESEND,
  RESEND_WEBHOOK_SECRET: "whsec_test",
  SUPABASE_URL: "https://db.test",
  SUPABASE_SERVICE_ROLE_KEY: "service",
};
let handler = null;
globalThis.Deno = { env: { get: (k) => env[k] }, serve: (h) => { handler = h; } };

/** Empty every table, file and recorded call; the loaded function keeps its client. */
export function resetWorld() {
  harness.db.reset();
  harness.emails.clear();
  harness.sent.length = 0;
  harness.gemini.length = 0;
  harness.geminiReply = () => null;
  harness.failInsert = null;
  harness.failRemove = null;
  harness.rawAuth = "mx.resend.com; dmarc=pass header.from=elryx.com";
  harness.access = { credential: true, practice: true };
}

export async function loadFunction() {
  harness.db = createDb();
  await import("../supabase/functions/email-inbound/index.ts");
  if (!handler) throw new Error("Deno.serve was not called");
  return handler;
}

/** Deliver one email.received event for `email` (with attachments) and return the handler's JSON. */
export async function deliver({ id, from, to, subject, text, attachments = [], messageId }) {
  harness.emails.set(id, {
    email: { id, from, to: [to], subject, text, headers: {}, created_at: "2026-09-25T16:10:00Z", raw: { download_url: `https://raw.test/${id}` } },
    attachments: attachments.map((a, i) => ({ meta: { id: `att-${i}`, filename: a.filename, content_type: a.contentType, content_disposition: "attachment" }, bytes: a.bytes })),
  });
  const event = {
    type: "email.received",
    data: { email_id: id, from, to: [to], subject, message_id: messageId || `<${id}@mail.test>`, attachments: attachments.map((a, i) => ({ id: `att-${i}`, filename: a.filename })) },
  };
  const res = await handler(new Request("https://fn.test/email-inbound", {
    method: "POST",
    headers: { "svix-id": `msg_${id}`, "svix-timestamp": "0", "svix-signature": "v1,test" },
    body: JSON.stringify(event),
  }));
  return { status: res.status, body: await res.json() };
}
