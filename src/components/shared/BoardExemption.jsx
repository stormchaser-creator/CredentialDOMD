import { useState } from "react";
import { useApp } from "../../context/AppContext";
import { findStateLicense } from "../../utils/compliance";
import {
  BOARD_EXEMPTION_STATES, BOARD_EXEMPTION_CONDITIONS, boardExemptionFields, currentBoardCertificationOnFile,
} from "../../utils/conditionalCme";
import { localToday } from "../../utils/dateDays";
import { TAP_MIN } from "./actionButton";

const dayLabel = iso => new Date(`${iso}T12:00`).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });

/**
 * A state's CME exemption through board certification. Where the state's
 * rule data names one (conditionalCme.js BOARD_EXEMPTION_STATES) and a
 * current board certification is on file, the physician can choose to use
 * it: it is stored on the state license with the license expiration it was
 * chosen for, and the engine counts the total and Category 1 hours as met for
 * that renewal only. A state whose rule is narrower (BOARD_EXEMPTION_CONDITIONS)
 * shows its condition and needs it confirmed first. Undo removes it.
 * Elsewhere the rule text shows as before, never applied.
 */
export default function BoardExemption({ state, comp, moc }) {
  const { data, editItem, theme: T } = useApp();
  const [confirming, setConfirming] = useState(false);
  const [conditionMet, setConditionMet] = useState(false);
  const certCurrent = currentBoardCertificationOnFile(data.licenses);
  if (!certCurrent && !comp?.boardExemption) return null;
  const license = findStateLicense(data.licenses, state);
  const offered = BOARD_EXEMPTION_STATES.includes(state) && !!license?.expirationDate && certCurrent;
  const condition = BOARD_EXEMPTION_CONDITIONS[state] || null;
  const box = { fontSize: 12, color: T.textMuted, backgroundColor: T.accentGlow, borderRadius: 8, padding: "7px 10px", marginTop: 6, marginBottom: 2, lineHeight: 1.4 };
  const btn = (primary, disabled = false) => ({
    padding: "3px 10px", minHeight: TAP_MIN, fontSize: 11, fontWeight: 700, borderRadius: 8, border: "none", cursor: disabled ? "default" : "pointer",
    backgroundColor: primary ? T.accent : T.card, color: primary ? "#fff" : T.accent, marginTop: 6, marginRight: 4, opacity: disabled ? 0.5 : 1,
  });
  const save = (value) => {
    const today = localToday();
    const customFields = boardExemptionFields(license.customFields, state, value, license.expirationDate, value && condition ? today : null);
    editItem("licenses", { ...license, customFields });
    setConfirming(false);
    setConditionMet(false);
  };
  if (offered && comp?.boardExemption) {
    return (
      <div style={box} onClick={e => e.stopPropagation()}>
        <span style={{ fontWeight: 700, color: T.accent }}>Using your board certification exemption</span> (chosen {dayLabel(comp.boardExemption.usedOn)} for the renewal due {dayLabel(license.expirationDate)}). {moc}. Total and Category 1 hours count as met for this renewal; topic courses still show above.
        <div><button style={btn(false)} onClick={() => save(null)}>Undo</button></div>
      </div>
    );
  }
  if (offered && confirming && condition) {
    return (
      <div style={box} onClick={e => e.stopPropagation()}>
        <span style={{ fontWeight: 700, color: T.accent }}>{state} rule:</span> {moc}.
        <label style={{ display: "flex", gap: 8, alignItems: "flex-start", marginTop: 6, color: T.text, minHeight: TAP_MIN, cursor: "pointer" }}>
          <input type="checkbox" checked={conditionMet} onChange={e => setConditionMet(e.target.checked)} style={{ marginTop: 2 }} />
          <span>{condition}</span>
        </label>
        <div>
          <button style={btn(true, !conditionMet)} disabled={!conditionMet} onClick={() => save(localToday())}>Use it for the renewal due {dayLabel(license.expirationDate)}</button>
          <button style={btn(false)} onClick={() => { setConfirming(false); setConditionMet(false); }}>Cancel</button>
        </div>
      </div>
    );
  }
  return (
    <div style={box} onClick={e => e.stopPropagation()}>
      <span style={{ fontWeight: 700, color: T.accent }}>You may be exempt.</span> {moc}.{offered ? " Use it if your certification meets this rule. It applies to this renewal only." : " Not applied automatically; confirm with the board and claim it on your renewal if it applies."}
      {offered && <div><button style={btn(true)} onClick={() => (condition ? setConfirming(true) : save(localToday()))}>Use my board certification exemption</button></div>}
    </div>
  );
}
