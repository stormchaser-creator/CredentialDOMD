import { useApp } from "../../context/AppContext";
import { findStateLicense } from "../../utils/compliance";
import { BOARD_EXEMPTION_FIELD, BOARD_EXEMPTION_STATES } from "../../utils/conditionalCme";
import { localToday } from "../../utils/dateDays";
import { TAP_MIN } from "./actionButton";

const dayLabel = iso => new Date(`${iso}T12:00`).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });

/**
 * A state's CME exemption through board certification. Where the state's
 * rule data names one (conditionalCme.js BOARD_EXEMPTION_STATES) the
 * physician can choose to use it: it is stored on the state license and the
 * engine then counts the total and Category 1 hours as met. Undo removes it.
 * Elsewhere the rule text shows as before, never applied.
 */
export default function BoardExemption({ state, comp, moc }) {
  const { data, editItem, theme: T } = useApp();
  const license = findStateLicense(data.licenses, state);
  const offered = BOARD_EXEMPTION_STATES.includes(state) && !!license;
  const box = { fontSize: 12, color: T.textMuted, backgroundColor: T.accentGlow, borderRadius: 8, padding: "7px 10px", marginTop: 6, marginBottom: 2, lineHeight: 1.4 };
  const btn = (primary) => ({
    padding: "3px 10px", minHeight: TAP_MIN, fontSize: 11, fontWeight: 700, borderRadius: 8, border: "none", cursor: "pointer",
    backgroundColor: primary ? T.accent : T.card, color: primary ? "#fff" : T.accent, marginTop: 6, marginRight: 4,
  });
  const save = (value) => {
    const customFields = { ...(license.customFields || {}) };
    if (value) customFields[BOARD_EXEMPTION_FIELD] = value;
    else delete customFields[BOARD_EXEMPTION_FIELD];
    editItem("licenses", { ...license, customFields });
  };
  if (offered && comp?.boardExemption) {
    return (
      <div style={box} onClick={e => e.stopPropagation()}>
        <span style={{ fontWeight: 700, color: T.accent }}>Using your board certification exemption</span> (chosen {dayLabel(comp.boardExemption.usedOn)}). {moc}. Total and Category 1 hours count as met; topic courses still show above.
        <div><button style={btn(false)} onClick={() => save(null)}>Undo</button></div>
      </div>
    );
  }
  return (
    <div style={box} onClick={e => e.stopPropagation()}>
      <span style={{ fontWeight: 700, color: T.accent }}>You may be exempt.</span> {moc}.{offered ? " Use it if your certification meets this rule." : " Not applied automatically; confirm with the board and claim it on your renewal if it applies."}
      {offered && <div><button style={btn(true)} onClick={() => save(localToday())}>Use my board certification exemption</button></div>}
    </div>
  );
}
