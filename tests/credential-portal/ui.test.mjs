import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import vm from "node:vm";
import { PORTAL_CONFIG, parseDocuments, previewAllowed, downloadName } from "../../public/credential-access/portal.mjs";

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
