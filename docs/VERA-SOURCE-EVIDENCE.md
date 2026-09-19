# Vera source evidence and bounded official-page retrieval

Vera now receives jurisdiction and degree-specific saved references alongside the existing saved-record calculations. Phase 1 is an answer-context improvement, not a re-verification of the rules database. Phase 2 adds an opt-in deployment of bounded official-page retrieval with a new admission migration. Neither phase changes calculator rule values, existing permissions, provider tools, billing flags or action approvals.

## What the answer can establish

- Saved calculations include their exact counting window, its source and whether it is historical, future, current or unanchored. The calculation is not a legal-compliance determination. Unknown applicability remains unknown.
- Rule evidence carries the saved citation, URL, recorded review date and explicit null effective dates when absent. Topic-specific links are distinguished from inherited rule links. A broad rule link is not proof of every topic.
- The existing AZ DO, VT, WA and MO discrepancies are marked for independent review; this does not certify all other rules as correct. Numbers remain the original saved numbers.
- Mentioning a state by name or uppercase abbreviation adds its local references for that turn, including both MD/DO variants when relevant. It does not create a license or infer ownership. The local routing inspects at most three user messages, 12,000 characters each, and selects at most six mentioned jurisdictions. Follow-up context outside this window may require naming the state again.
- New York's zero general-hour total retains its mandated topics. Old `upcoming` notices have unconfirmed timing; their name does not establish that the change remains in the future.
- Renewal answers get the board links and a useful generic checklist. Current fee amounts are omitted until supported by current evidence. The former hardcoded DEA fee and state fee-bearing checklist prose are not included. A saved license expiration is only the date in that saved record. Distinct DO boards use their own route; a missing distinct route remains unknown.
- The public CME center's general source checks retain their recorded dates and narrow review scope. Saved provider descriptions are discovery guidance, not a current course availability, fee, accreditation or state-acceptance guarantee.

The normal chat still sends its selected context to the AI API. This work does not claim that data stays on the device. Phase 1 adds no search tool or external fetch. Phase 2 fetches only fixed public official pages when enabled; it adds no paid search tool or provider key. Both Gemini and Anthropic receive the same source contract, and the existing three prompt blocks and structured action response stay compatible.

## Source maintenance

`scripts/generate-assistant-sources.mjs` copies source metadata from `landing/states/states-data.json` and `public/knowledge/credentialdo-cme.json` into `src/constants/assistantSources.js`. It never derives a verification date from the clock. Run it after reviewed source-data changes; `--check` reports stale output. Existing renewal logistics are consumed from `renewalInfo.js`, whose own generation remains unchanged.

## Validation and limits

Run:

```sh
node scripts/generate-assistant-sources.mjs --check
node --experimental-vm-modules --test tests/assistant-evidence/*.test.mjs
python3 tests/assistant-evidence/postgres-admission.py
node --experimental-vm-modules scripts/ohio-cme.test.mjs
node --experimental-vm-modules scripts/reference-draft.test.mjs
node --experimental-vm-modules scripts/gemini-client.test.mjs
```

Fixtures exercise the actual snapshot and both provider payloads without network: source dates, inheritance, unknown degree, historical windows, unresolved applicability, untracked states, renewal routing, suppressed stale fees, action compatibility and absence of tools. They establish deterministic context and instruction behavior, not a guarantee that every model answer follows every instruction. Current legal questions still need authoritative source checking; a saved review month is not that check. No paid provider evaluation has been run.

## Phase 2 implementation and contract

`POST /functions/v1/vera-sources` accepts exactly `{sourceId}`. Current IDs are `oh-cme-general`, `oh-pain-clinic`, `dea-mate`. There is no raw question, URL, snapshot, attachment, name, license number or user-supplied search query in this request or any official-site request. Local topic/jurisdiction matching selects IDs; unsupported states still receive useful dated saved references. The complete 55-entry state/territory name map is used.

The endpoint verifies a signed Clerk RS256 subject, issuer, expiration/issued-at/max age and authorized-party origin when present. It resolves an active profile by that subject; editable email and admin status never grant access. The service-only admission RPC rechecks the exact active profile/Clerk pair and consumes an atomic **30 requests/account/UTC day, 1,000 requests globally/UTC day** quota, including cache hits and failed fetches. Same-day account deletion/recreation with the same Clerk subject does not reset its counter. Anonymous/authenticated roles cannot call this RPC; all direct table access, including service-role table writes, is revoked.

Only the exact three server registry URLs can be fetched. HTTPS/TLS verification stays on. All redirects are refused, including same-host redirects, until separately reviewed and implemented. Cookies, credentials and referrer are omitted. Responses require HTML/plain text, a **256 KiB streamed byte cap and 6.5-second timeout**. PDFs, error pages, missing expected source markers, oversized bodies and failed TLS return an unavailable result with the official link. HTML becomes inert text; scripts, styles, heads and embedded active content are excluded. Excerpts are plain untrusted strings, never HTML. Extraction can be incomplete and is explicitly labeled selected excerpts only.

Responses carry schema/registry version, canonical URL, jurisdiction/degree, exact original `fetchedAt`, SHA-256 of fetched bytes, and up to three indexed source spans totaling **2,400 characters per page**. Public-only cache entries retain their original timestamp for one hour; failures are cached for one minute. Concurrent reads of a page coalesce within one server isolate. Cross-isolate duplicate fetches remain possible and are bounded by the global admission quota. There is no private content in this cache.

The client validates IDs, exact canonical URLs, registry version, timestamps, digest shape and span bounds. It caps the entire additional provider context to **12,000 UTF-8 bytes**; excessive content falls back to saved references. This is a new-context limit, not a hard total Gemini token/dollar cap. The existing generic Gemini path remains uncapped. Each lookup has one **nine-second deadline starting before Clerk token acquisition and covering transport, streamed body reading, decoding and JSON parsing**. A stalled token returns useful saved-reference guidance; if that token later resolves, no late fetch starts. Pending response readers are cancelled on expiry, and synchronous parsing checks the original deadline before returning evidence. The three lookups run concurrently and have no retry loop. As with browser timers generally, a suspended tab or blocked event loop can delay the callback; expired work is rejected when execution resumes.

Both assistant providers receive the same `currentPublicEvidence`. Optional model `sourceCitations` must identify an available source/excerpt, quote an exact 12–300-character passage and name an exact claim present in the reply. Unsupported IDs, invented passages and absent claims are removed. This validates literal citation binding, not the semantic truth of the model's interpretation. Existing `reply` and `actions` remain compatible. Deterministic source receipts show fetched/cached timestamps, official links and validated passages in live messages and saved archives. These are **unsigned metadata**, not cryptographically authenticated or tamper-proof receipts. The fetched-byte digest is a content identifier, not a signature; the displayed/archived receipt does not retain that digest or the entire fetched page. Receipts never claim legal verification.

### Activation and rollback

All gates are off by default: `VITE_VERA_SOURCE_RETRIEVAL_ENABLED`, edge environment `VERA_SOURCE_RETRIEVAL_ENABLED`, and singleton `vera_source_settings.enabled=false`. No migration has been applied outside the disposable test database. No function has been deployed and no production flags were changed.

Before activation:

1. Review/apply only `20260919193000_vera_source_admission.sql`; inspect its exact hash and permissions. No billing migration or rule changes are prerequisites.
2. Deploy `vera-sources` with the Supabase gateway JWT check disabled because its handler verifies Clerk itself. Use the existing matching Clerk issuer, Supabase URL and service credential; no provider key is required. Verify real signed Clerk/active-profile denial and account relink/revocation at this runtime boundary.
3. Test the three approved URLs using the actual deployed Deno runtime with normal TLS. On 2026-09-19 the local Node fetcher retrieved DEA MATE successfully, but both `codes.ohio.gov` URLs failed with `ERR_TLS_CERT_ALTNAME_INVALID`. Do **not** disable TLS validation or silently substitute a proxy. Treat Ohio as unavailable until the production runtime can verify it, or separately review a correct official replacement.
4. Review actual page excerpt quality, unknown effective dates, current/historical distinctions and the UI receipt on mobile. Run a synthetic account end-to-end, including quota/timeout fallback. Context/transport tests do not guarantee every AI answer obeys instructions; no paid model evaluation was run here.
5. Enable the DB and edge gates, then the frontend flag only after these checks. This activation is independent of billing/support/credential-portal gates, which remain off. Roll back by turning off frontend/edge gates or the DB singleton; all new requests fall back to saved evidence. No records or rules are deleted or changed.

The quota table contains only daily Clerk-subject counters, not questions or medical records. Operators should prune counters older than the agreed retention period using privileged maintenance (suggested 30 days); no scheduled job was created. No customer notification, email, analytics, paid web search or provider call is sent by the fetcher.

### Provider alternatives reviewed on 2026-09-19

- [Google's GenerateContent grounding guide](https://ai.google.dev/gemini-api/docs/generate-content/google-search) returns citation-support spans/chunks but can execute multiple searches and returns required Search Suggestions. It is unsuitable to enable indiscriminately on the current private snapshot. The inspected guide does not establish a hard per-request search count or primary-domain allowlist guarantee.
- [Claude web search](https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool) documents `allowed_domains` and `max_uses`. Those bound domains/search count, not all possible result-input token cost. It would require a dedicated sanitized request, admission accounting and citation validation; the current proxy intentionally forbids client-supplied tools.

Neither provider alternative is enabled here. Fixed official-source fetches make the first retrieval scope reviewable without adding paid search calls or permitting open-ended outbound requests.
