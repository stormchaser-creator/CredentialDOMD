import { memo } from "react";
import { useApp } from "../../context/AppContext";
import { safeHttpUrl } from "../../utils/safeUrl";

/**
 * The verification line under one mandated-topic row.
 *
 *   [One time, not every cycle]  Cal. Bus. & Prof. Code § 2190.5 · Source ↗
 *
 * Two things a physician could not previously get off a topic row:
 *
 * 1. PERIODICITY. "12 hrs Pain Management" reads as a recurring demand. In
 *    California it is a one-time career requirement. The chip says which, in
 *    words, on every row.
 *
 * 2. THE RULE ITSELF. The rule set carries one `sourceUrl` for the whole
 *    state, so a physician checking a single line had nothing to click. When
 *    the topic names its own statute the link goes there ("Source"); when it
 *    inherits the rule set's page the link says "Board page", because a
 *    citation that does not point at the sentence stating the requirement
 *    should not pretend it does.
 *
 * Links are validated by the same `safeHttpUrl` RuleProvenance uses and open
 * in a new tab with rel="noopener noreferrer".
 */
function TopicProvenance({ periodLabel, cite, url, sourceInherited, citeInherited }) {
  const { theme: T } = useApp();
  const href = safeHttpUrl(url);
  const oneTime = periodLabel === "One time, not every cycle";
  if (!periodLabel && !cite && !href) return null;

  return (
    <div style={{
      display: "flex", alignItems: "baseline", flexWrap: "wrap", gap: 6,
      fontSize: 11, lineHeight: 1.45, color: T.textDim,
      marginTop: -4, marginBottom: 8, marginLeft: 2,
    }}>
      {periodLabel && (
        <span style={{
          padding: "1px 7px", borderRadius: 999, fontWeight: 700, fontSize: 10.5,
          whiteSpace: "nowrap", flexShrink: 0,
          backgroundColor: oneTime ? T.accentGlow : T.input,
          color: oneTime ? T.accent : T.textMuted,
        }}>{periodLabel}</span>
      )}
      {cite && (
        <span
          title={citeInherited ? "Citation for the whole rule set; no separate citation is on file for this line." : cite}
          style={{ minWidth: 0, wordBreak: "break-word" }}
        >{cite}</span>
      )}
      {href && (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          title={sourceInherited
            ? "Opens the board page for this state's rules, not this specific line."
            : "Opens the primary source for this requirement."}
          style={{ color: T.accent, fontWeight: 700, textDecoration: "underline", whiteSpace: "nowrap", flexShrink: 0 }}
        >{sourceInherited ? "Board page ↗" : "Source ↗"}</a>
      )}
    </div>
  );
}

export default memo(TopicProvenance);
