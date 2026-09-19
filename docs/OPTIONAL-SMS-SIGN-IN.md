# Optional text-message sign-in — staged, off

The client option is **off by default**. This source change does not enable Clerk SMS, buy a plan, send a message, create/relink users, or change authentication permissions. `VITE_SMS_SIGN_IN_ENABLED` must equal the string `true` at build time; missing, `false`, or any other value preserves the existing email-code interface. The current GitHub Pages workflow leaves this optional setting absent, which keeps it off.

## What changes after configuration

- The alternate-method action becomes **Use a sign-in code instead**. Clerk displays the methods available for that account. Our old email auto-click helper is disabled so the choice remains visible; email/password remains available.
- Signed-in Settings gains **Sign-in methods** > **Manage sign-in methods**, opening Clerk's prebuilt account UI. The user adds a mobile number and verifies ownership there. No number is read from, copied into, or trusted from the physician-profile contact phone.
- The card shows text sign-in as available only for a verified Clerk phone that is not reserved for two-step verification. An MFA-only number gets separate guidance; the client never changes its reservation or disables MFA.
- The same Clerk user ID and Supabase profile continue to own all records. The button checks that the Clerk account has not changed before opening. No phone-only signup, migration, account merge, new user creation, or service-role verification bypass is added.

## Configure and verify before enabling the client

Use the Clerk application and instance that already serve the deployed app. The current invite beta uses an existing development instance. Keep those identities; do not move to the separate production instance to add SMS. Verify the frontend instance and configured backend issuer without changing identity infrastructure. No instance IDs, keys, or user inventory belong in this public runbook.

1. **Environment and allowance:** development supports phone authentication without a paid production upgrade. Clerk's current test documentation exempts US SMS from the development monthly allowance; other non-exempt SMS deliveries have a 20-message monthly allowance. Country/provider rate and abuse limits still apply; this is not an unlimited-delivery guarantee. For a future production rollout, SMS needs a paid plan: current pricing lists Pro at $20/month billed annually and US/Canada SMS at $0.01/message. Confirm the actual quote and obtain approval for any purchase. Production cutover is separate work that must preserve existing account identity and records.
2. **User & authentication > Phone:** enable **Sign-in with phone**. Keep phone sign-up/required-phone enrollment off for this rollout. Keep the current email sign-up, verified-email and sign-in settings, password choices, invitations/access restrictions, and existing users intact. Do not enable required SMS MFA: it is a second factor, not this optional alternative.
3. **SMS > Settings:** enable only needed destinations (US initially; Canada if required). Preserve existing bot/rate-limit and enumeration controls. Review usage and failed deliveries in SMS logs.
4. **User model / account management:** inspect existing account-deletion, username, email-change and connected-account behavior. The client visually hides the danger/username sections and API-key page to keep this entry focused; styling is **not** authorization and does not replace provider permissions. Do not alter unrelated live permissions just to expose the account UI. Confirm the actual SDK rendering respects these display options and that existing confirmation/reverification flows still work. If it exposes an unrelated destructive action or reveals broken account cleanup, keep the client flag off until that concrete issue is resolved or use narrower enrollment.
5. **Development test:** use a separate development instance and synthetic account. Enable phone sign-in there and verify prebuilt UserProfile shows phone enrollment while unwanted sections stay absent. Current SDK is `@clerk/clerk-react` 5.61.6; no SDK upgrade is required. Do not copy newer Core 3 custom-flow APIs into this branch.
6. **Existing-account enrollment:** sign in with an existing method, open the account UI, add a user-controlled number and complete Clerk verification. Keep the existing email. Confirm Clerk subject, Supabase profile, and records remain unchanged when signing back in with the text code. Do not add a separate phone-only account or mark a profile contact number verified through an admin API.
7. **Client activation:** after configuration and tests, add the reviewed `VITE_SMS_SIGN_IN_ENABLED` workflow value as `"true"` and rebuild/deploy. The current workflow does not pass a GitHub secret for this setting; adding a secret alone does not enable the feature. For local development use `VITE_SMS_SIGN_IN_ENABLED=true npm run dev` with the development Clerk instance. The UI flag alone cannot enable SMS at Clerk.

Changing an existing production authentication setting or sending a real text is separate from preparing/reviewing this branch. No such change is claimed here.

## Verification

Local checks:

```sh
node --test scripts/sign-in-methods.test.mjs
VITE_SMS_SIGN_IN_ENABLED=false npm run build:site
VITE_SMS_SIGN_IN_ENABLED=true npm run build:site
```

The source tests cover rollout off/on, signed-out/loading states, only verified Clerk phones being recognized, MFA-only and mixed phone lists, no send or MFA change on render, same-account opening, switched sessions, and safe SDK errors. They mock Clerk and cannot prove live delivery or provider permission settings.

Provider/browser checks before activation:

- An email-only account still logs in without adding a phone; the alternate-method picker does not auto-send email or imply a phone exists.
- Add/verify a phone while signed in; test correct, incorrect/expired codes, resend cooldown, cancellation, duplicate phone, unsupported country, and removal/replacement.
- A verified phone signs into the same account with the same records/access. Email remains usable after removal or loss of the phone.
- A number reserved for MFA does not produce the optional text-sign-in promise. With both an MFA number and a verified sign-in number, the card recognizes the sign-in number without changing either enrollment.
- Phone-only signup remains unavailable; beta invitation matching still uses verified email. Confirm the account UI does not expose deletion, username enrollment, or API-key creation.
- Test mobile Safari/PWA layout, keyboard and code autofill. Use authorized numbers for real delivery checks; never log OTPs.
- Use fictional Clerk test numbers only in development test mode. Do not enable test mode in production. The frontend can display “verified phone” only from Clerk's verification state, never from local profile fields.

## Rollback

Set the client flag back to `false` and rebuild to remove the new affordance and restore the previous email-code interface. This does not remove verified phone numbers or disable an authentication method at Clerk. Provider rollback needs a separate decision after checking whether users rely on that method. Preserve their existing email access and never delete/recreate accounts as a rollback.

## Official sources reviewed September 19, 2026

- [Clerk authentication options](https://clerk.com/docs/guides/configure/auth-strategies/sign-up-sign-in-options) — provider configuration, user permissions and country allowlist.
- [Add and verify a phone](https://clerk.com/docs/guides/development/custom-flows/account-updates/add-phone) — enrollment requires verification; sign-in with phone alone enables this capability.
- [Prebuilt SignIn](https://clerk.com/docs/react/reference/components/authentication/sign-in) and [UserProfile](https://clerk.com/docs/js-frontend/reference/components/user/user-profile) — dashboard-controlled methods and account UI.
- [Pricing](https://clerk.com/pricing), [test-mode limits](https://clerk.com/docs/guides/development/testing/test-emails-and-phones), [API rate limits](https://clerk.com/docs/guides/how-clerk-works/system-limits), [SMS delivery events](https://clerk.com/docs/guides/dashboard/logs/sms-delivery-events).
