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
 *     --concurrency N (default 1)  --pause-ms N (default 400)  --progress
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
// A phone's Safari, as the physician opens the link (some boards answer 404
// to anything else), naming itself so a site's operator can tell who asked.
export const BROWSER_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.7 Mobile/15E148 Safari/604.1 CredentialDOMD-linkcheck";

// Where the outside links live: the public site and state pages, the app
// (its constants: renewal info, assistant sources, the generated PA and NP
// rules; and every screen and helper), the PA and NP rule data the generator
// reads (canonical files and the evidence ledger, with the board, rule and
// source links for 51 jurisdictions and the national bodies), and the server
// functions (the guide email data, the reminder links, every email template).
export const LINK_SOURCES = [
  "landing", "public", "index.html", "src",
  "data/app-rules",
  "supabase/functions",
];
// "vendor": third-party bundles copied in at build time (pdf.js), never our links.
const SKIP_DIR = new Set(["node_modules", ".generated", "assets", "icons", "fonts", "vendor"]);
const TEXT = /\.(html?|json|jsx?|mjs|tsx?|txt|xml)$/i;

// Our own hosts, and hosts that are never a page (APIs, fonts, schemas).
const OURS = /(^|\.)credentialdomd\.com$/i;
const NOT_A_PAGE = /(^|\.)(fonts\.googleapis\.com|fonts\.gstatic\.com|schema\.org|www\.w3\.org|cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com|api\.[a-z0-9.-]+|supabase\.co|clerk\.[a-z0-9.-]+|stripe\.com|js\.stripe\.com|googletagmanager\.com|example\.(com|org)|esm\.sh|deno\.land|generativelanguage\.googleapis\.com|clerk-telemetry\.com|challenges\.cloudflare\.com|eutils\.ncbi\.nlm\.nih\.gov|up\.railway\.app)$/i;
// Data endpoints the server functions call (a page of JSON, never a link a
// person opens). Their documentation pages ("/api-page") are still checked.
// The Delaware code's POST endpoint is named in the evidence as how its text
// was loaded; the rule pages themselves are linked separately.
const DATA_ENDPOINT = /^(npiregistry\.cms\.hhs\.gov\/api\/|clinicaltables\.nlm\.nih\.gov\/api\/|data\.cms\.gov\/provider-data\/api\/|regulations\.delaware\.gov\/api\/AdminCode\/regulation$)/i;

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
  // A placeholder host ("https://.../api") is not a link.
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(u.hostname)) return false;
  if (DATA_ENDPOINT.test(u.hostname + u.pathname)) return false;
  // A template ("${...}" or "{id}") is not a link.
  return !/[{}$]/.test(url);
}

// A page that answers 200 but is the site's own "not found" or error page.
const ERROR_PAGE_URL = /(error\.aspx|aspxerrorpath|\/404(\.html?)?([/?#]|$)|page-?not-?found|not-?found\.aspx|\/errors?\/?([?#]|$))/i;
// "404" alone, never inside a section number ("37-20-404. Prescribing ..., MCA").
// "We can't find that page" is how dial.iowa.gov titles its not found page.
const ERROR_TITLE = /(page not found|(?<![\d.-])404(?![\d.-])|not found|error occurred|an error has occurred|server error|can(?:'|\u2019|&#0?39;|&rsquo;)?t find (?:that|this|the) page)/i;
// The part of ERROR_TITLE that says the page is missing, not that the server failed.
const NOT_FOUND_TITLE = /(page not found|(?<![\d.-])404(?![\d.-])|not found|can(?:'|\u2019|&#0?39;|&rsquo;)?t find (?:that|this|the) page)/i;
const TITLE = /<title[^>]*>([^<]*)<\/title>/i;
// A page that says the address it was asked for is gone (www.msbml.ms.gov
// answers a retired path with 403, titled "Access Denied", and this text).
const GONE_TEXT = /that link no longer exists/i;
const BOT_CHECK = /(perfdrive|captcha|cf-chl|challenge-platform|are you a robot|access denied|request unsuccessful\. incapsula)/i;

/**
 * The verdict for one fetched link: { state: "ok" | "broken" | "blocked" | "unreachable", why }.
 * `res` is { status, finalUrl, body? (the first part of the page), title? (read
 * from the whole page; taken from body when absent), error? }.
 */
export function judgeLink(res) {
  // A name that no longer resolves is gone. A refused or dropped connection,
  // or no answer in time, is how some state sites (www.dhp.virginia.gov)
  // turn away a client that asked a few times: listed, never a pass.
  if (res.error) return /ENOTFOUND|EAI_NONAME|curl 6\b/.test(res.error) ? { state: "broken", why: `no such host (${res.error})` } : { state: "unreachable", why: `no answer (${res.error})` };
  const { status, finalUrl = "", body = "" } = res;
  const title = res.title ?? (body.match(TITLE) || [])[1] ?? "";
  const gone = ERROR_TITLE.test(title) || GONE_TEXT.test(body);
  // A refusal is not a verdict, but a site's own not found page served with
  // 403 is (dial.iowa.gov, www.msbml.ms.gov): the page is gone, not guarded.
  if (status === 401 || status === 403 || status === 429) {
    return gone ? { state: "broken", why: `HTTP ${status} with the site's own not found page` } : { state: "blocked", why: `HTTP ${status}` };
  }
  if (BOT_CHECK.test(finalUrl) || (status < 400 && BOT_CHECK.test(body) && body.length < 20000)) return { state: "blocked", why: "bot check" };
  // A server failure is the host's trouble, not a removed page: www.ndbon.org
  // answered 509 (Bandwidth Limit Exceeded) with a "Temporarily Unavailable"
  // page on 2026-10-02 while the board was still there. Listed like no
  // answer, never a pass, unless the page says the address itself is gone.
  if (status >= 500 && status < 600) {
    return NOT_FOUND_TITLE.test(title) || GONE_TEXT.test(body) ? { state: "broken", why: `HTTP ${status} with the site's own not found page` } : { state: "unreachable", why: `HTTP ${status} from the server` };
  }
  if (status >= 400) return { state: "broken", why: `HTTP ${status}` };
  if (ERROR_PAGE_URL.test(new URL(finalUrl).pathname + new URL(finalUrl).search)) return { state: "broken", why: `lands on an error page (${finalUrl})` };
  if (ERROR_TITLE.test(title)) return { state: "broken", why: "the page it lands on is titled as an error" };
  if (GONE_TEXT.test(body)) return { state: "broken", why: "the page it lands on says the link no longer exists" };
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

/**
 * url -> ["WY: pa.board link", "FL (addition): pa.ce.humanTrafficking (s. 456.0341(1), F.S.)", ...]
 * for every link in the PA and NP rule data: which jurisdiction, and which
 * rule or board the link stands behind.
 */
export function ruleContext(dir = join(root, "data/app-rules")) {
  const out = new Map();
  const add = (url, label) => {
    let u;
    // A note can follow the link in the evidence ("https://... (built-in browser)").
    try { u = new URL(url.trim().split(/\s/)[0]).href; } catch { return; }
    if (!isCheckable(u)) return;
    if (!out.has(u)) out.set(u, new Set());
    out.get(u).add(label);
  };
  const visit = (node, where, path) => {
    if (Array.isArray(node)) { for (const n of node) visit(n, where, path); return; }
    if (!node || typeof node !== "object") return;
    // A ledger fact: the rule it proves, and the citation it was loaded from.
    if (typeof node.url === "string" && node.field) {
      const field = path.length && !node.field.startsWith(`${path[0]}.`) ? `${path.join(".")}.${node.field}` : node.field;
      add(node.url, `${where}: ${field}${node.cite ? ` (${node.cite})` : ""}`);
    }
    for (const [k, v] of Object.entries(node)) {
      if (typeof v === "string" && /^https?:\/\//.test(v)) {
        if (!(k === "url" && node.field)) add(v, `${where}: ${[...path, k === "url" ? "" : k].filter(Boolean).join(".") || "link"}${k === "url" ? " link" : ""}`);
      } else if (k === "url" && v && typeof v.value === "string") {
        add(v.value, `${where}: ${path.join(".")} link${v.fact ? ` (fact ${v.fact})` : ""}`);
      } else visit(v, where, k === "facts" ? path : [...path, k]);
    }
  };
  for (const file of files(relative(root, dir))) {
    if (!file.endsWith(".json")) continue;
    const rel = relative(dir, file);
    const name = rel.replace(/^.*\//, "").replace(/\.json$/, "");
    if (name === "coverage") continue;
    const where = name === "national" ? "national" : `${name}${rel.startsWith("ledger/additions/") ? " (addition)" : ""}`;
    visit(JSON.parse(readFileSync(file, "utf8")), where, []);
  }
  return new Map([...out].map(([u, s]) => [u, [...s].sort()]));
}

// State legislature sites answer slowly (legislature.vermont.gov in 20 to 27
// seconds, legislature.maine.gov up to a minute on 2026-10-02): a slow answer
// is still an answer.
async function fetchLink(url, { timeoutMs = 40000 } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { redirect: "follow", signal: ctl.signal, headers: { "user-agent": BROWSER_UA, accept: "text/html,application/xhtml+xml,application/pdf;q=0.9,*/*;q=0.8", "accept-language": "en-US,en;q=0.9" } });
    let body = "", title;
    if (/html/i.test(r.headers.get("content-type") || "")) {
      const text = await r.text();
      // The title can sit past the first 40,000 characters (dial.iowa.gov
      // puts 100 KB of script first), so it is read from the whole page.
      title = (text.match(TITLE) || [])[1] ?? "";
      body = text.slice(0, 40000);
    } else { try { await r.body?.cancel(); } catch { /* done */ } }
    return { status: r.status, finalUrl: r.url || url, body, title };
  } catch (err) {
    return { error: err?.name === "AbortError" ? "timeout" : (err?.cause?.code || err?.message || "failed") };
  } finally { clearTimeout(t); }
}

// What a browser does that Node's fetch does not: keep cookies across the
// redirects of a login portal (they loop without them), and complete a
// certificate chain from the system store. curl with a cookie jar does both.
const jarDir = mkdtempSync(join(tmpdir(), "links-"));
let jarSeq = 0;
function curlLink(url, { timeoutMs = 90000 } = {}) {
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

/** Open one link as a browser would; the raw answer for judgeLink. */
export async function openLink(url) {
  const res = await fetchLink(url);
  // A link Node could not open (a redirect loop without cookies, a
  // certificate chain it cannot complete, a slow state site): as a
  // browser would, with cookies and the system's certificates.
  if (res.error) { const viaCurl = await curlLink(url); if (!viaCurl.error) return viaCurl; }
  return res;
}

async function main() {
  const links = collectLinks();
  const rules = ruleContext();
  const urls = [...links.keys()];
  const results = [];
  // Politely: one request at a time by default, with a pause between them.
  const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i > 0 ? Number(process.argv[i + 1]) : dflt; };
  const concurrency = Math.max(1, arg("--concurrency", 1)), pauseMs = Math.max(0, arg("--pause-ms", 400));
  let next = 0;
  const worker = async () => {
    while (next < urls.length) {
      const url = urls[next++];
      if (pauseMs) await new Promise(r => setTimeout(r, pauseMs));
      if (process.argv.includes("--progress")) process.stderr.write(`${next}/${urls.length} ${url}\n`);
      const res = await openLink(url);
      results.push({ url, ...judgeLink(res), finalUrl: res.finalUrl || null, status: res.status ?? null, files: links.get(url), rules: rules.get(url) || [] });
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  results.sort((a, b) => a.state.localeCompare(b.state) || a.url.localeCompare(b.url));
  if (process.argv.includes("--json")) console.log(JSON.stringify(results, null, 2));
  else {
    for (const state of ["broken", "blocked", "unreachable"]) {
      const rows = results.filter(r => r.state === state);
      console.log(`\n${state.toUpperCase()} (${rows.length})`);
      for (const r of rows) console.log(`  ${r.url}\n    ${r.why}\n    in ${r.files.join(", ")}${r.rules.length ? `\n    for ${r.rules.join("; ")}` : ""}`);
    }
    console.log(`\n${results.filter(r => r.state === "ok").length} of ${results.length} links open.`);
  }
  process.exitCode = results.some(r => r.state === "broken") ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
