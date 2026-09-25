import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { fakeWorld, expenseInvoice, workInvoice, contract, settings, IDS, SUBJECT } from "./fakeWorld.mjs";

// The Send by email screen as the physician drives it: the real Invoices tab
// and InvoiceEmailModal, the real jsPDF invoice, and the real
// send-invoice-email handler answering through the Supabase client's
// functions.invoke (fakeWorld.mjs). Hooks run synchronously, as in
// tests/send-notices.test.mjs. Nothing leaves the process.

const require = createRequire(import.meta.url);
// Load the PDF library before any test stubs `window`: its node build
// switches to browser code paths when it sees one.
require("jspdf");
const autoTable = require("jspdf-autotable");
const externals = { "jspdf-autotable": Object.assign((...args) => autoTable.default(...args), autoTable) };
const root = fileURLToPath(new URL("../..", import.meta.url));
const built = await build({
  stdin: {
    contents: [
      'export {default as Invoices} from "./src/components/features/locum/Invoices.jsx";',
      'export {default as InvoiceEmailModal} from "./src/components/features/locum/InvoiceEmailModal.jsx";',
    ].join("\n"),
    resolveDir: root, loader: "jsx",
  },
  bundle: true, define: { "import.meta.env": "{}" }, platform: "node", format: "cjs", write: false, jsx: "automatic",
  external: ["react", "react/jsx-runtime", "react-dom", "jspdf", "jspdf-autotable", "xlsx", "docx"], logLevel: "silent",
  plugins: [{ name: "synthetic-account", setup(b) {
    b.onResolve({ filter: /context\/AppContext$/ }, () => ({ path: "context", namespace: "fixture" }));
    b.onResolve({ filter: /lib\/supabase$/ }, () => ({ path: "database", namespace: "fixture" }));
    b.onLoad({ filter: /.*/, namespace: "fixture" }, ({ path }) => ({
      contents: path === "context"
        ? "export const useApp = () => globalThis.__email.context;"
        : "export const supabase = { functions: { invoke: (n, o) => globalThis.__email.invoke(n, o) } }; export const downloadDocumentBlob = async () => null;",
      loader: "js",
    }));
  } }],
});

function harness(componentName, props) {
  const cells = [];
  let index = 0;
  let effects = [];
  const effect = (fn, deps) => {
    const at = index++;
    const prev = cells[at];
    if (prev && deps && deps.length === prev.deps?.length && deps.every((d, i) => Object.is(d, prev.deps[i]))) return;
    cells[at] = { deps, cleanup: prev?.cleanup };
    effects.push(() => { cells[at].cleanup?.(); cells[at].cleanup = fn() || undefined; });
  };
  const hooks = {
    useState(initial) {
      const at = index++;
      if (!(at in cells)) cells[at] = { v: typeof initial === "function" ? initial() : initial };
      const cell = cells[at];
      return [cell.v, (value) => { cell.v = typeof value === "function" ? value(cell.v) : value; }];
    },
    useRef(value) { const at = index++; return (cells[at] ??= { current: value }); },
    useMemo: (fn) => fn(), useCallback: (fn) => fn, useEffect: effect, useLayoutEffect: effect,
    memo: (component) => component,
  };
  const module = { exports: {} };
  new Function("require", "module", "exports", built.outputFiles[0].text)(
    (name) => (name === "react" ? hooks : externals[name] ?? require(name)), module, module.exports);
  const Component = module.exports[componentName];
  const state = { props };
  state.render = () => {
    index = 0;
    effects = [];
    const tree = Component(state.props);
    for (const run of effects) run();
    return tree;
  };
  return state;
}

const theme = new Proxy({}, { get: () => "#777" });
const find = (tree, predicate) => {
  if (!tree || typeof tree !== "object") return null;
  if (Array.isArray(tree)) { for (const c of tree) { const hit = find(c, predicate); if (hit) return hit; } return null; }
  if (predicate(tree)) return tree;
  return find(tree.props?.children, predicate);
};
const textOf = (n) => (n == null || typeof n === "boolean" ? ""
  : typeof n === "string" || typeof n === "number" ? String(n)
    : Array.isArray(n) ? n.map(textOf).join("") : textOf(n.props?.children));
const button = (tree, label) => find(tree, (n) => n.type === "button" && textOf(n).includes(label));
const flush = async (turns = 30) => { for (let i = 0; i < turns; i++) await new Promise((r) => setImmediate(r)); };
const pdfText = (b64) => [...Buffer.from(b64, "base64").toString("latin1").matchAll(/\((.*)\) Tj/g)].map((m) => m[1]).join("\n");

function context(env, data, extra = {}) {
  const calls = [];
  const ctx = {
    calls, user: { id: SUBJECT }, theme, isDesktop: false,
    limitedLaunch: { enabled: false }, canWritePractice: true,
    data: {
      settings: settings(), documents: [], invoices: [], travelExpenses: [], locumContracts: [contract()], workLog: [], dutyDays: [],
      ...data,
    },
    editItem: (c, item) => { calls.push(["editItem", c, item]); },
    deleteItem: (...a) => calls.push(["deleteItem", ...a]),
    updateSection: (key, updater) => { calls.push(["updateSection", key]); ctx.data = { ...ctx.data, [key]: updater(ctx.data[key]) }; return true; },
    ...extra,
  };
  return ctx;
}

// Browser globals and the Supabase client for one test, restored after.
async function withApp(env, ctx, fn) {
  const saved = { window: globalThis.window, document: globalThis.document, setTimeout: globalThis.setTimeout, email: globalThis.__email };
  const invocations = [];
  globalThis.window = { navigator: {}, matchMedia: () => ({ matches: false }), confirm: () => true };
  globalThis.document = { createElement: () => ({ click() {} }) };
  // Notices clear themselves after 12 s; do not keep the test process alive for them.
  globalThis.setTimeout = () => 0;
  globalThis.__email = {
    context: ctx,
    // supabase.functions.invoke's contract: { data, error } with the Response on error.context.
    invoke: async (name, { body }) => {
      assert.equal(name, "send-invoice-email");
      invocations.push(JSON.parse(JSON.stringify(body)));
      const r = await env.call(JSON.parse(JSON.stringify(body)));
      return r.status === 200 ? { data: r.body, error: null }
        : { data: null, error: { message: "Edge Function returned a non-2xx status code", context: { status: r.status, json: async () => r.body } } };
    },
  };
  try { return await fn(invocations); } finally {
    globalThis.window = saved.window;
    globalThis.document = saved.document;
    globalThis.setTimeout = saved.setTimeout;
    globalThis.__email = saved.email;
  }
}

/** Resend, then Send by email from the chooser: the modal as Invoices opens it. */
async function openFromResend(ctx) {
  const invoices = harness("Invoices", {});
  button(invoices.render(), "Resend").props.onClick({ stopPropagation() {} });
  await flush();
  const chooser = find(invoices.render(), (n) => typeof n.props?.onPick === "function");
  assert.equal(typeof chooser.props.onEmail, "function", "the chooser offers Send by email");
  chooser.props.onEmail();
  const element = find(invoices.render(), (n) => n.props && "invoice" in n.props && typeof n.props.onSent === "function");
  assert.equal(element.props.open, true);
  assert.equal(element.props.invoice.id, ctx.data.invoices[0].id);
  const modal = harness("InvoiceEmailModal", element.props);
  modal.render();
  await flush();
  return { invoices, modal };
}

test("Send by email: what the screen shows is what the billing office gets, line breaks and all", async () => {
  const env = fakeWorld();
  const ctx = context(env, { invoices: [workInvoice()], locumContracts: [contract("billing@hospital.example")] });
  await withApp(env, ctx, async (invocations) => {
    const { invoices, modal } = await openFromResend(ctx);
    const tree = modal.render();
    const shown = textOf(find(tree, (n) => n.props && "data-invoice-email-body" in n.props));
    assert.match(shown, /^Hello,\n\nAttached is invoice INV-20260920-01/);
    const to = find(tree, (n) => n.type === "input" && n.props.type === "email");
    assert.equal(to.props.value, "billing@hospital.example", "the agreement's invoice email is filled in");
    assert.equal(invocations.length, 1, "only the check so far; nothing is sent before the tap");
    assert.equal(env.world.keys.length, 0);
    const preview = textOf(tree);
    assert.match(preview, /From: Synthetic Physician, DO via CredentialDOMD <docs@credentialdomd\.com>/);
    assert.match(preview, /Copy to you: doc\.verified@example\.test/);
    assert.match(preview, /Replies go to: doc\.verified@example\.test/);
    assert.match(preview, /Subject: Invoice INV-20260920-01 from Synthetic Physician, DO for Synthetic Hospital/);
    assert.match(preview, /INV-20260920-01\.pdf/);

    await button(tree, "Send to billing@hospital.example").props.onClick();
    await flush();
    assert.equal(env.world.mails.length, 1);
    const mail = env.world.mails[0];
    assert.equal(mail.text, shown, "the body that went is the body that was shown");
    assert.deepEqual(mail.to, ["billing@hospital.example"]);
    assert.deepEqual(mail.cc, ["doc.verified@example.test"]);
    assert.deepEqual(mail.reply_to, ["doc.verified@example.test"]);
    const pdf = pdfText(mail.attachments[0].content);
    assert.match(pdf, /INVOICE/);
    assert.match(pdf, /\$12,500\.50/, "the real invoice PDF, same total");

    // The screen records the send without an edit, and says where it went.
    assert.ok(ctx.calls.some(([k, key]) => k === "updateSection" && key === "invoices"));
    assert.ok(!ctx.calls.some(([k, c]) => k === "editItem" && c === "invoices"), "no full-row edit of the invoice");
    const stamped = ctx.data.invoices[0];
    assert.equal(stamped.lastEmailedTo, "billing@hospital.example");
    assert.equal(stamped.lastEmailedAt, env.world.invoices[1].last_emailed_at);
    const { lastEmailedAt, lastEmailedTo, ...rest } = stamped;
    assert.ok(lastEmailedAt && lastEmailedTo);
    assert.deepEqual(rest, workInvoice(), "nothing else about the invoice changed");
    const after = textOf(invoices.render());
    assert.match(after, /Invoice INV-20260920-01 was emailed to billing@hospital\.example\. A copy went to doc\.verified@example\.test\./);
    assert.match(after, /Emailed Sep 25, 2026 to billing@hospital\.example/);
  });
});

test("Send by email: a missing receipt is named before the tap and nothing claims it", async () => {
  const env = fakeWorld();
  env.world.storage.delete(`${SUBJECT}/${IDS.docHotel}`);
  const ctx = context(env, { invoices: [expenseInvoice()], locumContracts: [contract("")] });
  await withApp(env, ctx, async () => {
    const { modal } = await openFromResend(ctx);
    let tree = modal.render();
    const alert = textOf(find(tree, (n) => n.props?.role === "alert"));
    assert.match(alert, /1 receipt could not be attached \(hotel\.jpg\)/);
    assert.match(alert, /It is not in this email: the letter does not count it and the invoice lists it as on file\./);
    assert.equal(button(tree, "Send").props.disabled, true, "nothing to pre-fill: never emailed, no agency history");
    // An expense invoice has no agreement (contractId null), so there is none
    // to save the address on; the server remembers it from the send instead.
    find(tree, (n) => n.type === "input" && n.props.type === "email").props.onChange({ target: { value: "AP@Agency.Example" } });
    tree = modal.render();
    assert.equal(find(tree, (n) => n.type === "input" && n.props.type === "checkbox"), null);
    const shown = textOf(find(tree, (n) => n.props && "data-invoice-email-body" in n.props));
    assert.match(shown, /The receipt is attached\./);
    await button(tree, "Send to ap@agency.example").props.onClick();
    await flush();
    const mail = env.world.mails[0];
    assert.equal(mail.text, shown);
    assert.deepEqual(mail.attachments.map((a) => a.filename), ["EXP-0007.pdf", "airfare.pdf"]);
    const pdf = pdfText(mail.attachments[0].content);
    assert.match(pdf, /receipt attached/, "the airfare line: its receipt rode");
    assert.match(pdf, /receipt on file/, "the hotel line: its receipt did not");
    assert.match(pdf, /BALANCE DUE/);
    assert.match(pdf, /\$600\.00/, "the partial payment is still shown");
    assert.ok(!ctx.calls.some(([k, c]) => k === "editItem" && c === "locumContracts"), "no agreement is touched");
  });
});

/** The second expense invoice for the same agency, spelled the way another contract spells it. */
const secondExpenseInvoice = () => ({
  ...expenseInvoice(), id: IDS.secondExpenseInvoice, number: "EXP-0008", billToLabel: "Synthetic Locums, LLC.",
  entryIds: [], lines: [{ date: "2026-09-01", label: "Mileage", detail: "", amount: 50 }], totalAmount: 50, payments: [],
});
const openModal = async (props) => {
  const modal = harness("InvoiceEmailModal", { open: true, contract: undefined, billName: "", onClose() {}, onSent() {}, ...props });
  modal.render();
  await flush();
  return modal;
};
const toField = (tree) => find(tree, (n) => n.type === "input" && n.props.type === "email");

test("Send by email: an agency's billing address is typed once; its next expense invoice opens with it", async () => {
  const env = fakeWorld();
  env.world.invoices.push({ id: IDS.secondExpenseInvoice, user_id: IDS.profile, number: "EXP-0008", kind: "expenses", entry_ids: [],
    contract_id: null, bill_to_label: "Synthetic Locums, LLC.", total_amount: 50, updated_at: "2026-09-10T00:00:00.000Z", last_emailed_at: null, last_emailed_to: null });
  const ctx = context(env, { invoices: [expenseInvoice(), secondExpenseInvoice()], locumContracts: [contract("")] });
  await withApp(env, ctx, async () => {
    const first = await openModal({ invoice: expenseInvoice(), billName: "Synthetic Locums" });
    toField(first.render()).props.onChange({ target: { value: "ap@agency.example" } });
    await button(first.render(), "Send to ap@agency.example").props.onClick();
    await flush();
    assert.equal(env.world.mails.length, 1);

    // Production: every expense invoice has contractId null, so this used to
    // open blank and the physician retyped the agency's address every time.
    const second = await openModal({ invoice: secondExpenseInvoice(), billName: "Synthetic Locums, LLC." });
    const tree = second.render();
    assert.equal(toField(tree).props.value, "ap@agency.example", "pre-filled from the same agency's last send, spelling aside");
    assert.equal(button(tree, "Send to ap@agency.example").props.disabled, false);
  });
});

test("Send by email: the address is pre-filled from the server's record, not this device's stale copy", async () => {
  const env = fakeWorld();
  // The phone corrected the address and sent to the right office...
  env.world.invoices[0].last_emailed_at = "2026-09-24T10:00:00.000Z";
  env.world.invoices[0].last_emailed_to = "right@agency.example";
  // ...while this desktop tab still holds the earlier, wrong one.
  const stale = { ...expenseInvoice(), lastEmailedAt: "2026-09-20T10:00:00.000Z", lastEmailedTo: "wrong@agency.example" };
  const ctx = context(env, { invoices: [stale], locumContracts: [contract("")] });
  await withApp(env, ctx, async () => {
    const modal = await openModal({ invoice: stale, billName: "Synthetic Locums" });
    const tree = modal.render();
    assert.equal(toField(tree).props.value, "right@agency.example");
    assert.match(textOf(tree), /Last emailed Sep 24, 2026 at .* to right@agency\.example\./);
    assert.doesNotMatch(textOf(tree), /wrong@agency\.example/);
    // A typed address is never replaced by a later check (a recheck after a refusal).
    toField(tree).props.onChange({ target: { value: "other@agency.example" } });
    env.world.storage.delete(`${SUBJECT}/${IDS.docHotel}`);
    await button(modal.render(), "Send to other@agency.example").props.onClick();
    await flush();
    assert.equal(toField(modal.render()).props.value, "other@agency.example");
  });
});

test("Send by email: a receipt only this device holds is named before Send, and its line says on file", async () => {
  const env = fakeWorld();
  const local = "aaaaaaaa-0000-4000-8000-0000000000f1";
  // A parking receipt whose upload is still queued: on the device with its
  // bytes, no cloud row. And the hotel expense's link to this invoice has not
  // synced either, so the server finds no receipts for it.
  env.world.expenses[1].invoice_id = null;
  const ctx = context(env, {
    invoices: [expenseInvoice()], locumContracts: [contract("")],
    travelExpenses: [{ id: IDS.expAir, invoiceId: IDS.invoice }, { id: IDS.expHotel, invoiceId: IDS.invoice }],
    documents: [
      { id: IDS.docAir, name: "airfare.pdf", linkedTo: `travelExpenses:${IDS.expAir}`, storagePath: `${SUBJECT}/${IDS.docAir}` },
      { id: local, name: "parking.jpg", linkedTo: `travelExpenses:${IDS.expAir}`, data: "data:image/jpeg;base64,/9j/4AAQ" },
      { id: IDS.docHotel, name: "hotel.jpg", linkedTo: `travelExpenses:${IDS.expHotel}`, storagePath: `${SUBJECT}/${IDS.docHotel}` },
    ],
  });
  await withApp(env, ctx, async () => {
    const modal = await openModal({ invoice: expenseInvoice(), billName: "Synthetic Locums" });
    toField(modal.render()).props.onChange({ target: { value: "ap@agency.example" } });
    const tree = modal.render();
    const alert = textOf(find(tree, (n) => n.props?.role === "alert"));
    assert.match(alert, /2 receipts could not be attached \(parking\.jpg, hotel\.jpg\) because this device has not finished saving them to your account\./);
    const shown = textOf(find(tree, (n) => n.props && "data-invoice-email-body" in n.props));
    assert.match(shown, /The receipt is attached\./, "the letter counts the one that rides");
    await button(tree, "Send to ap@agency.example").props.onClick();
    await flush();
    const mail = env.world.mails[0];
    assert.deepEqual(mail.attachments.map((a) => a.filename), ["EXP-0007.pdf", "airfare.pdf"]);
    const pdf = pdfText(mail.attachments[0].content);
    assert.doesNotMatch(pdf, /receipt attached/, "airfare's parking receipt did not ride, so its line may not say attached");
    assert.match(pdf, /receipt on file/);
  });
});

test("Send by email: your own address is never offered or saved as the agreement's invoice email", async () => {
  for (const own of ["doc.verified@example.test", "Doc@Example.test"]) {
    const env = fakeWorld();
    const ctx = context(env, { invoices: [workInvoice()], locumContracts: [contract("")] });
    await withApp(env, ctx, async () => {
      const modal = await openModal({ invoice: workInvoice(), contract: contract(""), billName: "Synthetic Hospital", onSent: (r) => ctx.calls.push(["sent", r]) });
      toField(modal.render()).props.onChange({ target: { value: own } });
      const tree = modal.render();
      assert.equal(find(tree, (n) => n.type === "input" && n.props.type === "checkbox"), null, `${own}: a test send to yourself offers no save`);
      await button(tree, "Send to").props.onClick();
      await flush();
      assert.equal(env.world.mails.length, 1);
      assert.equal(ctx.calls.find(([k]) => k === "sent")[1].saveBillTo, null, `${own}: nothing to save`);
    });
  }
  // The billing office's address is still offered, ticked.
  const env = fakeWorld();
  const ctx = context(env, { invoices: [workInvoice()], locumContracts: [contract("")] });
  await withApp(env, ctx, async () => {
    const modal = await openModal({ invoice: workInvoice(), contract: contract(""), billName: "Synthetic Hospital", onSent: (r) => ctx.calls.push(["sent", r]) });
    toField(modal.render()).props.onChange({ target: { value: "billing@hospital.example" } });
    const tree = modal.render();
    assert.equal(find(tree, (n) => n.type === "input" && n.props.type === "checkbox").props.checked, true);
    await button(tree, "Send to").props.onClick();
    await flush();
    assert.equal(ctx.calls.find(([k]) => k === "sent")[1].saveBillTo, "billing@hospital.example");
  });
});

test("Send by email: reopening after an unconfirmed send shows it and sends again only when the physician says so", async () => {
  const env = fakeWorld({ mailOutcome: () => ({ state: "unknown" }) });
  const ctx = context(env, { invoices: [workInvoice()], locumContracts: [contract("billing@hospital.example")] });
  await withApp(env, ctx, async (invocations) => {
    const first = await openModal({ invoice: workInvoice(), contract: contract("billing@hospital.example") });
    await button(first.render(), "Send to").props.onClick();
    await flush();
    assert.match(textOf(first.render()), /could not be confirmed/);
    assert.equal(env.world.mails.length, 1, "it may well have gone");

    // Close, open again: a new request id.
    env.world.mailOutcome = () => ({ state: "sent", providerId: "re_2" });
    const again = await openModal({ invoice: workInvoice(), contract: contract("billing@hospital.example") });
    let tree = again.render();
    const warning = textOf(find(tree, (n) => n.props && "data-invoice-email-attempt" in n.props));
    assert.match(warning, /A send of this invoice to billing@hospital\.example on Sep 25, 2026 at .* could not be confirmed, so it may already have arrived\. Check your copy at doc\.verified@example\.test before sending it again\./);
    assert.equal(button(tree, "Send to").props.disabled, true, "not until the physician confirms");
    await button(tree, "Send to").props.onClick();
    await flush();
    assert.equal(env.world.mails.length, 1);

    find(tree, (n) => n.type === "input" && "data-confirm-resend" in n.props).props.onChange({ target: { checked: true } });
    tree = again.render();
    assert.equal(button(tree, "Send to").props.disabled, false);
    await button(tree, "Send to").props.onClick();
    await flush();
    assert.equal(env.world.mails.length, 2);
    const sends = invocations.filter((b) => b.action === "send");
    assert.notEqual(sends[0].requestId, sends[1].requestId);
    assert.equal(sends[0].confirmResend, undefined);
    assert.equal(sends[1].confirmResend, true);
  });
});

test("Send by email: a retried Send after a lost answer is not mailed twice", async () => {
  const env = fakeWorld();
  const ctx = context(env, { invoices: [workInvoice()], locumContracts: [contract("billing@hospital.example")] });
  await withApp(env, ctx, async (invocations) => {
    const { invoices, modal } = await openFromResend(ctx);
    // The first answer is lost on the way back after the server sent it.
    const real = globalThis.__email.invoke;
    globalThis.__email.invoke = async (name, opts) => {
      if (opts.body.action === "send" && !globalThis.__email.lost) { globalThis.__email.lost = true; await real(name, opts); return { data: null, error: { message: "Failed to fetch" } }; }
      return real(name, opts);
    };
    await button(modal.render(), "Send to").props.onClick();
    await flush();
    let tree = modal.render();
    assert.match(textOf(tree), /Failed to fetch|connection|Try again/i);
    assert.equal(env.world.mails.length, 1, "it did go");
    await button(tree, "Send to").props.onClick();
    await flush();
    assert.equal(env.world.mails.length, 1, "the retry was answered from the ledger");
    const sends = invocations.filter((b) => b.action === "send");
    assert.equal(sends.length, 2);
    assert.equal(sends[0].requestId, sends[1].requestId, "the same request id on the retry");
    assert.match(textOf(invoices.render()), /Invoice INV-20260920-01 was already emailed to billing@hospital\.example on Sep 25, 2026 at .*, so it was not sent again\./);
  });
});

test("Send by email: a Credential-only account is not offered it, and the screen never calls the server", async () => {
  const env = fakeWorld({ access: { practice: false } });
  const ctx = context(env, { invoices: [workInvoice()] }, { limitedLaunch: { enabled: true }, canWritePractice: false });
  await withApp(env, ctx, async (invocations) => {
    const invoices = harness("Invoices", {});
    button(invoices.render(), "Resend").props.onClick({ stopPropagation() {} });
    await flush();
    const chooser = find(invoices.render(), (n) => typeof n.props?.onPick === "function");
    assert.equal(chooser.props.onEmail, undefined, "no Send by email option");
    const modal = harness("InvoiceEmailModal", { open: true, invoice: workInvoice(), contract: contract("billing@hospital.example"), billName: "", onClose() {}, onSent() {} });
    modal.render();
    await flush();
    const tree = modal.render();
    assert.match(textOf(tree), /Sending invoices needs Practice access/);
    assert.equal(button(tree, "Send").props.disabled, true);
    assert.equal(invocations.length, 0);
    // And the server refuses it regardless.
    const res = await env.call({ action: "check", invoiceId: IDS.workInvoice, pdfBytes: 10 });
    assert.equal(res.status, 403);
  });
});
