// clerkProfile (supabase/functions/_shared/clerkAuth.ts) when the caller's
// identity cannot be checked.
//
// The defect: Clerk's key set timed out under load and jwtVerify threw jose's
// JWKSTimeout ("request timed out"); clerkProfile caught it as a failed
// verification and returned null, so billing-entitlements and ai-proxy answered
// 401 to valid tokens (QA lab, 2026-10-01, full regression pass 2). The app reads
// ai-proxy's 401 as a signed-out session and keeps shared AI off on the device
// until the next page load. A failed profiles read was answered the same way.
// Both now throw ClerkAuthUnavailable, and ai-proxy answers it 429 with a
// Retry-After (access_policy_unavailable), never 401.
//
// The module is loaded as scripts/clerk-auth.test.mjs loads it (imports
// stripped, TypeScript compiled), with jose, supabase-js and the issuer helper
// replaced by stubs each case sets. Synthetic ids only.
// Run: node --test scripts/clerk-auth-unavailable.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { transformSync } from "esbuild";

const source = readFileSync(new URL("../supabase/functions/_shared/clerkAuth.ts", import.meta.url), "utf8");
const proxySource = readFileSync(new URL("../supabase/functions/ai-proxy/index.ts", import.meta.url), "utf8");

const stubs = {
  verify: async () => ({ payload: { sub: "user_qaSynthetic01" } }),
  profile: { data: { id: "00000000-0000-4000-8000-0000000000a1", email: "someone@qa.credentialdomd.test" }, error: null },
  admin: { data: null, error: null },
};
const query = (result) => {
  const q = { select: () => q, eq: () => q, maybeSingle: async () => result() };
  return q;
};
globalThis.__clerkAuthUnavailableTest = {
  Deno: { env: { get: (name) => (name === "CLERK_ISSUER" ? "https://clerk.qa.credentialdomd.test" : "x") } },
  jwtVerify: (...args) => stubs.verify(...args),
  createRemoteJWKSet: () => ({}),
  clerkJwksUrl: (issuer) => new URL(`${issuer}/.well-known/jwks.json`),
  createClient: () => ({ from: (table) => query(() => (table === "profiles" ? stubs.profile : stubs.admin)) }),
};
let stripped = source.replace(/^import .*;\n/gm, "");
stripped = "const { Deno, jwtVerify, createRemoteJWKSet, clerkJwksUrl, createClient } = globalThis.__clerkAuthUnavailableTest;\n" + stripped;
const js = transformSync(stripped, { loader: "ts", format: "esm" }).code;
const mod = await import("data:text/javascript;base64," + Buffer.from(js).toString("base64"));
const { clerkProfile, keySetUnreachable, ClerkAuthUnavailable } = mod;

const request = () => new Request("https://example.invalid/functions/v1/ai-proxy", { headers: { Authorization: "Bearer synthetic.token.value" } });
const joseError = (code, message = "x") => Object.assign(new Error(message), { code });
const quiet = async (fn) => {
  const original = console.error;
  console.error = () => {};
  try { return await fn(); } finally { console.error = original; }
};
const reset = () => {
  stubs.verify = async () => ({ payload: { sub: "user_qaSynthetic01" } });
  stubs.profile = { data: { id: "00000000-0000-4000-8000-0000000000a1", email: "someone@qa.credentialdomd.test" }, error: null };
  stubs.admin = { data: null, error: null };
};

test("a key set that timed out is not a verdict on the token: clerkProfile throws ClerkAuthUnavailable, never null", async () => {
  reset();
  stubs.verify = async () => { throw joseError("ERR_JWKS_TIMEOUT", "request timed out"); };
  await quiet(() => assert.rejects(clerkProfile(request()), (err) => err instanceof ClerkAuthUnavailable && err.code === "auth_unavailable"));
});

test("a key set answered with something other than 200 or JSON, or a fetch that failed, is unavailable too", async () => {
  for (const err of [
    joseError("ERR_JOSE_GENERIC", "Expected 200 OK from the JSON Web Key Set HTTP response"),
    joseError("ERR_JOSE_GENERIC", "Failed to parse the JSON Web Key Set HTTP response as JSON"),
    new TypeError("fetch failed"),
  ]) {
    reset();
    stubs.verify = async () => { throw err; };
    await quiet(() => assert.rejects(clerkProfile(request()), ClerkAuthUnavailable, err.message));
  }
});

test("a token the key set refuses is still not signed in (null, which callers answer 401)", async () => {
  for (const code of ["ERR_JWT_EXPIRED", "ERR_JWS_SIGNATURE_VERIFICATION_FAILED", "ERR_JWT_CLAIM_VALIDATION_FAILED", "ERR_JWS_INVALID", "ERR_JWT_INVALID", "ERR_JWKS_NO_MATCHING_KEY"]) {
    reset();
    stubs.verify = async () => { throw joseError(code); };
    assert.equal(await quiet(() => clerkProfile(request())), null, code);
  }
  reset();
  stubs.verify = async () => { throw joseError("ERR_JOSE_GENERIC", "some other generic jose failure"); };
  assert.equal(await quiet(() => clerkProfile(request())), null, "a generic jose error that is not about the key set");
});

test("a profiles read that failed throws ClerkAuthUnavailable; a verified sub with no profile is still null", async () => {
  reset();
  stubs.profile = { data: null, error: { message: "An invalid response was received from the upstream server" } };
  await quiet(() => assert.rejects(clerkProfile(request()), ClerkAuthUnavailable));
  reset();
  stubs.profile = { data: null, error: null };
  assert.equal(await quiet(() => clerkProfile(request())), null);
});

test("no token and a verified identity keep their answers", async () => {
  reset();
  assert.equal(await clerkProfile(new Request("https://example.invalid/")), null, "no Authorization header");
  const who = await clerkProfile(request());
  assert.equal(who.profileId, "00000000-0000-4000-8000-0000000000a1");
  assert.equal(who.clerkSubject, "user_qaSynthetic01");
  assert.equal(who.isAdmin, false);
});

test("keySetUnreachable: only the key set's own failures, never a verdict on the token", () => {
  assert.equal(keySetUnreachable(joseError("ERR_JWKS_TIMEOUT")), true);
  assert.equal(keySetUnreachable(new TypeError("fetch failed")), true);
  assert.equal(keySetUnreachable(joseError("ERR_JWT_EXPIRED")), false);
  assert.equal(keySetUnreachable(joseError("ERR_JWKS_NO_MATCHING_KEY")), false);
  assert.equal(keySetUnreachable(joseError("ERR_JWKS_INVALID")), false);
  assert.equal(keySetUnreachable(new Error("bad token")), false, "an error with no code that is not the fetch's");
  assert.equal(keySetUnreachable(null), false);
  assert.equal(keySetUnreachable(undefined), false);
});

test("ai-proxy answers an identity it could not check with 429 access_policy_unavailable and a Retry-After, before its 401", () => {
  const at = proxySource.indexOf("try { user = await clerkProfile(req); }");
  assert.ok(at > 0, "ai-proxy reads clerkProfile inside a try");
  const block = proxySource.slice(at, proxySource.indexOf('if (!user) return json(401', at));
  assert.match(block, /err instanceof ClerkAuthUnavailable/);
  assert.match(block, /json\(429, \{ error: AI_CODES\.accessUnavailable, retry_after: 5 \}[^;]*\{ "Retry-After": "5" \}\)/);
  assert.match(proxySource, /import \{ ClerkAuthUnavailable, clerkProfile \} from "\.\.\/_shared\/clerkAuth\.ts";/);
});

// ══ Every other caller: 503 with its own CORS headers, never a bare 500 ══════
// 35b28568 said a caller that catches nothing "answers 500 ... read as a
// transient failure". In a browser it does not: std serve's default onError
// answers `new Response("Internal Server Error", { status: 500 })` with no
// Access-Control-Allow-Origin, so a fetch from credentialdomd.com rejects as a
// network failure (CallSync told an online member "You're offline"; invoke
// callers said "Failed to send a request to the Edge Function"). create-ticket
// and reply-ticket caught it as a 400 carrying the internal stage text.

test("answerAuthUnavailable: ClerkAuthUnavailable becomes 503 with the caller's CORS headers; anything else is untouched", async () => {
  const { answerAuthUnavailable, authUnavailableResponse, AUTH_UNAVAILABLE_MESSAGE } = mod;
  const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, content-type" };
  const res = await answerAuthUnavailable(cors, async () => { throw new ClerkAuthUnavailable("key_set"); })(request());
  assert.equal(res.status, 503);
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), "*");
  assert.equal(res.headers.get("Retry-After"), "5");
  const body = await res.json();
  assert.deepEqual(body, { error: AUTH_UNAVAILABLE_MESSAGE, code: "auth_unavailable" });
  assert.doesNotMatch(body.error, /key_set|profile_read|Identity could not/, "no internal stage text reaches a member");
  const ok = new Response("fine");
  assert.equal(await answerAuthUnavailable(cors, async () => ok)(request()), ok);
  await assert.rejects(answerAuthUnavailable(cors, async () => { throw new Error("other"); })(request()), /other/);
  assert.equal(authUnavailableResponse().headers.get("Access-Control-Allow-Origin"), null, "no CORS unless the caller passes it");
});

// Each function's real source, imports stripped and replaced: serve captures
// the handler, clerkProfile throws ClerkAuthUnavailable, the helpers come from
// the compiled clerkAuth.ts above, and every other import is an inert stub.
const IMPORT = /^import\s[\s\S]*?from\s*["'][^"']+["'](?:\s+with\s*\{[^}]*\})?;?[ \t]*\n/gm;
function importedNames(spec) {
  const names = [];
  const clause = spec.replace(/^import\s+(type\s+)?/, "").replace(/\s*from\s*["'][^"']+["'](?:\s+with\s*\{[^}]*\})?;?\s*$/, "").trim();
  if (/^type\b/.test(spec.replace(/^import\s+/, ""))) return names;
  const braces = clause.match(/\{([\s\S]*)\}/);
  if (braces) {
    for (const part of braces[1].split(",")) {
      const p = part.trim().replace(/^type\s+/, "");
      if (!p || /^type\s/.test(part.trim())) continue;
      names.push(p.includes(" as ") ? p.split(/\s+as\s+/)[1].trim() : p);
    }
  }
  const outside = clause.replace(/\{[\s\S]*\}/, "").replace(/,/g, " ").trim();
  const ns = outside.match(/\*\s+as\s+(\w+)/);
  if (ns) names.push(ns[1]);
  else if (outside) names.push(...outside.split(/\s+/).filter(Boolean));
  return names;
}
const inert = () => new Proxy(function () {}, {
  get: (_t, key) => (key === Symbol.toPrimitive ? () => "" : key === "then" ? undefined : inert()),
  apply: () => inert(),
  construct: () => inert(),
});
async function functionHandler(name) {
  const src = readFileSync(new URL(`../supabase/functions/${name}/index.ts`, import.meta.url), "utf8");
  const names = new Set();
  for (const spec of src.match(IMPORT) || []) for (const n of importedNames(spec)) names.add(n);
  let captured = null;
  const provided = {
    serve: (h) => { captured = h; },
    clerkProfile: async () => { throw new ClerkAuthUnavailable("key_set"); },
    ClerkAuthUnavailable,
    answerAuthUnavailable: mod.answerAuthUnavailable,
    authUnavailableResponse: mod.authUnavailableResponse,
  };
  const key = `__fnHarness_${name.replace(/\W/g, "_")}`;
  globalThis[key] = Object.fromEntries([...names].map((n) => [n, n in provided ? provided[n] : inert()]));
  globalThis[key].Deno = { env: { get: (k) => ({ SUPABASE_URL: "https://x.invalid", CLERK_ISSUER: "https://clerk.qa.credentialdomd.test" })[k] ?? "x" }, serve: (h) => { captured = h; } };
  const body = src.replace(IMPORT, "");
  const head = `const { ${[...names, "Deno"].join(", ")} } = globalThis.${key};\n`;
  const js = transformSync(head + body, { loader: "ts", format: "esm" }).code;
  await import("data:text/javascript;base64," + Buffer.from(js).toString("base64"));
  assert.ok(captured, `${name}: serve was called`);
  return { handler: captured, src };
}
const fnRequest = () => new Request("https://fn.invalid/functions/v1/x", {
  method: "POST",
  headers: { Authorization: "Bearer synthetic.token.value", "Content-Type": "application/json", Origin: "https://credentialdomd.com" },
  body: JSON.stringify({ url: "https://example.invalid/feed.ics", action: "add" }),
});

// Called from the browser, so the 503 must carry CORS.
const BROWSER = ["public-record", "send-packet-email", "backup-link", "ticket-attachment-url", "send-invite", "admin-shared-key",
  "callsync-feed", "delete-account", "build-backup", "create-ticket", "reply-ticket", "forwarding-address"];
// Hook-secret or admin callers with no CORS of their own; the 503 still beats a bare 500.
const SERVER = ["send-reminders", "send-guide"];

for (const name of [...BROWSER, ...SERVER]) {
  test(`${name}: an identity that could not be checked answers 503 auth_unavailable${BROWSER.includes(name) ? " with CORS" : ""}, not 500, 400 or 401`, async () => {
    const { handler } = await functionHandler(name);
    const res = await quiet(() => handler(fnRequest()));
    assert.equal(res.status, 503);
    assert.equal((await res.json()).code, "auth_unavailable");
    if (BROWSER.includes(name)) assert.ok(res.headers.get("Access-Control-Allow-Origin"), "CORS header present");
  });
}

test("no function calls clerkProfile without one of the two answers", () => {
  const dir = new URL("../supabase/functions/", import.meta.url);
  // ai-proxy answers it 429 (its own test above). billing-entitlements hands
  // clerkProfile to createAccessPolicyHandler, whose catch answers 503
  // access_policy_unavailable with CORS. The functions built on a shared
  // handler (admin-member-view, invite-to-join, send-invoice-email, billing,
  // limited launch) call clerkProfile through their dependencies file, not
  // here, and their handlers' own catches answer 503.
  const covered = new Set([...BROWSER, ...SERVER, "ai-proxy", "billing-entitlements"]);
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith("_")) continue;
    let src;
    try { src = readFileSync(new URL(`${entry.name}/index.ts`, dir), "utf8"); } catch { continue; }
    if (!/\bclerkProfile\(/.test(src)) continue;
    assert.ok(covered.has(entry.name), `${entry.name} calls clerkProfile directly and is not checked here`);
    if (entry.name === "billing-entitlements") { assert.match(src, /serve\(createAccessPolicyHandler\(/); continue; }
    assert.ok(/serve\(answerAuthUnavailable\(/.test(src) || /instanceof ClerkAuthUnavailable/.test(src),
      `${entry.name}: wrap serve in answerAuthUnavailable or map ClerkAuthUnavailable in its catch`);
  }
});

test("CallSync reads the 503 as a sign-in check that did not answer, not as CallSync down or the member offline", () => {
  const hook = readFileSync(new URL("../src/hooks/useCallSync.js", import.meta.url), "utf8");
  assert.match(hook, /res\.status === 503 && body\?\.code === "auth_unavailable"\) throw new CallSyncError\("auth_unavailable", MESSAGES\.auth_unavailable\)/);
  assert.ok(hook.indexOf('"auth_unavailable"') < hook.indexOf('throw new CallSyncError("upstream"'), "before the catch-all upstream message");
});
