# Clerk production cutover, status 2026-08-19

## Done (live now, nothing user-visible changed yet)
- Production instance created: `ins_3I9P0BiOKvCSjotJZvY5sedZXX8`, domain credentialdomd.com, cloned from dev (email-code sign-in carried over).
- Production Frontend API: `https://clerk.credentialdomd.com`, certificate issued, JWKS live (HTTP 200).
- Publishable key captured: `pk_live_Y2xlcmsuY3JlZGVudGlhbGRvbWQuY29tJA`.
- DNS (Cloudflare, DNS-only): clerk, accounts, clkmail, clk._domainkey, clk2._domainkey -> Clerk targets. All resolving.
- Supabase third-party auth: production issuer `https://clerk.credentialdomd.com` registered ALONGSIDE dev, so both token types are accepted until the switch.
- `supabase` JWT template exists on production (cloned).
- CSP in src/main.jsx allows the production host (also still allows dev).
- DB: `lock_profile_identity` now lets privileged callers (no JWT / service role) change auth_user_id; user tokens still frozen. Verified both ways.
- `scripts/clerk-relink.mjs`: dry-run by default, matches production users to profiles by VERIFIED email, moves storage objects, never guesses.

## Remaining, in order
1. Webhook on production: endpoint `https://hkpnnsjcwprrwobmpqyy.supabase.co/functions/v1/clerk-webhook`, events user.created / user.updated / user.deleted. Copy its signing secret to the Supabase secret CLERK_WEBHOOK_SECRET.
2. Secret key: production `sk_live_...` (Clerk > Configure > API keys). Needed only by the re-link script. Never goes in the repo.
3. Set `CLERK_ISSUER=https://clerk.credentialdomd.com` on the edge functions (they default to the dev host).
4. GitHub secret `VITE_CLERK_PUBLISHABLE_KEY` -> the pk_live value; push to main to rebuild.
5. Eric signs up on production with stormchaser@elryx.com (same email); run the re-link; same for Fowler and anyone else.
6. Optional: Google sign-in (needs a Google OAuth client; Clerk > SSO connections).

## Rollback
Set the GitHub secret back to pk_test and push. Dev issuer is still registered, dev instance still exists, profiles re-linked to prod ids can be re-linked back with the same script logic.
