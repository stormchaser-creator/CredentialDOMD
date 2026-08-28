/**
 * One URL validator for every link the app renders from rule data.
 *
 * Rule citations and their source URLs come from a data file that a human
 * edits, so a bad or hostile value has to fail closed: only http(s) links are
 * ever turned into anchors, anything else stays plain text. Shared by
 * RuleProvenance (rule-set level) and TopicProvenance (per-topic level) so the
 * two can never drift apart on what counts as a safe link.
 */
export function safeHttpUrl(u) {
  return typeof u === "string" && /^https?:\/\//i.test(u.trim()) ? u.trim() : "";
}
