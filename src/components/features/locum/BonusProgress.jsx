import { memo, useMemo } from "react";
import { useApp } from "../../../context/AppContext";
import { formatDate, localDay } from "../../../utils/helpers";
import { isArchived } from "../../../utils/contractsForDate";
import {
  bonusProgress, hasBonusTerms, bonusPeriodLabel, bonusMoney, bonusWRVU, BONUS_ESTIMATE_NOTE,
} from "../../../utils/bonusTracking";

/**
 * BonusProgress: where one agreement stands against its bonus terms.
 *
 * Logged wRVUs in the current period against the target (number, percent and
 * bar) and the estimated bonus on them. The numbers are utils/bonusTracking's;
 * this only draws them. A figure is shown only when its terms are set:
 *
 *   target and rate   progress and the estimated bonus ($0.00 below the target)
 *   target only       progress, and a prompt for the rate instead of a bonus
 *   rate only         a prompt for the target, no number at all
 *   neither           a prompt to add the terms (or nothing, with `quiet`)
 *
 * `onAddTerms` opens the agreement for editing; without it the prompt says
 * where the terms are entered. `title` names the agreement on the dashboard.
 */
function BonusProgress({ contract, title = null, onAddTerms = null, quiet = false, today = null }) {
  const { data, theme: T } = useApp();
  const day = today || localDay();
  const p = useMemo(() => bonusProgress(contract, data.encounters, day), [contract, data.encounters, day]);

  if (p.status === "none" && quiet) return null;

  const box = { backgroundColor: T.input, borderRadius: 10, padding: "12px 12px" };
  const small = { fontSize: 12.5, color: T.textMuted, lineHeight: 1.5 };
  const addButton = (label) => onAddTerms && (
    <button onClick={onAddTerms} style={{ marginTop: 8, padding: "8px 12px", minHeight: 32, borderRadius: 8, border: "none", backgroundColor: T.accentDim, color: T.accent, cursor: "pointer", fontSize: 13, fontWeight: 700 }}>{label}</button>
  );
  const heading = title && <div style={{ fontSize: 14, fontWeight: 700, color: T.text, marginBottom: 6 }}>{title}</div>;
  const where = onAddTerms ? "" : " Edit the agreement to add it.";

  if (p.status === "none") {
    return (
      <div role="group" aria-label="Bonus tracking" style={box}>
        {heading}
        <div style={small}>No bonus terms on this agreement yet. Add a wRVU target and a $ per wRVU rate to see your progress and an estimated bonus.{onAddTerms ? "" : " Edit the agreement to add them."}</div>
        {addButton("Add bonus terms")}
      </div>
    );
  }

  if (p.status === "needs-target") {
    return (
      <div role="group" aria-label="Bonus tracking" style={box}>
        {heading}
        <div style={small}>This agreement has a rate of {bonusMoney(p.rate)} per wRVU but no wRVU target. Add the target to see your progress and an estimated bonus.{where}</div>
        {addButton("Add the wRVU target")}
      </div>
    );
  }

  const reached = p.over > 0 || p.remaining === 0;
  const barColor = reached ? (T.success || "#22c55e") : T.accent;
  return (
    <div role="group" aria-label="Bonus tracking" style={box}>
      {heading}
      <div style={{ fontSize: 12, color: T.textMuted, marginBottom: 6 }}>{bonusPeriodLabel(p.window, formatDate)}</div>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
        <div style={{ fontSize: 15, fontWeight: 800, color: T.text, fontVariantNumeric: "tabular-nums" }}>
          {bonusWRVU(p.logged)} <span style={{ fontWeight: 600, color: T.textMuted }}>of {bonusWRVU(p.target)} wRVU</span>
        </div>
        <div style={{ fontSize: 15, fontWeight: 800, color: barColor, fontVariantNumeric: "tabular-nums" }}>{p.percent}%</div>
      </div>
      <div role="progressbar" aria-label="wRVUs logged toward the target" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(100, p.percent)}
        aria-valuetext={`${bonusWRVU(p.logged)} of ${bonusWRVU(p.target)} wRVU, ${p.percent}%`}
        style={{ height: 8, borderRadius: 999, backgroundColor: T.border, overflow: "hidden", marginTop: 8 }}>
        <div style={{ width: `${(p.fill * 100).toFixed(2)}%`, height: "100%", borderRadius: 999, backgroundColor: barColor }} />
      </div>
      <div style={{ ...small, marginTop: 6 }}>
        {p.window.upcoming
          ? "This bonus period has not started yet."
          : reached
            ? (p.over > 0 ? `${bonusWRVU(p.over)} wRVU above the target.` : "Target reached.")
            : `${bonusWRVU(p.remaining)} wRVU to go.`}
      </div>

      {p.status === "ready" ? (
        <div style={{ marginTop: 10, paddingTop: 10, borderTop: `1px solid ${T.border}` }}>
          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8 }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: T.text }}>Estimated bonus</span>
            <span aria-label="Estimated bonus amount" style={{ fontSize: 17, fontWeight: 800, color: T.text, fontVariantNumeric: "tabular-nums" }}>{bonusMoney(p.bonus)}</span>
          </div>
          <div style={{ ...small, marginTop: 2 }}>
            {p.over > 0 ? `${bonusWRVU(p.over)} wRVU above the target × ${bonusMoney(p.rate)} per wRVU. ` : `${bonusMoney(p.rate)} per wRVU above the target. `}
            {BONUS_ESTIMATE_NOTE}
          </div>
        </div>
      ) : (
        <div style={{ marginTop: 10, paddingTop: 10, borderTop: `1px solid ${T.border}` }}>
          <div style={small}>Add the $ per wRVU rate to see an estimated bonus.{where}</div>
          {addButton("Add the $ per wRVU rate")}
        </div>
      )}

      {p.unassigned > 0 && (
        <div style={{ ...small, marginTop: 8 }}>
          {bonusWRVU(p.unassigned)} wRVU logged in this period {p.unassigned === 1 ? "has" : "have"} no agreement picked, so {p.unassigned === 1 ? "it is" : "they are"} not counted here. Open the entry on the RVUs tab to pick one.
        </div>
      )}
    </div>
  );
}

export default memo(BonusProgress);

/**
 * BonusOverview: the Practice dashboard's bonus card. One BonusProgress per
 * active agreement that carries bonus terms; with none, a single prompt that
 * leads to Contracts. Archived agreements are left out.
 */
export const BonusOverview = memo(function BonusOverview({ onOpenContracts = null, today = null }) {
  const { data, theme: T } = useApp();
  const active = (data.locumContracts || []).filter(c => !isArchived(c));
  const tracked = active.filter(hasBonusTerms);
  return (
    <section aria-label="Bonus progress" style={{ backgroundColor: T.card, border: `1px solid ${T.border}`, borderRadius: 14, padding: "14px 16px", marginBottom: 16, boxShadow: T.shadow1 }}>
      <h3 style={{ margin: "0 0 8px", fontSize: 15, fontWeight: 800, color: T.text }}>Bonus progress</h3>
      {tracked.length === 0 ? (
        <div>
          <div style={{ fontSize: 13, color: T.textMuted, lineHeight: 1.5 }}>
            {active.length === 0
              ? "Add an agreement with its wRVU target and $ per wRVU rate, and your logged wRVUs will show here against the target with an estimated bonus."
              : "Add a wRVU target and a $ per wRVU rate to an agreement, and your logged wRVUs will show here against the target with an estimated bonus."}
          </div>
          {onOpenContracts && (
            <button onClick={onOpenContracts} style={{ marginTop: 10, padding: "8px 12px", minHeight: 32, borderRadius: 8, border: "none", backgroundColor: T.accentDim, color: T.accent, cursor: "pointer", fontSize: 13, fontWeight: 700 }}>
              {active.length === 0 ? "Go to Contracts" : "Add bonus terms in Contracts"}
            </button>
          )}
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {tracked.map(c => (
            <BonusProgress key={c.id} contract={c} title={c.shortName || c.facility || "Agreement"} onAddTerms={onOpenContracts} today={today} />
          ))}
        </div>
      )}
    </section>
  );
});
