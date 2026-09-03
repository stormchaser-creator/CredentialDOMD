// Desk-width forms and keys (desktop spec, increment 9). Checks the pure
// pieces directly: the keyboard decision and the modal / Add stacks in
// src/utils/deskKeys.js, the two-column pairing in src/utils/formLayout.js
// against a copy of the real Licenses config, and Modal.jsx bundled through
// the project's own esbuild with useApp stubbed so the desk default width
// (720) and the phone default (520) are asserted on the markup.
// Run: node scripts/desk-keys.test.mjs   (pure node, no test runner)
import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  deskKeyAction, isTypingTarget, pushModal, popModal, isTopModal, modalCount,
  registerDeskAdd, topDeskAdd, DESK_KEYS, SEARCH_SELECTOR,
} from "../src/utils/deskKeys.js";
import { isShortField, formRows } from "../src/utils/formLayout.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const modalPath = path.join(here, "..", "src", "components", "shared", "Modal.jsx");
const tmpPath = path.join(here, ".desk-keys.tmp.mjs");

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => { if (cond) pass++; else { fail++; console.log(`FAIL ${name} ${extra}`); } };

// ── deskKeyAction ──
const ev = (key, o = {}) => ({ key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, isComposing: false, target: { tagName: "BODY" }, ...o });
const desk = { isDesktop: true, modalOpen: false, hasAdd: true };
ok("/ focuses search at desk width", deskKeyAction(ev("/"), desk) === "search");
ok("n opens Add when a screen registered one", deskKeyAction(ev("n"), desk) === "add");
ok("n does nothing when no screen has an Add control", deskKeyAction(ev("n"), { ...desk, hasAdd: false }) === null);
ok("N (shift) is not the shortcut", deskKeyAction(ev("n", { shiftKey: true }), desk) === null);
ok("phone width installs nothing", deskKeyAction(ev("/"), { ...desk, isDesktop: false }) === null && deskKeyAction(ev("n"), { isDesktop: false, hasAdd: true }) === null);
ok("no shortcut fires while typing in an input", deskKeyAction(ev("/", { target: { tagName: "INPUT" } }), desk) === null && deskKeyAction(ev("n", { target: { tagName: "textarea" } }), desk) === null);
ok("select and contenteditable count as typing", deskKeyAction(ev("n", { target: { tagName: "SELECT" } }), desk) === null && deskKeyAction(ev("/", { target: { tagName: "DIV", isContentEditable: true } }), desk) === null);
ok("modifier chords pass through (Cmd-/ etc.)", ["ctrlKey", "metaKey", "altKey"].every(m => deskKeyAction(ev("/", { [m]: true }), desk) === null));
ok("IME composition passes through", deskKeyAction(ev("n", { isComposing: true }), desk) === null);
ok("an open modal blocks / and n", deskKeyAction(ev("/"), { ...desk, modalOpen: true }) === null && deskKeyAction(ev("n"), { ...desk, modalOpen: true }) === null);
ok("other keys are ignored", ["a", "Enter", "Escape", "?"].every(k => deskKeyAction(ev(k), desk) === null));
ok("isTypingTarget tolerates null and non-elements", !isTypingTarget(null) && !isTypingTarget(undefined) && !isTypingTarget("x"));

// ── Modal stack: Esc peels the topmost layer only ──
const a = {}, b = {};
ok("empty stack: nothing on top", modalCount() === 0 && !isTopModal(a));
pushModal(a); pushModal(b);
ok("last opened is on top", modalCount() === 2 && isTopModal(b) && !isTopModal(a));
pushModal(b);
ok("re-registering the same modal does not duplicate it", modalCount() === 2);
popModal(b);
ok("closing the top one hands Esc to the one beneath", modalCount() === 1 && isTopModal(a));
popModal(a); popModal(a);
ok("closing twice is harmless", modalCount() === 0);

// ── Add stack: the screen that registered last (the one on view) wins ──
const calls = [];
const un1 = registerDeskAdd(() => calls.push("one"));
const un2 = registerDeskAdd(() => calls.push("two"));
topDeskAdd()();
ok("n calls the most recent registration", calls.join() === "two");
un2();
topDeskAdd()();
ok("after it unmounts the earlier screen is back on top", calls.join() === "two,one");
un1();
ok("no registrations: no Add", topDeskAdd() === null);
ok("the hint lists the three keys the handler serves", DESK_KEYS.map(k => k.key).join() === "/,n,Esc" && DESK_KEYS.every(k => !/—/.test(k.does)));
ok("search fields are found by the shared attribute", SEARCH_SELECTOR === "[data-desk-search]");

// ── Two-column flow: a copy of the Licenses config as App.jsx declares it ──
const CERT = "Certification";
const STATES = ["CA", "NY", "TX"];
const licenseFields = [
  { key: "type", label: "Type", type: "select", options: ["Medical License", "DEA Registration", CERT] },
  { key: "name", label: (f) => f.type === CERT ? "What Is It In?" : "Display Name" },
  { key: "licenseNumber", label: "License #" },
  { key: "state", label: "State", type: "select", options: STATES, required: (f) => /license|dea/i.test(f.type || "") },
  { key: "issuedDate", label: "Issued", type: "date" },
  { key: "expirationDate", label: "Expires", type: "date", required: (f) => f.type !== CERT },
  { key: "cmeCycleStart", label: "CME Cycle Start", type: "date", show: (f) => /medical license/i.test(f.type || ""), hint: "Leave blank for a normal renewal." },
  { key: "renewalCost", label: "Renewal Cost ($)", type: "currency", placeholder: "e.g. 450" },
  { key: "notes", label: "Notes", type: "textarea" },
];
const keys = (rows) => rows.map(r => r.map(f => f.key).join("+")).join(" | ");
ok("Type select with long labels keeps the full row", !isShortField(licenseFields[0]));
ok("State select is short", isShortField(licenseFields[3]));
ok("a dated field with a hint keeps the full row", !isShortField(licenseFields[6]));
ok("yes/no select is short; a long-label select is not",
  isShortField({ key: "current", type: "select", options: ["Yes", "No"] }) && !isShortField({ key: "outcome", type: "select", options: ["Dismissed", "Settled"] }));
ok("month, number, currency are short; text, textarea, secret, url are not",
  ["month", "number", "currency"].every(t => isShortField({ key: "k", type: t })) && ["text", "textarea", "secret", "url", undefined].every(t => !isShortField({ key: "k", type: t })));
ok("an explicit short flag wins either way", isShortField({ key: "k", type: "textarea", short: true }) && !isShortField({ key: "k", type: "date", short: false }));
const shownMedical = licenseFields; // Medical License: the cycle-start field shows
ok("Medical License: state+issued pair, expires alone before the hinted field, cost alone, notes full",
  keys(formRows(shownMedical)) === "type | name | licenseNumber | state+issuedDate | expirationDate | cmeCycleStart | renewalCost | notes", keys(formRows(shownMedical)));
const shownDea = licenseFields.filter(f => f.key !== "cmeCycleStart"); // any other type: it is hidden
ok("other types: state+issued, expires+cost pair up once the hinted field is hidden",
  keys(formRows(shownDea)) === "type | name | licenseNumber | state+issuedDate | expirationDate+renewalCost | notes", keys(formRows(shownDea)));
ok("every field appears exactly once, in config order",
  formRows(shownDea).flat().map(f => f.key).join() === shownDea.map(f => f.key).join());
ok("no fields: no rows; null: no rows", formRows([]).length === 0 && formRows(null).length === 0);
ok("three shorts in a row: a pair then a single", keys(formRows([{ key: "a", type: "date" }, { key: "b", type: "date" }, { key: "c", type: "date" }])) === "a+b | c");

// ── Modal: desk default 720, phone default 520, explicit width kept ──
const stub = {
  name: "stub",
  setup(b) {
    b.onResolve({ filter: /context\/AppContext$/ }, () => ({ path: "app", namespace: "stub" }));
    b.onLoad({ filter: /^app$/, namespace: "stub" }, () => ({ contents: "export const useApp = () => globalThis.__deskKeysApp;", loader: "js" }));
  },
};
const bundled = await build({
  entryPoints: [modalPath], bundle: true, write: false, format: "esm", platform: "node",
  jsx: "automatic", external: ["react", "react-dom", "react/jsx-runtime"], plugins: [stub], logLevel: "silent",
});
fs.writeFileSync(tmpPath, bundled.outputFiles[0].text);
try {
  const { default: Modal } = await import(tmpPath);
  const theme = { overlay: "rgba(0,0,0,.5)", modalBg: "#fff", border: "#ddd", text: "#111", textMuted: "#666", input: "#f5f5f5", shadow3: "none" };
  const render = (isDesktop, props = {}) => {
    globalThis.__deskKeysApp = { theme, isDesktop };
    return renderToStaticMarkup(React.createElement(Modal, { open: true, onClose() {}, title: "T", ...props }, "body"));
  };
  ok("desk width: default modal is 720 wide", render(true).includes("max-width:720px"));
  ok("phone: default modal stays 520", render(false).includes("max-width:520px"));
  ok("an explicit width is kept at both widths", render(true, { width: 460 }).includes("max-width:460px") && render(false, { width: 640 }).includes("max-width:640px"));
  globalThis.__deskKeysApp = { theme, isDesktop: true };
  ok("closed modal renders nothing", renderToStaticMarkup(React.createElement(Modal, { open: false, onClose() {}, title: "T" })) === "");
} finally {
  fs.rmSync(tmpPath, { force: true });
}

// ── Every modal layer joins the stack (repair round). No DOM here, so the
// three sheets that are not built on shared/Modal and the five lightboxes
// are checked at the source: each registers on the stack while up and
// answers Escape the same way Modal.jsx does. ──
const src = (rel) => fs.readFileSync(path.join(here, "..", rel), "utf8");
for (const rel of ["src/components/pages/PricingModal.jsx", "src/components/pages/SupportModal.jsx", "src/components/pages/TeamSection.jsx"]) {
  const s = src(rel);
  ok(`${rel}: joins the modal stack while open`, /pushModal\(t\);/.test(s) && /return \(\) => popModal\(t\);/.test(s) && /\}, \[open\]\);/.test(s));
  ok(`${rel}: Escape answers only on top at desk width`, /if \(isDesktop && !isTopModal\(token\.current\)\) return;/.test(s));
}
for (const rel of ["src/components/features/CrudSection.jsx", "src/components/features/HealthRecordsSection.jsx", "src/components/features/ScreeningsSection.jsx", "src/components/features/locum/Contracts.jsx", "src/components/features/DocumentsSection.jsx"]) {
  const s = src(rel);
  ok(`${rel}: lightbox closes on capture-phase Escape and stops there`, /if \(e\.key === "Escape"\) \{ e\.stopPropagation\(\); setLightbox\(null\); \}/.test(s) && /addEventListener\("keydown", onKey, true\)/.test(s));
  ok(`${rel}: lightbox joins the modal stack while up`, /pushModal\(layer\);/.test(s) && /popModal\(layer\);/.test(s));
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
