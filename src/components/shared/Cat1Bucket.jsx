import { memo } from "react";
import { useApp } from "../../context/AppContext";
import ComplianceBar from "./ComplianceBar";
import { cat1BucketLabel, cat1Breakdown, cat1RouteNote } from "../../constants/creditEquivalence";

/**
 * The Category 1 minimum, shown as its own requirement rather than a second
 * bar under Total Hours.
 *
 * Why it is separate: a DO can be at 50 of 50 total hours and 10.25 of 20
 * AOA Category 1-A/1-B, and fail a California audit on the second number. The
 * old bar was labelled "Cat 1-A / AMA Cat 1" for every DO, which for
 * California is the opposite of what the engine counts: California accepts AOA
 * 1-A or 1-B and does not accept AMA PRA Category 1 here at all. The label now
 * comes from the same `cat1Keywords` the engine filtered on, so the words and
 * the math cannot disagree, and the hours that did NOT count are itemised
 * underneath so the gap is legible instead of mysterious.
 */
function Cat1Bucket({ comp, entries, degreeType, onFindCme }) {
  const { theme: T } = useApp();
  if (!comp || !(comp.cat1Required > 0)) return null;

  const accepted = comp.cat1Keywords || [];
  const label = cat1BucketLabel(accepted, degreeType);
  const { counted, notCounted } = cat1Breakdown(entries, {
    start: comp.windowStart,
    end: comp.windowEnd,
    accepted,
    degreeType,
  });
  const route = comp.cat1Met ? null : cat1RouteNote(accepted, degreeType);
  const gap = Math.max(0, comp.cat1Required - comp.cat1Earned);
  const strayHours = notCounted.reduce((s, r) => s + r.hours, 0);

  return (
    <div style={{
      marginTop: 4, marginBottom: 10, padding: "12px 14px", borderRadius: 12,
      border: `1px solid ${comp.cat1Met ? T.border : T.warning}`,
      backgroundColor: comp.cat1Met ? "transparent" : T.warningDim,
    }}>
      <div style={{
        fontSize: 11, fontWeight: 800, letterSpacing: 0.5, textTransform: "uppercase",
        color: comp.cat1Met ? T.textDim : T.warning, marginBottom: 8,
      }}>
        Separate requirement
      </div>

      <ComplianceBar label={label} earned={comp.cat1Earned} required={comp.cat1Required} met={comp.cat1Met} />

      {!comp.cat1Met && (
        <div style={{ fontSize: 13, fontWeight: 700, color: T.warning, marginTop: -4, marginBottom: 6 }}>
          Short {Math.round(gap * 100) / 100} hrs. Total hours will not close this.
        </div>
      )}

      <div style={{ fontSize: 12, color: T.textMuted, lineHeight: 1.5 }}>
        <span style={{ fontWeight: 700, color: T.text }}>Counts here:</span>{" "}
        {accepted.length ? accepted.join(", ") : "not specified by this state's rule"}.
        {counted.length === 0 && " Nothing you have logged in this window carries one of those categories."}
      </div>

      {notCounted.length > 0 && (
        <div style={{ fontSize: 12, color: T.textMuted, lineHeight: 1.5, marginTop: 5 }}>
          <span style={{ fontWeight: 700, color: T.text }}>Does not count here:</span>{" "}
          {notCounted.map(r => `${r.hours} hrs ${r.category} (${r.reason})`).join(", ")}.
          {!comp.noGeneralReq && comp.totalRequired > 0 &&
            ` Those ${Math.round(strayHours * 100) / 100} hours still count toward the ${comp.totalRequired}-hour total above.`}
        </div>
      )}

      {degreeType === "DO" && !comp.cat1FromData && (
        <div style={{ fontSize: 12, color: T.warning, lineHeight: 1.5, marginTop: 5 }}>
          This state's accepted credit types have not been broken out in the rules database yet, so the list above is inferred from the rule wording. Check the citation below before relying on it.
        </div>
      )}

      {route && (
        <div style={{
          marginTop: 8, padding: "8px 10px", borderRadius: 9,
          backgroundColor: T.accentGlow, fontSize: 12, color: T.textMuted, lineHeight: 1.5,
        }}>
          <div style={{ fontWeight: 700, color: T.accent, marginBottom: 2 }}>{route.title}</div>
          <div>{route.body}</div>
          {route.url && (
            <a href={route.url} target="_blank" rel="noreferrer" style={{ color: T.accent, fontWeight: 700, textDecoration: "underline" }}>
              {route.linkLabel}
            </a>
          )}
        </div>
      )}

      {!comp.cat1Met && onFindCme && (
        <button onClick={onFindCme} style={{
          padding: "4px 10px", fontSize: 11, fontWeight: 700, borderRadius: 8, border: "none",
          backgroundColor: T.accentGlow, color: T.accent, cursor: "pointer", marginTop: 8,
        }}>Find Cat 1 CME &rarr;</button>
      )}
    </div>
  );
}

export default memo(Cat1Bucket);
