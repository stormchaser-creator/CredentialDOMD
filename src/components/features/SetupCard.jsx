import { useState, useEffect } from "react";
import { useApp } from "../../context/AppContext";
import { useSetupState } from "./setup/useSetupState";
import { homeCardForm, CARD_FORM } from "../../utils/setupTasks";

/**
 * The Home card. Four forms, and the physician only ever sees one of them.
 *
 *  A — Tier 1 unfinished: one sentence naming the highest-priority
 *      exposure, one button carrying that task's verb, and a snooze.
 *      Exactly two tap targets plus "Not now", never a list of five things.
 *  B — the Protected moment: real numbers from their own file, rendered
 *      once, then tier1DoneAt is stamped and it never replays.
 *  D — Tier 1 finished: a single line of navigation, never a nag. This is
 *      the whole point of gating on tier1DoneAt: an active physician who
 *      adds a dateless record months later gets one line, not a setup
 *      prompt, and the bordered card can never come back.
 */

export default function SetupCard({ onOpenSetup }) {
  const { data, theme: T } = useApp();
  const { setup, snooze, stampTier1Done } = useSetupState();
  const s = data.settings || {};
  const form = homeCardForm(setup);
  const t1 = setup.counts.tier1;

  // The moment is held on screen until the physician leaves it, but the
  // stamp lands in the same pass, so a reload can never replay it. That is
  // why the moment is its own three-state latch rather than a read of
  // `form`: the stamp flips form to D immediately.
  const [moment, setMoment] = useState(null); // null | "open" | "done"
  if (form === CARD_FORM.B && moment === null) setMoment("open");
  useEffect(() => {
    if (form === CARD_FORM.B) stampTier1Done();
  }, [form, stampTier1Done]);

  if (moment === "open") {
    const days = Number(s.reminderLeadDays) || 90;
    return (
      <div style={{
        marginBottom: 20, backgroundColor: T.card, border: `2px solid ${T.accent}`,
        borderRadius: 14, padding: "16px 18px", boxShadow: T.shadow1,
      }}>
        <div style={{ fontSize: 20, fontWeight: 800, color: T.text, marginBottom: 8 }}>Protected.</div>
        <div style={{ fontSize: 14, color: T.textMuted, lineHeight: 1.55, marginBottom: 8 }}>
          Every license and DEA record you have entered carries a date, and a warning goes to {s.email || "your address on file"} {days} days before anything expires.
        </div>
        <div style={{ fontSize: 14, color: T.textMuted, lineHeight: 1.55, marginBottom: 14 }}>
          What is left is packet material. It can wait.
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={() => { setMoment("done"); onOpenSetup?.(null); }} style={{
            flex: 1, padding: "12px 16px", borderRadius: 12, border: "none",
            backgroundColor: T.accent, color: "#fff", fontSize: 14.5, fontWeight: 800, cursor: "pointer",
          }}>See what is left</button>
          <button onClick={() => setMoment("done")} style={{
            flex: 1, padding: "12px 16px", borderRadius: 12, border: `1px solid ${T.border}`,
            backgroundColor: "transparent", color: T.textMuted, fontSize: 14.5, fontWeight: 700, cursor: "pointer",
          }}>Back to Home</button>
        </div>
      </div>
    );
  }

  if (form === CARD_FORM.NONE) return null;

  if (form === CARD_FORM.D) {
    const regression = setup.next?.regressionLine;
    return (
      <button onClick={() => onOpenSetup?.(setup.next?.id || null)} style={{
        display: "flex", alignItems: "center", gap: 8, width: "100%",
        border: "none", background: "transparent", padding: "10px 0", marginBottom: 6,
        cursor: "pointer", textAlign: "left", fontFamily: "inherit",
      }}>
        <span style={{ flex: 1, fontSize: 13.5, fontWeight: 700, color: T.textMuted, fontVariantNumeric: "tabular-nums" }}>
          {regression ? `Setup: ${regression}` : `Setup · ${t1.done} of ${t1.total}`}
        </span>
        <span style={{ color: T.accent, fontWeight: 800 }}>{"›"}</span>
      </button>
    );
  }

  // Form A
  const next = setup.next;
  return (
    <div style={{
      marginBottom: 20, backgroundColor: T.card, border: `2px solid ${T.accent}`,
      borderRadius: 14, padding: "14px 16px", boxShadow: T.shadow1,
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <h3 style={{ fontSize: 15, fontWeight: 800, color: T.text, margin: 0, fontVariantNumeric: "tabular-nums" }}>
          Setup · {t1.done} of {t1.total}
        </h3>
        <button onClick={() => snooze(14)} style={{
          border: "none", background: "transparent", color: T.textDim,
          fontSize: 12, fontWeight: 600, cursor: "pointer",
        }}>Not now</button>
      </div>

      <div style={{ display: "flex", gap: 4, margin: "8px 0 10px" }}>
        {setup.tier1.map((t) => {
          const done = t.status === "done" || t.status === "documented";
          return (
            <div key={t.id} style={{
              flex: 1, height: 5, borderRadius: 3, boxSizing: "border-box",
              backgroundColor: done ? T.accent : T.border,
              border: t.status === "skipped" ? `1px solid ${T.accent}` : "none",
              opacity: t.status === "na" ? 0.35 : 1,
            }} />
          );
        })}
      </div>

      {next && (
        <>
          <div style={{ fontSize: 13.5, color: T.text, lineHeight: 1.5, marginBottom: 12 }}>{next.cardLine}</div>
          <button onClick={() => onOpenSetup?.(next.id)} style={{
            width: "100%", padding: "12px 16px", borderRadius: 12, border: "none",
            backgroundColor: T.accent, color: "#fff", fontSize: 15, fontWeight: 800, cursor: "pointer",
          }}>{next.verb}</button>
        </>
      )}

      <button onClick={() => onOpenSetup?.(null)} style={{
        marginTop: 10, border: "none", background: "transparent", padding: 0,
        color: T.accent, fontSize: 13, fontWeight: 700, cursor: "pointer",
      }}>Open setup {"›"}</button>
    </div>
  );
}
