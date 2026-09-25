// One synthetic account behind the real send-invoice-email handler: an
// in-memory database (profile, invoice, expenses, receipt documents, the
// sent-once ledger), in-memory Storage and a fake Resend that records every
// message instead of sending it. Not a test file itself; the handler and the
// modal tests share it. Nothing leaves the process.
import { createInvoiceEmailHandler } from "../../supabase/functions/_shared/invoiceEmailHandler.mjs";

export const IDS = Object.freeze({
  profile: "aaaaaaaa-0000-4000-8000-000000000001",
  invoice: "aaaaaaaa-0000-4000-8000-000000000002",
  expAir: "aaaaaaaa-0000-4000-8000-000000000003",
  expHotel: "aaaaaaaa-0000-4000-8000-000000000004",
  docAir: "aaaaaaaa-0000-4000-8000-000000000005",
  docHotel: "aaaaaaaa-0000-4000-8000-000000000006",
  contract: "aaaaaaaa-0000-4000-8000-000000000007",
  workInvoice: "aaaaaaaa-0000-4000-8000-000000000008",
  otherProfile: "aaaaaaaa-0000-4000-8000-000000000009",
  secondExpenseInvoice: "aaaaaaaa-0000-4000-8000-00000000000a",
});
export const SUBJECT = "user_synthetic";
const DOT = String.fromCodePoint(0xb7);
const tick = () => new Promise((r) => setImmediate(r));
const pdfBytes = (label) => new TextEncoder().encode(`%PDF-1.4\n% synthetic ${label}\n`);

/**
 * The client's copy of the expense invoice (camelCase, as the app holds it).
 * No contract: Expenses.jsx creates every expense invoice with contractId
 * null and names the agency in billToLabel, and all of production's do.
 */
export const expenseInvoice = () => ({
  id: IDS.invoice, number: "EXP-0007", kind: "expenses", contractId: null, billToLabel: "Synthetic Locums",
  periodStart: "2026-08-01", periodEnd: "2026-08-02", entryIds: [IDS.expAir, IDS.expHotel],
  totalAmount: 700, totalMinutes: 0, sentAt: "2026-08-05T12:00:00Z", terms: "Reimbursable travel expenses per agreement.",
  payments: [{ amount: 100, date: "2026-08-20", note: "partial" }],
  lines: [
    { date: "2026-08-01", label: "Airfare: Example Air", detail: `aisle seat ${DOT} receipt on file`, amount: 400, expenseId: IDS.expAir },
    { date: "2026-08-02", label: "Lodging: Example Inn", detail: "receipt on file", amount: 300, expenseId: IDS.expHotel },
  ],
});

/** A work (physician services) invoice: no receipts. */
export const workInvoice = () => ({
  id: IDS.workInvoice, number: "INV-20260920-01", contractId: IDS.contract,
  periodStart: "2026-09-14", periodEnd: "2026-09-20", entryIds: [], totalAmount: 12500.5, totalMinutes: 600,
  sentAt: "2026-09-21T12:00:00Z", terms: "$3,000.00 per on-call day covering the first 4 hours of logged work",
  lines: [
    { date: "2026-09-14", label: "Call coverage day", detail: "stipend", amount: 3000 },
    { date: "2026-09-15", label: "Call", detail: "10:00 PM to 1:00 AM = 3h", amount: 9500.5 },
  ],
});

export const contract = (billTo = "") => ({ id: IDS.contract, facility: "Synthetic Hospital", agency: "Synthetic Locums", location: "Denver, CO", billTo });
export const settings = () => ({ name: "Synthetic Physician", degreeType: "DO", npi: "9999999999", email: "doc@example.test" });

export function fakeWorld(opts = {}) {
  const world = {
    profile: {
      id: IDS.profile, name: "Synthetic Physician", degree_type: "DO", email: "doc@example.test",
      verified_email: "doc.verified@example.test", auth_user_id: SUBJECT, ...(opts.profile || {}),
    },
    invoices: [
      { id: IDS.invoice, user_id: IDS.profile, number: "EXP-0007", kind: "expenses", entry_ids: [IDS.expAir, IDS.expHotel],
        contract_id: null, bill_to_label: "Synthetic Locums", total_amount: 700, terms: "Reimbursable travel expenses per agreement.",
        updated_at: "2026-09-01T00:00:00.000Z", last_emailed_at: null, last_emailed_to: null },
      { id: IDS.workInvoice, user_id: IDS.profile, number: "INV-20260920-01", kind: null, entry_ids: [],
        contract_id: IDS.contract, bill_to_label: null, total_amount: 12500.5, updated_at: "2026-09-21T00:00:00.000Z", last_emailed_at: null, last_emailed_to: null },
    ],
    expenses: [
      { id: IDS.expAir, user_id: IDS.profile, invoice_id: IDS.invoice },
      { id: IDS.expHotel, user_id: IDS.profile, invoice_id: IDS.invoice },
    ],
    documents: [
      { id: IDS.docAir, user_id: IDS.profile, name: "airfare.pdf", mime_type: "application/pdf", type: "application/pdf",
        storage_path: `${SUBJECT}/${IDS.docAir}`, size_bytes: 20, linked_to: `travelExpenses:${IDS.expAir}` },
      { id: IDS.docHotel, user_id: IDS.profile, name: "hotel.jpg", mime_type: "image/jpeg", type: "image/jpeg",
        storage_path: `${SUBJECT}/${IDS.docHotel}`, size_bytes: 20, linked_to: `travelExpenses:${IDS.expHotel}` },
    ],
    storage: new Map([
      [`${SUBJECT}/${IDS.docAir}`, pdfBytes("airfare")],
      [`${SUBJECT}/${IDS.docHotel}`, new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4])],
    ]),
    ledger: [],
    mails: [],
    keys: [],
    reservations: 0,
    reserveResult: null,          // override reserve_send's answer
    access: { enforcementEnabled: true, credential: true, practice: true, ...(opts.access || {}) },
    mailOutcome: opts.mailOutcome || (() => ({ state: "sent", providerId: `re_${Math.random().toString(36).slice(2, 8)}` })),
    reads: [],                    // which store methods ran, in order
    now: Date.parse("2026-09-25T15:00:00.000Z"),
  };
  let seq = 0;
  const note = (name) => world.reads.push(name);
  const at = () => new Date(world.now).toISOString();
  const deps = {
    configured: () => true,
    now: () => world.now,
    log: () => {},
    authenticate: async () => (opts.signedOut ? null : { profileId: IDS.profile, clerkSubject: SUBJECT }),
    accessDb: { rpc: async (name, args) => {
      note("access");
      assert(name === "credentialdo_service_write_snapshot" && args.p_profile_id === IDS.profile && args.p_clerk_subject === SUBJECT);
      return { data: world.access, error: null };
    } },
    reserveSend: async (profileId, since) => {
      note("reserve");
      await tick();
      if (world.reserveResult) return world.reserveResult;
      assert(profileId === IDS.profile && typeof since === "string");
      world.reservations += 1;
      return { data: `res-${world.reservations}`, error: null };
    },
    probeFile: async (path) => { note("probe"); const b = world.storage.get(path); return b ? { size: b.byteLength } : null; },
    readFile: async (path, limit) => { note("read"); await tick(); const b = world.storage.get(path); return b && b.byteLength <= limit ? b : null; },
    sendMail: async (payload, key) => {
      note("mail");
      await tick();
      world.keys.push(key);
      const outcome = world.mailOutcome(payload, key);
      if (outcome.state === "sent") world.mails.push(JSON.parse(JSON.stringify(payload)));
      if (outcome.state === "unknown") world.mails.push(JSON.parse(JSON.stringify(payload))); // it may well have gone
      return outcome;
    },
    store: {
      profile: async (id) => { note("profile"); return id === IDS.profile ? { ...world.profile } : null; },
      invoice: async (profileId, id) => { note("invoice"); const r = world.invoices.find((x) => x.id === id && x.user_id === profileId); return r ? { ...r } : null; },
      expenses: async (profileId, invoiceId) => world.expenses.filter((e) => e.user_id === profileId && e.invoice_id === invoiceId).map((e) => ({ ...e })),
      receiptDocuments: async (profileId, links) => world.documents.filter((d) => d.user_id === profileId && links.includes(d.linked_to)).map((d) => ({ ...d })),
      storageSubjects: async () => [SUBJECT],
      // Newest first by updated_at, later rows first on a tie (the fake clock
      // only moves when a test moves it).
      lastAttempt: async (profileId, invoiceId, exceptRequestId) => {
        const rows = world.ledger.map((r, i) => [r, i])
          .filter(([r]) => r.user_id === profileId && r.invoice_id === invoiceId && ["sent", "unknown", "sending"].includes(r.status)
            && (!exceptRequestId || r.client_request_id !== exceptRequestId))
          .sort(([a, ai], [b, bi]) => String(b.updated_at).localeCompare(String(a.updated_at)) || bi - ai);
        return rows[0] ? { ...rows[0][0] } : null;
      },
      emailedInvoices: async (profileId) => world.invoices.filter((r) => r.user_id === profileId && r.last_emailed_at)
        .map((r) => ({ id: r.id, contract_id: r.contract_id, bill_to_label: r.bill_to_label, last_emailed_at: r.last_emailed_at, last_emailed_to: r.last_emailed_to })),
      lastSend: async (profileId, invoiceId) => {
        const rows = world.ledger.filter((r) => r.user_id === profileId && r.invoice_id === invoiceId && r.status === "sent")
          .sort((a, b) => b.sent_at.localeCompare(a.sent_at));
        return rows[0] ? { sent_at: rows[0].sent_at, recipient: rows[0].recipient } : null;
      },
      findSend: async (profileId, requestId) => { await tick(); const r = world.ledger.find((x) => x.user_id === profileId && x.client_request_id === requestId); return r ? { ...r } : null; },
      insertSend: async (row) => {
        await tick();
        if (world.ledger.some((x) => x.user_id === row.user_id && x.client_request_id === row.client_request_id)) return { conflict: true };
        const full = { id: `ledger-${++seq}`, provider_id: null, sent_at: null, created_at: at(), updated_at: at(), ...row };
        world.ledger.push(full);
        return { ...full };
      },
      reclaimSend: async (existing, fields) => {
        await tick();
        const r = world.ledger.find((x) => x.id === existing.id && x.status === "failed" && x.attempts === existing.attempts);
        if (!r) return null;
        Object.assign(r, fields, { status: "sending", attempts: existing.attempts + 1, provider_id: null, updated_at: at() });
        return { ...r };
      },
      finishSend: async (claim, status, extra = {}) => {
        const r = world.ledger.find((x) => x.id === claim.id && x.attempts === claim.attempts && x.status === "sending");
        if (!r) return;
        r.status = status;
        r.updated_at = at();
        if (extra.providerId !== undefined) r.provider_id = extra.providerId;
        if (extra.sentAt) r.sent_at = extra.sentAt;
      },
      stampInvoice: async (profileId, invoiceId, at, to) => {
        const r = world.invoices.find((x) => x.id === invoiceId && x.user_id === profileId);
        if (r && (!r.last_emailed_at || r.last_emailed_at < at)) { r.last_emailed_at = at; r.last_emailed_to = to; }
      },
    },
  };
  const handler = createInvoiceEmailHandler(deps);
  const call = async (body, { raw, method = "POST" } = {}) => {
    const res = await handler(new Request("https://functions.example.test/send-invoice-email", {
      method, headers: { authorization: "Bearer synthetic", "content-type": "application/json" },
      body: method === "POST" ? (raw ?? JSON.stringify(body)) : undefined,
    }));
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, body: json, headers: res.headers };
  };
  // What src/utils/edgeError.js invokeFn hands the app, with the body crossing
  // JSON the way it does over the network.
  const invoke = async (name, { body }) => {
    assert(name === "send-invoice-email");
    const r = await call(JSON.parse(JSON.stringify(body)));
    return r.status === 200 ? { ok: true, status: 200, data: r.body, message: "" } : { ok: false, status: r.status, data: r.body, message: r.body?.error || "" };
  };
  return { world, deps, handler, call, invoke };
}

function assert(cond) { if (!cond) throw new Error("fake world: unexpected call"); }

/** A stand-in for jsPDF: a real "%PDF-" file whose body records what the PDF would print. */
export const fakePdfFor = (docArgs) => new File(
  [`%PDF-1.4\n${JSON.stringify({ number: docArgs.number, total: docArgs.total, paid: docArgs.paid, balance: docArgs.balance, terms: docArgs.terms, lines: docArgs.lines })}\n`],
  `${docArgs.number || "invoice"}.pdf`, { type: "application/pdf" },
);
