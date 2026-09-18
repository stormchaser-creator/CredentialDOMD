# CredentialDoMD founding offer decision

Owner decision, September 18, 2026:

| Annual founding bundle | USD per physician per year |
| --- | ---: |
| Core | $149 |
| Core + Locum | $245 |

The canonical machine-readable catalog is `supabase/functions/_shared/billingCatalog.mjs`.
The app's public plan grid and Stripe bootstrap use that catalog. There are two
annual offers. No new monthly, freemium, resident, trial, enterprise, or automatic
conversion offers are authorized by this launch decision. Historical tier IDs
remain for existing entitlement compatibility; they are not public purchase options.

**Billing stays off.** The invite-only beta continues with its existing feature
access. There is no beta end date, scheduled charge, or paid presale. These are
planned launch prices. A paid launch requires a later explicit owner decision.
This does not retroactively change any contract already agreed with a customer.

This decision supersedes the $199 flat offer in the August marketing plan and
September 2 cost plan, the older $12/month founding ladder, and all conflicting
sales drafts. Historical analyses retain their original numbers for context and
must not be used as current offers. The current public copy is in `landing/` and
`marketing/physician-faq.md`; archived decks, outreach and research are not approved
launch collateral.

## Cost guardrails to validate before paid launch

Use the realized annual subscription revenue (after discounts/refunds), not an
obsolete list price. At full approved price, the proposed monthly AI targets are:

| Bundle | Revenue / month | 25% warning target | 40% maximum target |
| --- | ---: | ---: | ---: |
| Core | $12.4167 | $3.1042 | $4.9667 |
| Core + Locum | $20.4167 | $5.1042 | $8.1667 |

These are planning targets, not a claim that production currently enforces them.
The production proxy's existing $8/$15 policy is an Anthropic check; Gemini keeps
running, concurrent calls may pass, and metering failures are not a reliable
spending boundary. The separate security-review branch has further reservation
work that must be reviewed before integrating a per-bundle policy. A true total
cap must include both providers and unknown in-flight costs. Store the effective
policy/version on each usage reservation so later price changes do not rewrite
history. Beta access must have an explicit operational budget, not divide zero
revenue into a paid-plan formula or silently remove access.

The September 18 aggregate sample contains only 24 proxy calls across two users,
totaling $0.0632, with no Anthropic rows. This does not capture every possible
direct/BYOK call and cannot establish heavy-user costs or an annual margin. Run
the seven-day measurement protocol before promising profitability at either price.
