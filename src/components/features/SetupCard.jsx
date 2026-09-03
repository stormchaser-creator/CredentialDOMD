import { useState, useEffect } from "react";
import { useApp } from "../../context/AppContext";
import { useSetupState } from "./setup/useSetupState";
import { homeCardForm, ladderState, boardCounts, tier1Regressed, CARD_FORM, LADDER } from "../../utils/setupTasks";

/**
 * The Home card. Five forms, and the physician only ever sees one of them.
 *
 *  A — Tier 1 unfinished: one sentence naming the highest-priority
 *      exposure, one button carrying that task's verb, and a snooze.
 *      Exactly two tap targets plus "Not now", never a list of five things.
 *      What the sentence SAYS depends on how long they have been away: the
 *      ladder in setupTasks moves from the exposure itself, to continuity
 *      with what they last finished, to the cost quantified out of their own
 *      records, to a single cheapest thing after a month. No statistic in it
 *      is invented, and no rung of it is an email.
 *  B — the Protected moment: real numbers from their own file, rendered
 *      once, then tier1DoneAt is stamped and it never replays.
 *  C — Tier 1 done, packet unfinished: one quiet row above the ring.
 *  D — everything resolved, or a regression: a single line of navigation,
 *      never a nag. This is the whole point of gating on tier1DoneAt: an
 *      active physician who adds a dateless record months later gets one
 *      line, not a setup prompt, and the bordered card can never come back.
 */

export default function SetupCard({ onOpenSetup }) {
  const { data, theme: T } = useApp();
  const { setup, snooze, stampTier1Done } = useSetupState();
  const s = data.settings || {};
  const form = homeCardForm(setup);
  const t1 = setup.counts.tier1;
  const t2 = setup.counts.tier2;

  // The moment is held on screen until the physician leaves it, but the
  // stamp lands in the same pass, so a reload can never replay it. That is
  // why the moment is its own three-state latch rather than a read of
  // `form`: the stamp flips form to D immediately.
  const [moment, setMoment] = useState(null); // null | "open" | "done"
  // Adjusting state during render is React's own recommendation for state
  // derived from props (it re-renders before painting, with no extra pass);
  // an effect here would flash the wrong card for one frame and the linter
  // rejects it. The effect below does the OTHER job, the durable stamp.
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

  // Form C: Tier 1 is done, so nothing here is urgent. No border, no bar,
  // one row.
  if (form === CARD_FORM.C) {
    return (
      <button onClick={() => onOpenSetup?.(setup.next?.id || null)} style={{
        display: "flex", alignItems: "center", gap: 8, width: "100%",
        border: "none", background: "transparent", padding: "10px 0", marginBottom: 6,
        cursor: "pointer", textAlign: "left", fontFamily: "inherit",
      }}>
        <span style={{ flex: 1, fontSize: 13.5, fontWeight: 700, color: T.textMuted, fontVariantNumeric: "tabular-nums" }}>
          Packet setup · {t2.done} of {t2.total}
        </span>
        <span style={{ color: T.accent, fontWeight: 700, fontSize: 13.5 }}>Continue {"›"}</span>
      </button>
    );
  }

  // Form D is the terminal state, and it is the only form Home ever shows
  // again once Tier 1 is stamped. Two things it can say: everything is
  // resolved, counted across the whole board rather than Tier 1 alone
  // ("Setup · 15 of 15"), or something that was finished has come undone,
  // named. Either way it is one line of navigation, never a prompt.
  if (form === CARD_FORM.D) {
    const regressed = tier1Regressed(setup);
    const all = boardCounts(setup);
    // Finished means gone. A completed list has nothing to say on a dashboard
    // a physician opens every day, and Setup is still one tap away under More
    // and at the top of the Credentials rail. The line stays only while
    // something is genuinely unfinished or has come undone.
    if (!regressed && all.done >= all.total) return null;
    return (
      <button onClick={() => onOpenSetup?.(regressed?.id || null)} style={{
        display: "flex", alignItems: "center", gap: 8, width: "100%",
        border: "none", background: "transparent", padding: "10px 0", marginBottom: 6,
        cursor: "pointer", textAlign: "left", fontFamily: "inherit",
      }}>
        <span style={{ flex: 1, fontSize: 13.5, fontWeight: 700, color: T.textMuted, fontVariantNumeric: "tabular-nums" }}>
          {regressed ? `Setup: ${regressed.regressionLine}` : `Setup · ${all.done} of ${all.total}`}
        </span>
        <span style={{ color: T.accent, fontWeight: 800 }}>{"›"}</span>
      </button>
    );
  }

  // Form A. Scoped to Tier 1: this card is the Tier 1 card, header, bar and
  // all, so its sentence must never fall through to a packet row when every
  // remaining Tier 1 row happens to be set aside. That is what the "set
  // aside" line below is for.
  const ladder = ladderState(setup, { tier: 1 });

  // A month of being ignored is an answer. The card shrinks to one line
  // offering the cheapest thing left, rather than repeating itself louder.
  if (ladder?.bucket === LADDER.ONE_THING) {
    return (
      <div style={{
        marginBottom: 16, display: "flex", alignItems: "center", gap: 10,
        padding: "10px 12px", borderRadius: 12, backgroundColor: T.card,
        border: `1px solid ${T.border}`,
      }}>
        <span style={{ flex: 1, fontSize: 13, color: T.textMuted, lineHeight: 1.45 }}>{ladder.text}</span>
        <button onClick={() => onOpenSetup?.(ladder.taskId)} style={{
          flexShrink: 0, padding: "8px 14px", borderRadius: 10, border: "none",
          backgroundColor: T.accent, color: "#fff", fontSize: 13, fontWeight: 800, cursor: "pointer",
        }}>{ladder.verb}</button>
      </div>
    );
  }

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

      {ladder && (
        <>
          <div style={{ fontSize: 13.5, color: T.text, lineHeight: 1.5, marginBottom: 12 }}>{ladder.text}</div>
          <button onClick={() => onOpenSetup?.(ladder.taskId)} style={{
            width: "100%", padding: "12px 16px", borderRadius: 12, border: "none",
            backgroundColor: T.accent, color: "#fff", fontSize: 15, fontWeight: 800, cursor: "pointer",
          }}>{ladder.verb}</button>
        </>
      )}

      {/* Everything left is set aside, so there is no next task to name. The
          card still has to say something: a header, a bar and a link with no
          sentence between them reads as a rendering fault. */}
      {!ladder && (
        <div style={{ fontSize: 13.5, color: T.textMuted, lineHeight: 1.5, marginBottom: 4 }}>
          {t1.total - t1.done} {t1.total - t1.done === 1 ? "task is" : "tasks are"} set aside. They are still on the list.
        </div>
      )}

      <button onClick={() => onOpenSetup?.(null)} style={{
        marginTop: 10, border: "none", background: "transparent", padding: 0,
        color: T.accent, fontSize: 13, fontWeight: 700, cursor: "pointer",
      }}>Open setup {"›"}</button>
    </div>
  );
}
