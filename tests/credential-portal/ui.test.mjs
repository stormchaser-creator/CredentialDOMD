import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import vm from "node:vm";
import { PORTAL_CONFIG, parseDocuments, previewAllowed, downloadName, parseStandingView, documentActions, renderStandingView, standingHeader, expiryStatus, formatEnd, sessionExpiry, fileMessage } from "../../public/credential-access/portal.mjs";

const html = await readFile(new URL("../../landing/credential-access.html", import.meta.url), "utf8");
const source = await readFile(new URL("../../public/credential-access/portal.mjs", import.meta.url), "utf8");
const bootstrap = html.match(/<script id="portal-bootstrap">([\s\S]*?)<\/script>/)[1];
const doc = { id: "00000000-0000-4000-8000-000000000001", name: "Synthetic license.pdf", mimeType: "application/pdf", sizeBytes: 100 };

test("recipient access stays disabled; no document URL or storage credential in public config", () => {
  assert.equal(PORTAL_CONFIG.enabled, false);
  assert.equal(PORTAL_CONFIG.endpoint, "https://hkpnnsjcwprrwobmpqyy.supabase.co/functions/v1/credential-portal");
  assert.deepEqual(Object.keys(PORTAL_CONFIG).sort(), ["enabled", "endpoint"]);
});

test("bootstrap removes every fragment/query before registering the app mount", () => {
  for (const hash of ["#invite=" + "a".repeat(43), "#invite=invalid", "#invite=" + "a".repeat(43) + "&invite=duplicate", "#unexpected=secret", ""]) {
    const calls = [];
    const location = { hash, search: "?token=must-not-remain", pathname: "/credential-access/" };
    vm.runInNewContext(bootstrap, {
      URLSearchParams, location,
      history: { replaceState(state, title, url) { calls.push({ action: "clear", state, title, url }); location.hash = ""; location.search = ""; } },
      addEventListener(event) { calls.push({ action: "listen", event }); },
      document: { addEventListener(event) { assert.equal(location.hash, ""); assert.equal(location.search, ""); calls.push({ action: "mount-listener", event }); } },
    });
    assert.equal(calls[0].action, "clear");
    assert.equal(calls[0].url, "/credential-access/");
    assert.equal(calls.at(-1).event, "DOMContentLoaded");
  }
});

test("public page has a matching strict bootstrap hash and only local resources", () => {
  const hash = createHash("sha256").update(bootstrap).digest("base64");
  const csp = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)[1];
  assert.ok(csp.includes(`'sha256-${hash}'`));
  for (const directive of ["default-src 'none'", "object-src 'none'", "base-uri 'none'", "form-action 'none'", "frame-src blob:"]) assert.ok(csp.includes(directive));
  assert.ok(!csp.includes("unsafe-inline") && !csp.includes("unsafe-eval"));
  assert.match(html, /name="robots" content="noindex, nofollow, noarchive"/);
  assert.match(html, /name="referrer" content="no-referrer"/);
  assert.ok(html.indexOf("history.replaceState") < html.indexOf('rel="stylesheet"'));
  for (const match of html.matchAll(/(?:href|src)="([^"]+)"/g)) assert.ok(match[1].startsWith("/") || match[1].startsWith("#"));
  // These paths must never become a persistent session or an HTML document renderer.
  for (const prohibited of [/localStorage/, /sessionStorage/, /indexedDB/, /serviceWorker\.register/, /innerHTML/, /srcdoc/, /document\.cookie/, /sendBeacon/]) assert.ok(!prohibited.test(source));
});

test("metadata is bounded, unique and stripped to the recipient contract", () => {
  assert.deepEqual(parseDocuments([{ ...doc, storagePath: "private", signedUrl: "never-use" }]), [doc]);
  for (const value of [null, {}, [doc, doc], [{ ...doc, id: "../path" }], [{ ...doc, sizeBytes: -1 }], [{ ...doc, sizeBytes: 10 * 1024 * 1024 + 1 }], [{ ...doc, sizeBytes: "100" }]]) assert.throws(() => parseDocuments(value));
  const large = Array.from({ length: 4 }, (_, i) => ({ ...doc, id: `00000000-0000-4000-8000-00000000000${i}`, sizeBytes: 10 * 1024 * 1024 }));
  assert.throws(() => parseDocuments(large));
});

test("previews require both an inline disposition and a permitted MIME", () => {
  for (const mime of ["application/pdf", "image/png", "image/jpeg", "text/plain; charset=utf-8"]) {
    assert.equal(previewAllowed(new Headers({ "Content-Type": mime, "Content-Disposition": 'inline; filename="test"' })), true);
    assert.equal(previewAllowed(new Headers({ "Content-Type": mime, "Content-Disposition": 'attachment; filename="test"' })), false);
  }
  for (const mime of ["text/html", "image/svg+xml", "application/octet-stream", "application/msword"]) assert.equal(previewAllowed(new Headers({ "Content-Type": mime, "Content-Disposition": "inline" })), false);
  assert.equal(previewAllowed(new Headers({ "Content-Type": "application/pdf" })), false);
});

test("download names cannot introduce paths or control characters", () => {
  assert.equal(downloadName("../license\r\n.pdf"), "__license__.pdf");
  assert.equal(downloadName("folder\\license.pdf"), "folder_license.pdf");
  assert.equal(downloadName("x".repeat(200)).length, 160);
});

// Standing administrator access: the page renders the server's shaped view with
// text nodes only. A tiny synthetic DOM stands in for the browser.
function fakeDocument() {
  const make = tag => ({
    tagName: tag.toUpperCase(), className: "", textContent: "", type: "", children: [], attributes: {}, listeners: {},
    append(...nodes) { this.children.push(...nodes); }, replaceChildren(...nodes) { this.children = nodes; },
    setAttribute(name, value) { this.attributes[name] = String(value); }, addEventListener(event, handler) { this.listeners[event] = handler; },
  });
  return { createElement: make };
}
const walk = node => [node, ...(node.children || []).flatMap(walk)];
const textOf = node => [node.textContent, ...(node.children || []).map(textOf)].join(" ");
const A = "00000000-0000-4000-8000-00000000000a", B = "00000000-0000-4000-8000-00000000000b", C = "00000000-0000-4000-8000-00000000000c";
const standingResponse = (allowDownload = true) => ({
  expiresAt: new Date(Date.now() + 3600000).toISOString(),
  grant: { purpose: "Reappointment, Synthetic General", accessEndsAt: "2026-10-25T12:00:00.000Z", allowDownload },
  physician: { name: "Synthetic Physician", degreeType: "DO", npi: "1234567890", specialties: ["Neurosurgery"], primaryState: "CO", additionalStates: ["ND", "CA"], email: "doc@example.test", address: "must be dropped" },
  sections: [{ key: "licenses", label: "Licenses, DEA and certifications", records: [
    { id: A, title: "Colorado medical license", expirationDate: "2020-01-01", fields: [{ label: "Number", value: "DR.1" }, { label: "Issued", value: "2019-01-01" }], documents: [
      { id: B, name: "License.pdf", mimeType: "application/pdf", sizeBytes: 2048, storagePath: "never" },
      { id: C, name: "License.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", sizeBytes: null },
    ] },
  ] }],
  documentCount: 2,
});

test("standing view contract: bounded, stripped to what the page renders, and refuses malformed shapes", () => {
  const view = parseStandingView(standingResponse());
  assert.equal(view.physician.address, undefined);
  assert.equal(view.sections[0].records[0].documents[0].storagePath, undefined);
  assert.equal(view.documentCount, 2);
  assert.equal(view.grant.allowDownload, true);
  const bad = [null, {}, { ...standingResponse(), grant: {} }, { ...standingResponse(), sections: "x" }];
  const duplicate = standingResponse(); duplicate.sections[0].records[0].documents[1].id = B; bad.push(duplicate);
  const badId = standingResponse(); badId.sections[0].records[0].id = "../x"; bad.push(badId);
  for (const value of bad) assert.throws(() => parseStandingView(value));
});

test("recipient UI hides every Download button when downloads are off and keeps Preview", () => {
  for (const allowDownload of [true, false]) {
    const doc = fakeDocument(), container = doc.createElement("div"), opened = [];
    const view = parseStandingView(standingResponse(allowDownload));
    renderStandingView(container, view, { doc, onOpen: (item, action) => opened.push([item.id, action]) });
    const buttons = walk(container).filter(n => n.tagName === "BUTTON");
    assert.deepEqual(buttons.map(b => b.textContent).sort(), allowDownload ? ["Download", "Download", "Preview"] : ["Preview"]);
    buttons.find(b => b.textContent === "Preview").listeners.click();
    assert.deepEqual(opened, [[B, "view"]]);
    const text = textOf(container);
    assert.match(text, /Licenses, DEA and certifications \(1\)/); assert.match(text, /Expired Jan 1, 2020/); assert.match(text, /Jan 1, 2019/);
    if (!allowDownload) assert.match(text, /downloads are off/);
  }
  assert.deepEqual(documentActions({ mimeType: "application/pdf", sizeBytes: 1 }, false), ["view"]);
  assert.deepEqual(documentActions({ mimeType: "application/msword", sizeBytes: 1 }, false), []);
  assert.deepEqual(documentActions({ mimeType: "image/png", sizeBytes: 11 * 1024 * 1024 }, true), []);
});

test("standing header names the physician, identifiers, states, purpose and end date; badges read plainly", () => {
  const header = standingHeader(parseStandingView(standingResponse(false)), { timeZone: "UTC" });
  assert.equal(header.name, "Synthetic Physician, DO");
  assert.equal(header.detail, "NPI 1234567890 \u{b7} Neurosurgery \u{b7} Licensed in CO (primary), ND, CA \u{b7} doc@example.test");
  assert.equal(header.grant, "Shared for: Reappointment, Synthetic General. Access ends Oct 25, 2026, 12:00 PM UTC.");
  assert.match(header.downloads, /turned off downloads/);
  const now = Date.parse("2026-09-25T12:00:00Z");
  assert.deepEqual(expiryStatus("2026-10-05", now), { tone: "soon", label: "Expires in 10 days" });
  assert.equal(expiryStatus("2027-09-25", now).tone, "current");
  assert.equal(expiryStatus("2026-09-01", now).tone, "expired");
  assert.equal(expiryStatus(null, now), null);
});

test("recipient page carries the standing view, frame refusal and visit copy", () => {
  for (const id of ["standing-view", "physician-name", "physician-detail", "grant-detail", "visit-detail", "download-note", "section-list", "refresh-standing", "end-standing"]) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(source, /window\.top !== window\.self/);
  assert.match(html, /open the link in your email again and ask for a new code/);
  assert.ok(!/\u{2014}|\u{2013}/u.test(html + source), "no en or em dashes in recipient copy");
});

test("the access end is a moment in the viewer's own zone with the time, not a UTC date a day late", () => {
  // A 30-day grant made at 7pm MDT on Sep 25 ends at 01:00 UTC on Oct 26.
  const view = parseStandingView({ ...standingResponse(), grant: { purpose: "X", accessEndsAt: "2026-10-26T01:00:00.000Z", allowDownload: true } });
  assert.equal(standingHeader(view, { timeZone: "America/Denver" }).grant, "Shared for: X. Access ends Oct 25, 2026, 7:00 PM MDT.");
  assert.equal(formatEnd("2026-10-26T01:00:00.000Z", "America/New_York"), "Oct 25, 2026, 9:00 PM EDT");
  assert.ok(!/[^\x00-\x7f]/.test(formatEnd("2026-10-26T01:00:00.000Z", "America/Denver")));
  // Date-only record fields stay calendar dates.
  assert.match(expiryStatus("2027-09-25", Date.parse("2026-09-25T12:00:00Z")).label, /Sep 25, 2027/);
});

test("a visit's length comes from the server's remaining seconds, so a recipient clock minutes out still opens it", () => {
  const now = Date.parse("2026-09-25T18:00:00Z");
  // The office PC runs 2 minutes slow: the server's timestamp is 62 minutes ahead of it.
  const slowClock = { expiresAt: new Date(now + 62 * 60000).toISOString(), expiresInSeconds: 3600 };
  assert.equal(sessionExpiry(slowClock, "standing", now), now + 3600 * 1000);
  assert.equal(sessionExpiry({ ...slowClock, expiresInSeconds: 1800 }, "selection", now), now + 1800 * 1000);
  // Without the countdown (an older server) a few minutes of skew is tolerated.
  assert.ok(sessionExpiry({ expiresAt: slowClock.expiresAt }, "standing", now) <= now + 3600 * 1000);
  for (const bad of [{ expiresInSeconds: 0 }, { expiresInSeconds: -5 }, { expiresInSeconds: 7200 }, { expiresInSeconds: "3600" }, { expiresInSeconds: 3000 }, { expiresAt: "x" }, { expiresAt: new Date(now + 3 * 3600000).toISOString() }]) {
    const kind = bad.expiresInSeconds === 3000 ? "selection" : "standing";
    assert.throws(() => sessionExpiry(bad, kind, now), JSON.stringify(bad));
  }
});

test("with downloads off, file messages never point at a Download button that is not there", () => {
  for (const reason of ["not_previewable", "pdf_ready", "pdf_failed"]) {
    const off = fileMessage(reason, false), on = fileMessage(reason, true);
    assert.ok(off && !/Download/.test(off), `${reason}: ${off}`);
    assert.match(off, /ask the physician for a copy/i);
    assert.match(on, /Download/);
  }
  assert.match(fileMessage("view_refused", false), /downloads are turned off/);
  // Every such message on the page goes through fileMessage.
  const mounted = source.slice(source.indexOf("export function mountPortal"));
  assert.ok(!/Choose Download|Download the original/.test(mounted), "no hard-coded Download wording inside the page");
  assert.match(mounted, /fileMessage\("not_previewable", canDownload\)/);
  assert.match(mounted, /fileMessage\("pdf_ready", canDownload\)/);
  assert.match(mounted, /fileMessage\("pdf_failed", canDownload\)/);
});

test("an interrupted verification of a standing link tells the administrator to reopen the link, not to ask for a new invitation", () => {
  const mounted = source.slice(source.indexOf("export function mountPortal"));
  assert.match(mounted, /answeredKind === "standing" \? "Open the link in your email again for a new code\."/);
  assert.match(mounted, /sessionExpiry\(value, nextKind\)/);
  assert.match(mounted, /sessionExpiry\(value, "standing"\)/);
  assert.ok(!/61 \* 60 \* 1000/.test(mounted), "no tight local-clock bound left");
});
