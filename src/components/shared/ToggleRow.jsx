const SWITCH_TAP = { width: 44, height: 36 };

/**
 * A labelled on/off switch row (Settings). The switch is a real switch to a
 * screen reader: role="switch", aria-checked and the row's label as its
 * name, so "Email reminders, on" is read out instead of an unnamed button.
 */
export default function ToggleRow({ label, sub, active, onToggle, color, T }) {
  const on = !!active;
  // The text block shrinks, the switch never does. Without flexShrink: 0 on
  // the switch and minWidth: 0 on the text, a long sub-text squeezed the
  // 44px track to 22px at 375px and the knob rendered past its right edge,
  // half the tap target gone and on hard to tell from off.
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 0", borderBottom: `1px solid ${T.border}` }}>
      <div style={{ flex: 1, minWidth: 0, paddingRight: 12 }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: T.text }}>{label}</div>
        <div style={{ fontSize: 12, color: T.textDim }}>{sub}</div>
      </div>
      {/* The button is the tap target, 44x36 (SWITCH_TAP); the 44x24 track is
          drawn inside it. The track alone was the whole target, under the
          32px every other control on a phone gets (SETTINGS-014). */}
      <button type="button" role="switch" aria-checked={on} aria-label={typeof label === "string" ? label : undefined} onClick={onToggle} style={{ width: SWITCH_TAP.width, minHeight: SWITCH_TAP.height, flexShrink: 0, padding: 0, border: "none", backgroundColor: "transparent", cursor: "pointer", display: "flex", alignItems: "center" }}>
        <span aria-hidden="true" style={{ display: "block", width: 44, height: 24, flexShrink: 0, borderRadius: 12, backgroundColor: on ? color : T.border, position: "relative", transition: "background 0.2s" }}>
          <span style={{ display: "block", width: 18, height: 18, borderRadius: 9, backgroundColor: "#fff", position: "absolute", top: 3, left: on ? 23 : 3, transition: "left 0.2s", boxShadow: "0 1px 3px rgba(0,0,0,0.2)" }} />
        </span>
      </button>
    </div>
  );
}
