// Checks for supabase/functions/_shared/clerkAuth.ts: who counts as an admin.
//
// The failure this exists to stop coming back: isAdmin used to be
// ADMIN_EMAILS.has(email), where email fell back to profiles.email whenever the
// verified token carried no email claim. A default Clerk session token (the one
// getToken() returns with no template) carries no email and still passes the
// issuer-only jwtVerify, and profiles.email is a column its own owner edits,
// so anyone who could sign up could name themselves an allowlisted address and
// come back an admin. isAdmin is now membership in app_admins, keyed to the
// profile the verified sub resolved to.
//
// clerkAuth.ts imports jose and supabase-js from esm.sh and reads Deno.env at
// module load, neither of which node can resolve, so the module is loaded the
// way scripts/send-invite-consent.test.mjs loads an edge function: strip the
// imports, stub Deno, compile the TypeScript, import it from a data URL. The
// pure helpers under test have no I/O in them, so nothing else is needed.
// Run: node scripts/clerk-auth.test.mjs

import { readFileSync } from "node:fs";
import { transformSync } from "esbuild";

const SOURCE_URL = new URL("../supabase/functions/_shared/clerkAuth.ts", import.meta.url);
const source = readFileSync(SOURCE_URL, "utf8");

globalThis.__clerkAuthTest = { Deno: { env: { get: () => "https://clerk.test.invalid" } } };
let stripped = source.replace(/^import .*;\n/gm, "");
stripped = "const { Deno } = globalThis.__clerkAuthTest;\n" + stripped;
const js = transformSync(stripped, { loader: "ts", format: "esm" }).code;
const { adminFromMembership, displayEmail, resolveIdentity } =
  await import("data:text/javascript;base64," + Buffer.from(js).toString("base64"));
delete globalThis.__clerkAuthTest;

let pass = 0, fail = 0;
const ok = (name, cond) => {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}`); }
};
const eq = (name, got, want) => {
  const same = JSON.stringify(got) === JSON.stringify(want);
  ok(same ? name : `${name}  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`, same);
};

// Synthetic ids and addresses only. Nothing here is a real account.
const PROFILE = "00000000-0000-4000-8000-00000000beef";
const ADMIN_ROW = { profile_id: PROFILE };
// The three addresses the deleted allowlist held. They are literals here so the
// test can prove they no longer buy anything, not because anything reads them.
const ONCE_ALLOWLISTED = [
  "admin@credentialdomd.com",
  "drericwhitney@gmail.com",
  "stormchaser@elryx.com",
];

// ── The allowlist is gone from the source ────────────────────────────────────
// Asserted against the file text, not behaviour, so re-adding the set fails
// here even if someone wires it in somewhere the cases below do not reach.
ok("ADMIN_EMAILS is gone from clerkAuth.ts", !source.includes("ADMIN_EMAILS"));
for (const address of ONCE_ALLOWLISTED) {
  ok(`clerkAuth.ts no longer carries the literal ${address}`, !source.includes(address));
}
ok("no email address is compared for authorization anywhere in the file",
  !/isAdmin\s*:\s*[^,}]*email/i.test(source));
ok("the admin decision reads app_admins", source.includes("app_admins"));

// ── adminFromMembership: the decision itself ─────────────────────────────────
ok("a membership row is admin", adminFromMembership(ADMIN_ROW) === true);
ok("no membership row is not admin", adminFromMembership(null) === false);
ok("undefined (the lookup never ran) is not admin", adminFromMembership(undefined) === false);
ok("an empty array is not admin", adminFromMembership([]) === false);
ok("an array holding a row is admin", adminFromMembership([ADMIN_ROW]) === true);
ok("an array of nulls is not admin", adminFromMembership([null, null]) === false);
ok("false is not admin", adminFromMembership(false) === false);
ok("the empty string is not admin", adminFromMembership("") === false);
ok("zero is not admin", adminFromMembership(0) === false);
ok("an empty object from maybeSingle is still a row, so admin", adminFromMembership({}) === true);
ok("the result is a real boolean, not a truthy row",
  typeof adminFromMembership(ADMIN_ROW) === "boolean" && typeof adminFromMembership(null) === "boolean");

// ── resolveIdentity: the whole decision as clerkProfile makes it ─────────────
// A genuine, fully verified default session token: no email claim at all. It
// must not be admin, and it must not become admin by way of the stored email.
const defaultToken = resolveIdentity(PROFILE, "", "someone@example.invalid", null);
ok("a verified token with no email claim is not admin", defaultToken.isAdmin === false);
eq("...and still reports an address for display", defaultToken.email, "someone@example.invalid");
eq("...and carries the profile id through", defaultToken.profileId, PROFILE);

// The attack the old code allowed: set profiles.email to an allowlisted address
// and send a default session token. Every one of the three must buy nothing.
for (const address of ONCE_ALLOWLISTED) {
  ok(`profiles.email = ${address} does not make an admin (no claim)`,
    resolveIdentity(PROFILE, "", address, null).isAdmin === false);
  ok(`profiles.email = ${address} does not make an admin (claim agrees)`,
    resolveIdentity(PROFILE, address, address, null).isAdmin === false);
  eq(`...and ${address} is still returned as the display label`,
    resolveIdentity(PROFILE, "", address, null).email, address);
}

// Membership is the only thing that grants it, and it grants it regardless of
// what the address says, including no address at all.
ok("membership grants admin with no email anywhere",
  resolveIdentity(PROFILE, "", "", ADMIN_ROW).isAdmin === true);
ok("membership grants admin to an ordinary address",
  resolveIdentity(PROFILE, "physician@example.invalid", "physician@example.invalid", ADMIN_ROW).isAdmin === true);
ok("membership as a one-row array grants admin",
  resolveIdentity(PROFILE, "", "", [ADMIN_ROW]).isAdmin === true);
ok("absence of membership denies admin to that same physician",
  resolveIdentity(PROFILE, "physician@example.invalid", "physician@example.invalid", null).isAdmin === false);
ok("an empty membership result is not admin",
  resolveIdentity(PROFILE, "", "", []).isAdmin === false);

// A failed lookup leaves data null. Denying an admin screen on a transient
// database error is the safe direction; granting one is not.
ok("a failed app_admins lookup denies rather than grants",
  resolveIdentity(PROFILE, "", "someone@example.invalid", null).isAdmin === false);

// ── displayEmail: the label, which is all email is now ───────────────────────
eq("the verified claim wins over the stored column",
  displayEmail("claimed@example.invalid", "stored@example.invalid"), "claimed@example.invalid");
eq("the stored column fills in when there is no claim",
  displayEmail("", "stored@example.invalid"), "stored@example.invalid");
eq("both missing gives the empty string, not undefined", displayEmail("", ""), "");
eq("null inputs do not throw", displayEmail(null, null), "");
eq("undefined inputs do not throw", displayEmail(undefined, undefined), "");
eq("a non-string claim is ignored rather than coerced",
  displayEmail({ address: "oops@example.invalid" }, "stored@example.invalid"), "stored@example.invalid");
eq("the label is lowercased", displayEmail("Mixed@Example.Invalid", ""), "mixed@example.invalid");
eq("whitespace around a claim is trimmed", displayEmail("  spaced@example.invalid  ", ""), "spaced@example.invalid");
eq("a whitespace-only claim falls back to the column",
  displayEmail("   ", "stored@example.invalid"), "stored@example.invalid");

// ══ The CLIENT half of the same allowlist ═══════════════════════════════════
// The server was fixed on 2026-09-15 and the identical three-address Set was
// left behind in src/lib/admin.js, where isAdminUser() matched it against
// [user.email, ...user.emails]. src/context/AppContext.jsx built `emails` from
// clerkUser.emailAddresses with no filter, and Clerk lists a secondary address
// there the moment it is typed, verification.status "unverified", no code ever
// sent. So the reproduction was: sign up (Clerk sign-up is open on the dev
// instance), add admin@credentialdomd.com to your own Clerk profile, reload.
// That did not reach another physician's data -- every server read and write
// asks app_admins -- but App.jsx read the same flag as the INVITE-ONLY gate
// and skipped the invite screen, which is the property the beta is built on.
//
// Read as text, like the section above: the point is that the allowlist is
// gone, not that one particular call happens to return false today.
const adminSrc = readFileSync(new URL("../src/lib/admin.js", import.meta.url), "utf8");
const appSrc = readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
const ctxSrc = readFileSync(new URL("../src/context/AppContext.jsx", import.meta.url), "utf8");

// Comments are stripped first: the file's header names the three addresses on
// purpose, as the description of the defect, and a test that forbade writing
// down what went wrong would be a bad trade.
const codeOnly = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
const adminCode = codeOnly(adminSrc);
ok("ADMIN_EMAILS is gone from src/lib/admin.js too", !adminCode.includes("ADMIN_EMAILS"));
for (const address of ONCE_ALLOWLISTED) {
  ok(`src/lib/admin.js no longer carries the literal ${address}`, !adminCode.includes(address));
}
ok("no address is compared for admin anywhere in the client gate",
  !/@[a-z0-9-]+\.[a-z]{2,}/i.test(adminCode));
ok("and the code does not read an address off the user object either",
  !/user\.email|\.emails\b|emailAddress/.test(adminCode));
ok("the client admin flag comes from the server's own answer",
  adminSrc.includes("unlimited") && adminSrc.includes("aiClient"));

// The Clerk address list must not carry a claim the account holder typed.
ok("AppContext filters Clerk addresses to verified ones",
  /\.filter\(\(e\) => e\?\.verification\?\.status === "verified"\)/.test(ctxSrc));

// The gate itself: access comes from claim_beta_access(), which answers
// 'active' for an app_admins member on the server side, so nothing is lost.
ok("App.jsx has no client-side admin bypass of the invite gate",
  !/isAdminUser\(user\)\s*\)\s*\{\s*setAccess/.test(appSrc) && !/if \(isAdminUser\(/.test(appSrc));
ok("App.jsx decides access from claimBetaAccess and the stored status only",
  /const r = await claimBetaAccess\(\);/.test(appSrc));
ok("the invite screen is still the thing that gate controls",
  /access !== "active"/.test(appSrc));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
