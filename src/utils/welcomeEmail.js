// The welcome email a member receives after their first verified payment
// (owner decision, 2026-09-29).
//
// One module, two readers. Admin > Emails renders the preview the owner
// approves from this file, and the limited-stripe-webhook function sends from
// its generated copy (supabase/functions/_shared/app/utils/welcomeEmail.js,
// written by scripts/sync-shared-app-modules.mjs). The owner's approval is
// bound to welcomeEmailFingerprint(): a SHA-256 over every version of the
// exact subject, sender and body. The database sends only while the
// fingerprint the deployed function presents equals the one the owner
// approved, so any change to a word here stops the email until it is
// approved again in the app (20260929130000_welcome_email.sql).
//
// Which version a member gets is decided by the database from the verified
// first payment (limited_paid_purchase_history), never by this module:
//   founding    $99 founding Credential: Credential and Practice while a member
//   trial       early bird or standard Credential: Credential plus the 30-day
//               Practice trial that payment started
//   bundle      Credential + Practice
//   credential  Credential whose payment started no Practice trial (one per
//               account; a returning member used theirs before)
//
// Plain text only. No em dashes (a test enforces it).

export const WELCOME_EMAIL_VERSION = "2026-09-29-v1";
// The product's Resend sender (send-reminders, build-backup and ticket replies
// use the same address). Replies go to support, where help requests belong.
export const WELCOME_EMAIL_FROM = "CredentialDOMD <whit@credentialdomd.com>";
export const WELCOME_EMAIL_REPLY_TO = "support@credentialdomd.com";
export const WELCOME_EMAIL_SUBJECT = "Welcome to CredentialDOMD";
export const WELCOME_EMAIL_APP_URL = "https://credentialdomd.com/app/";
// The guarantee exactly as the membership offer states it in the app
// (LimitedLaunchMembership.jsx); a test holds the two together.
export const WELCOME_MONEY_BACK = "100% no-hassle money-back guarantee on your most recent annual membership payment, including renewals. Request a refund through Get help in the app or support@credentialdomd.com.";

// The name the preview shows. Synthetic.
export const WELCOME_SAMPLE_NAME = "Jordan";

const MEMBERSHIP = Object.freeze({
  founding: Object.freeze({
    label: "Founding Credential, $99 a year",
    thanks: "Thank you for becoming a founding member.",
    includes: "Your membership includes Credential and Practice for as long as you remain a member.",
  }),
  trial: Object.freeze({
    label: "Early bird or standard Credential, $149 or $199 a year",
    thanks: "Thank you for joining.",
    includes: "Your membership includes Credential, plus a 30-day Practice trial that started with your payment. The trial never charges you or upgrades on its own, and anything you save in Practice stays yours to read and export after it ends.",
  }),
  bundle: Object.freeze({
    label: "Credential + Practice, $245 a year",
    thanks: "Thank you for joining.",
    includes: "Your membership includes both Credential and Practice.",
  }),
  credential: Object.freeze({
    label: "Credential when this account already used its Practice trial",
    thanks: "Thank you for joining.",
    includes: "Your membership includes Credential. If you would like Practice as well, write to support@credentialdomd.com and we will go over the options with you before anything changes.",
  }),
});

export const WELCOME_VARIANTS = Object.freeze(Object.keys(MEMBERSHIP));
export const welcomeVariantLabel = (variant) => MEMBERSHIP[variant]?.label || "";

const STEPS = [
  "Three good first steps:",
  "1. Add a license. Open Credentials and add your state medical license with its expiration date.",
  "2. Upload a document in the app, or email it to docs@credentialdomd.com from the address you sign in with. To send from a different address, confirm it first in Settings, under Email.",
  "3. Set your renewal reminders. Open More, then Settings, turn on Email reminders, and choose how many days ahead you want to hear about an expiration.",
];

const TITLES = /^(dr\.?|doctor|mr\.?|mrs\.?|ms\.?|mx\.?|prof\.?)$/i;
const DEGREES = /^(md|do|mbbs|phd|np|pa|pa-c|rn|crna|dds|dmd|dpm|od)\.?$/i;
const capitalize = (part) => part ? part[0].toUpperCase() + part.slice(1).toLowerCase() : part;

/**
 * The first name to greet, from the name on the profile, or null when there is
 * no usable one ("Dr. Jordan Rivera, MD" -> "Jordan"; "J." -> null). A name
 * typed all in one case is title-cased; any other spelling is kept as typed.
 */
export function welcomeFirstName(name) {
  if (typeof name !== "string") return null;
  const tokens = name.normalize("NFC").replace(/,.*$/s, "").trim().split(/\s+/).filter(Boolean);
  while (tokens.length && TITLES.test(tokens[0])) tokens.shift();
  const first = tokens[0] || "";
  if (!/^\p{L}[\p{L}\p{M}'’-]{1,39}$/u.test(first) || DEGREES.test(first)) return null;
  if (first !== first.toLowerCase() && first !== first.toUpperCase()) return first;
  return first.split(/([-'’])/).map(capitalize).join("");
}

/** The exact message for one member: { from, replyTo, subject, text }. */
export function composeWelcomeEmail({ name = null, variant } = {}) {
  const membership = MEMBERSHIP[variant];
  if (!membership || !Object.hasOwn(MEMBERSHIP, variant)) throw new Error("Unknown welcome email version");
  const first = welcomeFirstName(name);
  const text = [
    first ? `Hi ${first},` : "Hello,",
    `Welcome to CredentialDOMD. ${membership.thanks}`,
    membership.includes,
    ...STEPS,
    "Need help? Use Get help in the app, or write to support@credentialdomd.com.",
    WELCOME_MONEY_BACK,
    `Open the app: ${WELCOME_EMAIL_APP_URL}`,
    "CredentialDOMD",
  ].join("\n\n");
  return Object.freeze({ from: WELCOME_EMAIL_FROM, replyTo: WELCOME_EMAIL_REPLY_TO, subject: WELCOME_EMAIL_SUBJECT, text });
}

/** Every version the owner reviews, greeted with the synthetic sample name. */
export function welcomeEmailPreview(name = WELCOME_SAMPLE_NAME) {
  return WELCOME_VARIANTS.map((variant) => ({ variant, label: MEMBERSHIP[variant].label, ...composeWelcomeEmail({ name, variant }) }));
}

/** The exact content the owner approves: every version, with and without a name. */
export function welcomeEmailCanonical() {
  return JSON.stringify({
    version: WELCOME_EMAIL_VERSION,
    from: WELCOME_EMAIL_FROM,
    replyTo: WELCOME_EMAIL_REPLY_TO,
    subject: WELCOME_EMAIL_SUBJECT,
    bodies: WELCOME_VARIANTS.map((variant) => [variant,
      composeWelcomeEmail({ name: WELCOME_SAMPLE_NAME, variant }).text,
      composeWelcomeEmail({ name: null, variant }).text]),
  });
}

/** SHA-256 (hex) of welcomeEmailCanonical(): what an approval is bound to. */
export async function welcomeEmailFingerprint() {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(welcomeEmailCanonical()));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
