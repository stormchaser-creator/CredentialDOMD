// Public site findings from the 2026-10-01 link audit: the support address
// hidden behind Cloudflare's email obfuscation, /favicon.ico answering 404,
// and robots.txt advertising a path that is never published.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

const root = new URL("../../", import.meta.url);
const read = (p) => readFileSync(new URL(p, root), "utf8");
const pages = [
  ...readdirSync(new URL("landing/", root)).filter(n => n.endsWith(".html")).map(n => `landing/${n}`),
  ...readdirSync(new URL("landing/states/", root)).filter(n => n.endsWith(".html")).map(n => `landing/states/${n}`),
  "public/privacy.html", "public/terms.html",
];
const EMAIL = /[A-Za-z0-9._%+-]+@credentialdomd\.com/g;

// Cloudflare's Email Address Obfuscation (on for the zone) rewrites every
// address it sees into /cdn-cgi/l/email-protection#..., a link that is a 404
// and a "[email protected]" label without JavaScript (reader modes, link
// previews, content blockers). It leaves alone what sits between
// <!--email_off--> and <!--/email_off-->.
function outsideEmailOff(html) {
  const out = [];
  let on = true;
  for (const part of html.split(/(<!--\/?email_off-->)/)) {
    if (part === "<!--email_off-->") { on = false; continue; }
    if (part === "<!--/email_off-->") { on = true; continue; }
    if (on) out.push(...(part.match(EMAIL) || []));
  }
  return out;
}

test("every public page keeps the support address out of Cloudflare's email obfuscation", () => {
  let seen = 0;
  for (const page of pages) {
    const html = read(page);
    seen += (html.match(EMAIL) || []).length;
    assert.deepEqual(outsideEmailOff(html), [], `${page} shows an address Cloudflare would rewrite`);
  }
  assert.ok(seen > 50, `the pages do carry the address (${seen})`);
});

test("the generators write the same markers, so a rebuilt page keeps them", () => {
  for (const source of ["landing/state-template.html", "scripts/build-help.mjs", "scripts/generate-legal-pages.mjs"]) {
    const s = read(source);
    assert.ok(s.includes("<body><!--email_off-->") && s.includes("<!--/email_off--></body>"), source);
  }
});

test("/favicon.ico exists as a real icon and is published at the site root", () => {
  const ico = readFileSync(new URL("public/favicon.ico", root));
  assert.deepEqual([...ico.subarray(0, 4)], [0, 0, 1, 0], "an ICO header");
  assert.ok(ico.readUInt16LE(4) >= 2, "more than one size");
  assert.match(read("scripts/package-site.mjs"), /\.\(\?:png\|jpg\|jpeg\|svg\|ico\|txt\|xml\)\$/, "package-site copies public/*.ico to the root");
});

test("robots.txt allows only paths the site publishes", () => {
  const allowed = read("public/robots.txt").split("\n").filter(l => /^Allow:/.test(l)).map(l => l.slice(6).trim());
  assert.ok(!allowed.includes("/landing/"), "landing pages are published at the root, never under /landing/");
  for (const path of allowed) assert.ok(["/", "/states/"].includes(path), `unexpected Allow ${path}`);
});
