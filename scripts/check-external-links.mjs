#!/usr/bin/env node
/**
 * Every outside link the site, the app and the emails show, checked the way a
 * physician's browser would open it.
 *
 * A plain status check passed links that were broken for him: a board page
 * that answers 302 to its own error page (medboard.nv.gov answered
 * /Licensees/Renewals/ with error.aspx?aspxerrorpath=..., status 200), and a
 * board home that answers 404 only to clients that are not a browser
 * (med.ohio.gov). So each link is fetched with a Safari user agent, redirects
 * followed, and the page it lands on is judged as well as the status.
 *
 *   node scripts/check-external-links.mjs            # every link, a report
 *   node scripts/check-external-links.mjs --json     # the report as JSON
 *
 * Exit 1 when any link is broken. A 401, 403 or 429, or a bot check, is
 * listed as "blocked": the site refused an automated client, which says
 * nothing about a browser, so open those by hand. Network use only; not part
 * of npm test (its pure parts are tested in check-external-links.test.mjs).
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve, dirname, relative } from "node:path";
import { execFile } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const BROWSER_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.7 Mobile/15E148 Safari/604.1";

// Where the outside links live: the public site, the state data and every
// file generated from it, the app's constants, and the knowledge files.
export const LINK_SOURCES = [
  "landing", "public", "src/constants",
  "supabase/functions/send-guide/stateGuides.json",
  "supabase/functions/send-reminders/renewalLinks.json",
];
const SKIP_DIR = new Set(["node_modules", ".generated", "assets", "icons", "fonts"]);
const TEXT = /\.(html?|json|js|mjs|txt|xml)$/i;

// Our own hosts, and hosts that are never a page (APIs, fonts, schemas).
const OURS = /(^|\.)credentialdomd\.com$/i;
const NOT_A_PAGE = /(^|\.)(fonts\.googleapis\.com|fonts\.gstatic\.com|schema\.org|www\.w3\.org|cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com|api\.[a-z0-9.-]+|supabase\.co|clerk\.[a-z0-9.-]+|stripe\.com|js\.stripe\.com|googletagmanager\.com|example\.(com|org))$/i;

/** Every https URL in `text`, trailing punctuation trimmed, de-duplicated. */
export function urlsIn(text) {
  const out = new Set();
  for (const m of String(text).matchAll(/https?:\/\/[^\s"'<>`\\\]]+/g)) {
    let u = m[0].replace(/&amp;/g, "&");
    // Trailing punctuation, and a ")" that closes the prose around the link
    // rather than one inside it ("440.08(3)" keeps its own).
    for (;;) {
      const t = u.replace(/[.,;:!?]+$/, "");
      const opens = (t.match(/\(/g) || []).length, closes = (t.match(/\)/g) || []).length;
      const next = t.endsWith(")") && closes > opens ? t.slice(0, -1) : t;
      if (next === u) break;
      u = next;
    }
    try { u = new URL(u).href; } catch { continue; }
    out.add(u);
  }
  return [...out];
}

/** Whether `url` is an outside page worth opening. */
export function isCheckable(url) {
  let u;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return false;
  if (OURS.test(u.hostname) || NOT_A_PAGE.test(u.hostname)) return false;
  if (u.hostname === "localhost" || /^\d+\.\d+\.\d+\.\d+$/.test(u.hostname)) return false;
  // A template ("${...}" or "{id}") is not a link.
  return !/[{}$]/.test(url);
}

// A page that answers 200 but is the site's own "not found" or error page.
const ERROR_PAGE_URL = /(error\.aspx|aspxerrorpath|\/404(\.html?)?([/?#]|$)|page-?not-?found|not-?found\.aspx|\/errors?\/?([?#]|$))/i;
const ERROR_PAGE_TITLE = /<title[^>]*>[^<]*(page not found|404|not found|error occurred|an error has occurred|server error)[^<]*<\/title>/i;
const BOT_CHECK = /(perfdrive|captcha|cf-chl|challenge-platform|are you a robot|access denied|request unsuccessful\. incapsula)/i;

/**
 * The verdict for one fetched link: { state: "ok" | "broken" | "blocked" | "unreachable", why }.
 * `res` is { status, finalUrl, body? (the first part of the page), error? }.
 */
export function judgeLink(res) {
  // A name that no longer resolves is gone. A refused or dropped connection,
  // or no answer in time, is how some state sites (www.dhp.virginia.gov)
  // turn away a client that asked a few times: listed, never a pass.
  if (res.error) return /ENOTFOUND|EAI_NONAME|curl 6\b/.test(res.error) ? { state: "broken", why: `no such host (${res.error})` } : { state: "unreachable", why: `no answer (${res.error})` };
  const { status, finalUrl = "", body = "" } = res;
  if (status === 401 || status === 403 || status === 429) return { state: "blocked", why: `HTTP ${status}` };
  if (BOT_CHECK.test(finalUrl) || (status < 400 && BOT_CHECK.test(body) && body.length < 20000)) return { state: "blocked", why: "bot check" };
  if (status >= 400) return { state: "broken", why: `HTTP ${status}` };
  if (ERROR_PAGE_URL.test(new URL(finalUrl).pathname + new URL(finalUrl).search)) return { state: "broken", why: `lands on an error page (${finalUrl})` };
  if (ERROR_PAGE_TITLE.test(body)) return { state: "broken", why: "the page it lands on is titled as an error" };
  return { state: "ok", why: status >= 300 ? `HTTP ${status}` : "" };
}

function* files(path) {
  const abs = join(root, path);
  let st;
  try { st = statSync(abs); } catch { return; }
  if (st.isFile()) { if (TEXT.test(abs)) yield abs; return; }
  for (const name of readdirSync(abs)) {
    if (SKIP_DIR.has(name)) continue;
    yield* files(join(path, name));
  }
}

/** url -> [files it appears in] for every checkable outside link. */
export function collectLinks(sources = LINK_SOURCES) {
  const where = new Map();
  for (const src of sources) for (const file of files(src)) {
    for (const url of urlsIn(readFileSync(file, "utf8"))) {
      if (!isCheckable(url)) continue;
      if (!where.has(url)) where.set(url, new Set());
      where.get(url).add(relative(root, file));
    }
  }
  return new Map([...where].map(([u, s]) => [u, [...s].sort()]));
}

async function fetchLink(url, { timeoutMs = 25000 } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { redirect: "follow", signal: ctl.signal, headers: { "user-agent": BROWSER_UA, accept: "text/html,application/xhtml+xml,application/pdf;q=0.9,*/*;q=0.8", "accept-language": "en-US,en;q=0.9" } });
    let body = "";
    if (/html/i.test(r.headers.get("content-type") || "")) body = (await r.text()).slice(0, 40000);
    else { try { await r.body?.cancel(); } catch { /* done */ } }
    return { status: r.status, finalUrl: r.url || url, body };
  } catch (err) {
    return { error: err?.name === "AbortError" ? "timeout" : (err?.cause?.code || err?.message || "failed") };
  } finally { clearTimeout(t); }
}

// What a browser does that Node's fetch does not: keep cookies across the
// redirects of a login portal (they loop without them), and complete a
// certificate chain from the system store. curl with a cookie jar does both.
const jarDir = mkdtempSync(join(tmpdir(), "links-"));
let jarSeq = 0;
function curlLink(url, { timeoutMs = 40000 } = {}) {
  const jar = join(jarDir, `jar-${++jarSeq}`);
  return new Promise((done) => {
    execFile("curl", ["-s", "-L", "--max-redirs", "15", "-c", jar, "-b", jar, "-A", BROWSER_UA, "-o", "/dev/null",
      "-w", "%{http_code} %{url_effective}", "--max-time", String(Math.ceil(timeoutMs / 1000)), url], (err, stdout) => {
      const [code, ...rest] = String(stdout || "").trim().split(" ");
      const status = Number(code);
      if (!status) { done({ error: err ? `curl ${err.code ?? "failed"}` : "no answer" }); return; }
      done({ status, finalUrl: rest.join(" ") || url, body: "" });
    });
  });
}

async function main() {
  const links = collectLinks();
  const urls = [...links.keys()];
  const results = [];
  let next = 0;
  const worker = async () => {
    while (next < urls.length) {
      const url = urls[next++];
      let res = await fetchLink(url);
      // A link Node could not open (a redirect loop without cookies, a
      // certificate chain it cannot complete, a slow state site): as a
      // browser would, with cookies and the system's certificates.
      if (res.error) { const viaCurl = await curlLink(url); if (!viaCurl.error) res = viaCurl; }
      results.push({ url, ...judgeLink(res), finalUrl: res.finalUrl || null, status: res.status ?? null, files: links.get(url) });
    }
  };
  await Promise.all(Array.from({ length: 10 }, worker));
  results.sort((a, b) => a.state.localeCompare(b.state) || a.url.localeCompare(b.url));
  if (process.argv.includes("--json")) console.log(JSON.stringify(results, null, 2));
  else {
    for (const state of ["broken", "blocked", "unreachable"]) {
      const rows = results.filter(r => r.state === state);
      console.log(`\n${state.toUpperCase()} (${rows.length})`);
      for (const r of rows) console.log(`  ${r.url}\n    ${r.why}\n    in ${r.files.join(", ")}`);
    }
    console.log(`\n${results.filter(r => r.state === "ok").length} of ${results.length} links open.`);
  }
  process.exitCode = results.some(r => r.state === "broken") ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
