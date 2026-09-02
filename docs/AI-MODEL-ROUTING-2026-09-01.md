# AI model routing

Policy set 2026-09-01: **Claude Opus for the work that reasons over rules with money or a
record on it; Gemini for extraction and basics.** Every Opus path falls back to Gemini
when Opus is unavailable (not enabled for the account, daily cap, key rejected, network),
so no feature dead-ends on the Opus key.

| Surface | Module | Model | Why |
|---|---|---|---|
| Vera (assistant) | `src/utils/assistant.js` | Opus, Gemini fallback | Multi-turn reasoning over the physician's whole record |
| RVU coder (dictation to CPT) | `src/utils/cptCoder.js` | Opus by default, Gemini fallback or by choice | Bundling and modifier decisions move real money; harness: Opus 5/5 on the ground-truth case |
| Case-log dictation | `src/utils/caseDictation.js` | Opus by default, Gemini fallback or by choice | Same construct rules and CPT assignment as the coder |
| Document scanner (license, DEA, board, CV) | `src/utils/documentScanner.js` | Gemini | Field extraction from an image or PDF |
| CME transcript import | `src/utils/cmeImport.js` | Gemini | Table extraction, then deterministic topic matching in code |
| Work-log dictation (hours, call, shifts) | `src/utils/workDictation.js` | Gemini | Dates and numbers, no clinical judgment |
| CPT code search (type-ahead lookup) | `src/utils/cptAILookup.js` | Gemini | Quick catalog lookup the physician confirms by hand |

## How the choice is made

- `settings.coderModel` drives both the RVU coder and case-log dictation. Unset means Opus.
  The Settings picker ("Code RVUs with") lets a physician choose Gemini explicitly.
- `anthropicAvailable(settings)` in `src/utils/aiClient.js` decides whether Opus is reachable:
  the physician's own device-local Anthropic key first, then the shared key through the
  `ai-proxy` edge function (Clerk-authenticated, per-provider daily cap, hardened envelope).
- Opus calls run with thinking disabled and a JSON-only contract. Opus 5 rejects
  `temperature`, so thinking off is the determinism knob.
- Vera is the exception: adaptive thinking stays on at effort `low`, and her system prompt is
  three cached blocks (rulebook, renewal reference for the physician's states, record snapshot),
  so a turn re-bills only the conversation itself. Case-log dictation caches its rules and
  template the same way; its Gemini prompt is byte-identical to what shipped.
- The RVU coder tells the physician in the review when Gemini coded a case and why Opus did
  not. Case-log dictation falls through silently: the draft opens prefilled for review either
  way and is never saved without the surgeon's confirmation.

## Daily caps (per user, UTC day, admins unlimited)

| Provider | Setting | Default |
|---|---|---|
| Gemini | `AI_DAILY_LIMIT` on ai-proxy | 200 |
| Anthropic | `ANTHROPIC_DAILY_LIMIT` on ai-proxy | 60 |

A physician who adds their own key for either provider in Settings is billed on that key
and skips the shared cap for that provider.

## Monthly dollar budget (per user, UTC calendar month, admins unlimited)

Since 2026-09-02 every proxied call carries the model, the vendor's token counts and a
`cost_usd` at list price (docs/AI-PROXY.md, Metering). Both providers sum into one figure.

| Line | Setting | Default | Effect |
|---|---|---|---|
| Soft | `AI_BUDGET_SOFT_USD` on ai-proxy | $8 | Settings > AI shows a warning |
| Hard | `AI_BUDGET_HARD_USD` on ai-proxy | $15 | Anthropic path answers 429 `budget`; Vera, the RVU coder and case-log dictation run on Gemini until the 1st. Gemini is never blocked by the budget. |

The daily call caps above stay as a backstop under the dollars. The RVU coder's review note
and Vera's reply both say "The monthly AI budget is used up, so Gemini answered." on that 429.
