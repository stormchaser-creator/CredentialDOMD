# Vera reference drafting repair

## Verified failure
The owner asked for saved professional references, excluding two named people. Live read-only investigation confirmed the three remaining records had both email and phone, while Vera said they were missing. `buildSnapshot` intentionally included only ID/name/specialty/institution; the old system prompt incorrectly described that as the complete database.

## Repair
Vera selects reference IDs. The client resolves saved contact details and renders a reviewable draft with inclusion checkboxes, Copy, and Open in email. This does not send mail. Contact text stays outside generated conversation text, assistant cloud logs, archive metadata and provider-bound selection history. The existing snapshot fields are unchanged. User-supplied chat text and attachments retain their existing transport behavior.

Exclusions carry forward across long conversations, dismissed cards and restored archives. Returned actions merge against the current UI state to preserve checkbox edits made during an in-flight response. Re-inclusion requires a specific restore action or the user's checkbox change. Missing/stale records are shown honestly and stale selections block sharing.

Individual reference copy/email/text now contain the reference's contact block, without the physician's NPI, generic credential verification boilerplate, private notes or clipboard instructions. Native share keeps concise one-line reference facts for the existing iOS Mail behavior; actual iOS native share has not been exercised in this desktop session.

Integrated on top of the ticket worker's `6b8f3f5d` multiple-reference sharing change, preserving its selection UI and ordinary credential formatting. Its new native multi-share summary omitted contact details; the combined repair now uses the same local reference formatter for every selected reference and logs no successful share after cancellation or failure. Desktop copy fallback is reported as copy, not sent.

## Validation
- `node --experimental-vm-modules scripts/reference-draft.test.mjs`: synthetic records, exact contact content, exclusions, empty/stale/incomplete selections, long history, dismissed/archive history, reference and ordinary credential formatting, email body, and intercepted Gemini/Anthropic request bodies.
- Scoped ESLint for the reference modules/components and `git diff --check`: clean. App.jsx retains 2 existing errors/1 warning (baseline main had 6/1); the modified sharing block has no lint findings.
- Production `npm run build:site`: passes (existing bundle-size/SDK warnings).
- Local Chrome UI: inclusion checkbox updates draft and email body; excluded records absent; Copy reports success. No real contact data or emails used in tests.
- Independent Codex reviewer found/fixed exclusion lifetime and response-race issues; subsequent review found no blockers.
- Claude reviewed the staged hotfix read-only and reported no blockers on 2026-09-18.

This is a targeted client repair; billing and backend activation are unchanged. The test provider transports are intercepted, not a live model evaluation.
