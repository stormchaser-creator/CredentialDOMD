import { useState } from "react";
import { useApp } from "../../context/AppContext";
import { csrCard, csrDeclineEdits, firstDateEdits, licensureDeadlinesFor, nextFixedExpiry, stateCsrRule } from "../../utils/stateDuties";
import { localToday } from "../../utils/dateDays";
import { STATE_CSR_TYPE } from "../../constants/stateControlledSubstance";
import { STATE_NAMES } from "../../constants/states";
import { TAP_MIN, inlineLinkTap } from "./actionButton";

const dayLabel = iso => new Date(`${iso}T12:00`).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });

function useStyles(T) {
  return {
    box: { fontSize: 12.5, color: T.textMuted, lineHeight: 1.5, backgroundColor: T.input, borderRadius: 8, padding: "8px 10px", margin: "8px 0" },
    title: { fontWeight: 700, color: T.text },
    line: { marginTop: 3 },
  };
}

/** The rule's facts: expiry, hard stop, prerequisites (each string carries its own timing), renewal note, recurring step. */
function RuleLines({ rule, fixedNext, s, T }) {
  const link = { fontWeight: 700, color: T.accent, ...inlineLinkTap };
  return <>
    <div style={s.line}>{rule.expiryRule}.{fixedNext ? ` Next by this rule: ${dayLabel(fixedNext)}.` : ""}</div>
    {rule.hardStop && <div style={s.line}>{rule.hardStop}</div>}
    {(rule.prerequisites || []).map((p, i) => <div key={i} style={s.line}>Also required: {p}.</div>)}
    {rule.renewalNote && <div style={s.line}>{rule.renewalNote}</div>}
    {rule.recurringNote && <div style={s.line}>{rule.recurringNote}</div>}
    <div style={s.line}>
      <a href={rule.sourceUrl} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()} style={link}>Source: {rule.agency}</a>
      {rule.renewalUrl && rule.renewalUrl !== rule.sourceUrl && <> {"·"} <a href={rule.renewalUrl} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()} style={link}>Renew</a></>}
    </div>
  </>;
}

/**
 * The state's own controlled substance registration (src/utils/stateDuties.js
 * csrCard): a calm prompt with "Add it" (the add form, prefilled for the
 * physician to confirm) and "I don't prescribe controlled substances here"
 * (stored on the state license, with Undo). Nothing is created for them.
 * With a record on file, the rule is shown beside it.
 */
export function StateCsrPrompt({ state }) {
  const { data, editItem, navigate, theme: T } = useApp();
  const s = useStyles(T);
  const card = csrCard(data, state);
  const btn = (primary) => ({
    padding: "3px 10px", minHeight: TAP_MIN, fontSize: 11, fontWeight: 700, borderRadius: 8, border: "none", cursor: "pointer",
    backgroundColor: primary ? T.accent : T.accentGlow, color: primary ? "#fff" : T.accent, marginTop: 6, marginRight: 6,
  });
  if (!card) return null;
  const { rule } = card;
  const decline = (on) => { for (const rec of csrDeclineEdits(data.licenses, state, on)) editItem("licenses", rec); };
  const stop = e => e.stopPropagation();
  if (card.status === "declined") {
    return <div style={s.box} onClick={stop}>
      You said you do not prescribe controlled substances in {STATE_NAMES[state] || state} ({dayLabel(card.on)}), so the {rule.short} is not asked for.
      <div><button style={btn(false)} onClick={() => decline(null)}>Undo</button></div>
    </div>;
  }
  if (card.status === "on-file") {
    return <div style={s.box} onClick={stop}>
      <span style={s.title}>{rule.name}</span>
      <RuleLines rule={rule} fixedNext={card.fixedNext} s={s} T={T} />
    </div>;
  }
  return <div style={s.box} onClick={stop}>
    <span style={s.title}>{STATE_NAMES[state] || state} issues its own controlled substance registration</span>
    <div style={s.line}>The {rule.name} is separate from your medical license and your DEA registration. {rule.who}.</div>
    <RuleLines rule={rule} fixedNext={card.fixedNext} s={s} T={T} />
    <div>
      <button style={btn(true)} onClick={() => navigate("credentials", "licenses", { sec: "licenses", prefill: card.prefill })}>Add it</button>
      <button style={btn(false)} onClick={() => decline(localToday())}>I don't prescribe controlled substances here</button>
    </div>
  </div>;
}

/**
 * The question a licensure deadline waits on: the physician's first license
 * (or first registration) date in the state, prefilled with the earliest
 * issue date on file for them to confirm or change. Saved on the record
 * (stateDuties.firstDateEdits); nothing is dated until it is.
 */
function FirstDateAsk({ d, place, onSave, s, T }) {
  const btn = (primary) => ({
    padding: "3px 10px", minHeight: TAP_MIN, fontSize: 11, fontWeight: 700, borderRadius: 8, border: "none", cursor: "pointer",
    backgroundColor: primary ? T.accent : T.accentGlow, color: primary ? "#fff" : T.accent, marginTop: 6, marginRight: 6,
  });
  const [day, setDay] = useState(d.suggested || "");
  const today = localToday();
  const ok = /^\d{4}-\d{2}-\d{2}$/.test(day) && day <= today;
  const what = d.from === "csr" ? `When did you first register in ${place}?` : `When were you first licensed in ${place}?`;
  return <>
    <div style={s.line}>
      Due within {d.within} of {d.from === "csr" ? `a new ${place} controlled substance registration` : `your first ${place} license`}.
      {" "}The issue date on a record is often the current term, so the date is not counted from it. {what}
      {d.suggested ? ` Your earliest record shows ${dayLabel(d.suggested)}.` : ""}
    </div>
    <div style={s.line}>
      <input type="date" value={day} max={today} onChange={e => setDay(e.target.value)} aria-label={what}
        style={{ fontSize: 16, padding: "2px 6px", borderRadius: 6, border: `1px solid ${T.border}`, backgroundColor: T.input, color: T.text }} />
      {" "}<button style={btn(true)} disabled={!ok} onClick={() => ok && onSave(day)}>Save</button>
    </div>
  </>;
}

/** One-time topics due within a set time of licensure (stateDuties.js licensureDeadlinesFor). */
export function LicensureDeadlines({ state }) {
  const { data, editItem, theme: T } = useApp();
  const s = useStyles(T);
  const list = licensureDeadlinesFor(data, state);
  if (!list.length) return null;
  const place = STATE_NAMES[state] || state;
  const fromWord = d => d.from === "csr" ? `your first ${place} controlled substance registration` : `your first ${place} license`;
  const save = (d, on) => { for (const rec of firstDateEdits(data.licenses, state, d.from, on)) editItem("licenses", rec); };
  const btn = (primary) => ({
    padding: "3px 10px", minHeight: TAP_MIN, fontSize: 11, fontWeight: 700, borderRadius: 8, border: "none", cursor: "pointer",
    backgroundColor: primary ? T.accent : T.accentGlow, color: primary ? "#fff" : T.accent, marginTop: 6, marginRight: 6,
  });
  const undo = d => <div><button style={btn(false)} onClick={() => save(d, null)}>Undo</button></div>;
  const link = { fontWeight: 700, color: T.accent, ...inlineLinkTap };
  return <>{list.map(d => (
    <div key={d.topic} style={s.box} onClick={e => e.stopPropagation()}>
      <span style={s.title}>{d.topic}, one-time</span>
      {d.status === "due" && <><div style={s.line}>Due {dayLabel(d.due)}, within {d.within} of {fromWord(d)} ({dayLabel(d.anchor)}, as you entered it).</div>{undo(d)}</>}
      {d.status === "past" && <><div style={s.line}>Counted from {fromWord(d)} ({dayLabel(d.anchor)}, as you entered it), it was due {dayLabel(d.due)}. If you completed it, log the course or confirm it on the topic above.</div>{undo(d)}</>}
      {d.status === "outside" && <><div style={s.line}>From {fromWord(d)} ({dayLabel(d.anchor)}, as you entered it), the {d.within} timing for {d.from === "csr" ? "new registrations" : "new licensees"} does not date this for you. The topic above still shows whether it is met.</div>{undo(d)}</>}
      {d.status === "needs-date" && <FirstDateAsk d={d} place={place} onSave={on => save(d, on)} s={s} T={T} />}
      {d.url && <div style={s.line}><a href={d.url} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()} style={link}>Source: {d.cite}</a></div>}
    </div>
  ))}</>;
}

/** Both, for a physician's state card. */
export default function StateDuties({ state }) {
  return <><StateCsrPrompt state={state} /><LicensureDeadlines state={state} /></>;
}

/** Beside a State Controlled Substance record: the state's rule, where one is on file. */
export function CsrRuleNote({ item }) {
  const { data, theme: T } = useApp();
  const s = useStyles(T);
  if (!item || item.type !== STATE_CSR_TYPE) return null;
  if (data?.settings?.degreeType !== "MD" && data?.settings?.degreeType !== "DO") return null;
  const rule = stateCsrRule(item.state);
  if (!rule) return null;
  return <div style={s.box} onClick={e => e.stopPropagation()}>
    <RuleLines rule={rule} fixedNext={nextFixedExpiry(rule)} s={s} T={T} />
  </div>;
}
