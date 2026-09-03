import { memo, useCallback, useMemo, useState } from "react";
import { useApp } from "../../context/AppContext";
import NpiPanel from "./setup/NpiPanel";
import { generateId } from "../../utils/helpers";
import { fetchPublicRecord } from "../../utils/publicRecordApi";
import {
  markAlreadyOnFile, markPlanLocks, planLockNote,
  groupFindings, defaultSelectedIdsForFocus, isSelectable,
  leadNote, needsLabel, evidenceLine, replacesLine, joinWords,
  countSelected, countPreviewHidden, PREVIEW_ROWS, buildSavePlan, savedSummary,
  retrySources, failedSourceNames, mergeEnvelopes,
  FOCUS_COPY, focusSectionKey, splitGroups, countPickable,
} from "../../utils/publicRecord";

/**
 * What the public registers say about this physician, and a tick box beside
 * each line.
 *
 * The lookup itself lives in supabase/functions/public-record and returns
 * proposals only. This screen is the accepting half, and it is the reason the
 * feature is honest rather than dangerous:
 *
 *  - Nothing is written until a row is ticked and Save is pressed. There is
 *    no import-all button and there never should be.
 *  - Every row names the register it came from and links to it.
 *  - A lead (a hospital Medicare derived from claims, a paper matched on a
 *    name) starts unticked and carries the sentence that says why it is a
 *    lead. A privilege is never given a status and never given a date.
 *  - A record already on file is greyed, labelled, and cannot be ticked.
 *  - So is a row whose section this plan keeps shut. It is still shown and
 *    still named: a register found it, and the screen never pretends
 *    otherwise.
 *  - A profile row that would overwrite an answer the physician already gave
 *    starts unticked, says so, and names the values it would replace.
 *  - A long group draws its first PREVIEW_ROWS rows and folds the rest. A
 *    tick sitting past the fold is counted on the fold's own button and again
 *    in the footer, so Save never quietly stands for a row the screen did not
 *    draw.
 *  - Saving goes through updateSettings and addItem, so every accepted row
 *    syncs exactly the way a hand-typed one does.
 *
 * Phone first. Above 1024px the groups sit two across; below it nothing about
 * the layout changes.
 *
 * Props:
 *  - onSaved(count)     fired after the accepted rows are written
 *  - onClose()          optional; renders a Close button when given
 *  - focusSection       an app section ("education", "workHistory",
 *                       "privileges", "publications"): the screen opens
 *                       pointed at that section, and everything else the
 *                       same search found sits one tap away rather than
 *                       being dropped
 */
function PublicRecordReview({ onSaved, onClose, focusSection = "" }) {
  const { data, addItem, updateSettings, theme: T, isDesktop, isPro } = useApp();
  const focus = focusSectionKey(focusSection);
  const focusCopy = focus ? FOCUS_COPY[focus] : null;
  // Stable identity: the dedupe memo and the lookup callback both take it.
  const s = useMemo(() => data.settings || {}, [data.settings]);

  const [phase, setPhase] = useState("start");   // start | loading | review | saved
  const [envelope, setEnvelope] = useState(null);
  const [selected, setSelected] = useState([]);
  const [error, setError] = useState("");
  const [retrying, setRetrying] = useState(false);
  const [expanded, setExpanded] = useState({});   // section -> show every row
  const [openDetail, setOpenDetail] = useState({}); // finding id -> show the register's own wording
  const [saved, setSaved] = useState(null);
  // Opened on one section, the rest of the search is folded rather than
  // thrown away.
  const [showRest, setShowRest] = useState(false);

  const npi = String(s.npi || "").replace(/\D/g, "");
  const hasNpi = npi.length === 10;

  // Marked against what is on file right now, not at fetch time: a license
  // saved in another tab must not be offered again here.
  const findings = useMemo(
    () => markPlanLocks(markAlreadyOnFile(envelope?.findings || [], data, s), { isPro }),
    [envelope, data, s, isPro],
  );
  const groups = useMemo(() => groupFindings(findings), [findings]);
  const { focused: focusGroups, rest: restGroups } = useMemo(
    () => splitGroups(groups, focus),
    [groups, focus],
  );
  const restPickable = countPickable(restGroups);
  // Ticks sitting in a group that is folded shut. Zero unless the physician
  // opened the fold, ticked something, and closed it again.
  const hiddenTicked = (focus && !showRest)
    ? countSelected(restGroups.flatMap((g) => g.findings), selected)
    : 0;
  const selectedCount = countSelected(findings, selected);
  // Ticks sitting past a group's own "Show the other" button. A section is
  // seeded whole, so a physician licensed in eight states arrives with eight
  // ticks in a group that draws six. The footer says so rather than letting
  // Save stand for two rows the screen never drew.
  const previewHidden = countPreviewHidden(
    (focus ? focusGroups : groups).concat(focus && showRest ? restGroups : []),
    selected, expanded,
  );
  const failed = envelope ? failedSourceNames(envelope) : [];

  const run = useCallback(async (sources) => {
    const isRetry = Array.isArray(sources) && sources.length > 0;
    if (isRetry) setRetrying(true); else { setPhase("loading"); setError(""); }
    const res = await fetchPublicRecord({ npi, name: s.name || "", sources });
    if (isRetry) setRetrying(false);
    if (!res.ok || !res.envelope) {
      setError(res.message);
      // A failed re-search must not throw away the findings already on
      // screen; only a first search has nothing to fall back to.
      if (!isRetry) setPhase(envelope ? "review" : "start");
      return;
    }
    if (isRetry) {
      setEnvelope((prev) => (prev ? mergeEnvelopes(prev, res.envelope, sources) : res.envelope));
      // Only rows that were missing arrive here, so the selection stands and
      // the new ones follow the same default: records may start ticked, leads
      // never do.
      const marked = markPlanLocks(markAlreadyOnFile(res.envelope.findings || [], data, s), { isPro });
      setSelected((prev) => [...new Set([...prev, ...defaultSelectedIdsForFocus(marked, focus)])]);
      return;
    }
    setEnvelope(res.envelope);
    setSelected(defaultSelectedIdsForFocus(
      markPlanLocks(markAlreadyOnFile(res.envelope.findings || [], data, s), { isPro }), focus));
    setPhase("review");
  }, [npi, s, data, envelope, isPro, focus]);

  // A fresh search replaces the findings and resets the selection, so ticks
  // already made are not thrown away without being asked about first.
  const searchAgain = useCallback(() => {
    if (countSelected(findings, selected) > 0 && typeof window !== "undefined"
      && !window.confirm("Searching again clears what you have ticked. Nothing has been saved yet. Search again?")) return;
    run();
  }, [findings, selected, run]);

  const toggle = useCallback((id) => {
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }, []);

  const save = useCallback(() => {
    const plan = buildSavePlan(findings, selected, generateId);
    if (!plan.count) return;
    if (Object.keys(plan.settings).length) updateSettings(plan.settings);
    for (const { section, item } of plan.items) addItem(section, item);
    setSaved(plan);
    setPhase("saved");
    onSaved?.(plan.count);
  }, [findings, selected, updateSettings, addItem, onSaved]);

  // ── styles ────────────────────────────────────────────────────────────────
  const card = {
    backgroundColor: T.card, border: `1px solid ${T.border}`, borderRadius: 14,
    padding: "14px 16px", boxShadow: T.cardGlow,
  };
  const primaryBtn = (on = true) => ({
    padding: "12px 16px", borderRadius: 12, border: "none",
    backgroundColor: on ? T.accent : T.neutralDim, color: on ? "#fff" : T.textDim,
    fontSize: 15, fontWeight: 800, cursor: on ? "pointer" : "not-allowed",
  });
  const secondaryBtn = {
    padding: "10px 14px", borderRadius: 10, border: `1px solid ${T.border}`,
    backgroundColor: "transparent", color: T.text, fontSize: 13.5, fontWeight: 700, cursor: "pointer",
  };
  const heading = {
    fontSize: 12, fontWeight: 800, color: T.textMuted,
    textTransform: "uppercase", letterSpacing: 0.5,
  };
  // Two across above 1024px, one column below it. Nothing about the phone
  // layout changes.
  const gridStyle = isDesktop
    ? { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, alignItems: "start" }
    : { display: "flex", flexDirection: "column", gap: 12 };

  const chip = (label, color, bg) => (
    <span style={{
      fontSize: 10.5, fontWeight: 800, color, backgroundColor: bg,
      padding: "2px 7px", borderRadius: 8, whiteSpace: "nowrap",
    }}>{label}</span>
  );

  const sourceChip = (f) => {
    const inner = chip(f.source?.name || "Public register", T.textMuted, T.neutralDim);
    if (!f.source?.url) return inner;
    // The row toggles on click, so the source link must not also tick the box.
    return (
      <a href={f.source.url} target="_blank" rel="noopener noreferrer"
        onClick={(e) => e.stopPropagation()}
        style={{ textDecoration: "none" }} title={`Open ${f.source.name}`}>
        {chip(`${f.source.name} ↗`, T.accent, T.accentGlow)}
      </a>
    );
  };

  // ── one row ───────────────────────────────────────────────────────────────
  const row = (f) => {
    const on = selected.includes(f.id);
    const locked = !isSelectable(f);
    // Two different reasons a row cannot be ticked, and they say different
    // things: one means you already have it, the other means the section is
    // shut on this plan.
    const planNote = planLockNote(f);
    const note = leadNote(f);
    const needs = needsLabel(f.needs);
    const evidence = evidenceLine(f);
    // A profile row writes a patch of several fields behind a one-line label,
    // so the row says out loud what it would take away.
    const replaces = replacesLine(f, s);
    return (
      <div key={f.id}
        onClick={() => { if (!locked) toggle(f.id); }}
        style={{
          display: "flex", gap: 10, alignItems: "flex-start",
          padding: "10px 12px", borderRadius: 12,
          border: `1px solid ${locked ? T.border : (on ? T.accent : T.border)}`,
          backgroundColor: locked ? "transparent" : (on ? T.accentDim : T.input),
          opacity: locked ? 0.55 : 1,
          cursor: locked ? "default" : "pointer",
        }}>
        <input
          type="checkbox"
          checked={on && !locked}
          disabled={locked}
          aria-label={f.label}
          onClick={(e) => e.stopPropagation()}
          onChange={() => toggle(f.id)}
          style={{ width: 18, height: 18, marginTop: 2, flexShrink: 0 }}
        />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: T.text, lineHeight: 1.35 }}>{f.label}</div>
          {planNote && (
            <div style={{ fontSize: 12.5, color: T.textMuted, lineHeight: 1.45, marginTop: 4 }}>{planNote}</div>
          )}
          {!locked && replaces && (
            <div style={{ fontSize: 12.5, color: T.warning, fontWeight: 600, lineHeight: 1.45, marginTop: 4 }}>{replaces}</div>
          )}
          {/* A name match is judged on its co-authors, journal and year, so
              the row shows them rather than asking for a tap first. */}
          {evidence && (
            <div style={{ fontSize: 12.5, color: T.textMuted, lineHeight: 1.45, marginTop: 3 }}>{evidence}</div>
          )}
          {/* A lead's own sentence says the thing that matters, so the
              register's longer wording sits behind a tap rather than saying
              it a second and third time in the same row. */}
          {note ? (
            <div style={{ fontSize: 12.5, color: T.warning, fontWeight: 600, lineHeight: 1.45, marginTop: 4 }}>{note}</div>
          ) : (f.detail && (
            <div style={{ fontSize: 12.5, color: T.textMuted, lineHeight: 1.45, marginTop: 3 }}>{f.detail}</div>
          ))}
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", marginTop: 6 }}>
            {sourceChip(f)}
            {f.alreadyOnFile && chip("already on file", T.textDim, T.neutralDim)}
            {f.planLocked && chip("not on your plan", T.textDim, T.neutralDim)}
            {!locked && f.confidence === "lead" && chip("lead", T.warning, T.warningDim)}
            {!locked && replaces && chip("replaces what you have", T.warning, T.warningDim)}
            {!locked && needs && chip(`you add the ${needs}`, T.info, T.infoDim)}
            {note && f.detail && (
              <button type="button"
                onClick={(e) => { e.stopPropagation(); setOpenDetail((d) => ({ ...d, [f.id]: !d[f.id] })); }}
                style={{
                  fontSize: 10.5, fontWeight: 800, color: T.textMuted, backgroundColor: T.neutralDim,
                  padding: "2px 7px", borderRadius: 8, border: "none", cursor: "pointer",
                }}>
                {openDetail[f.id] ? "less" : "what the register says"}
              </button>
            )}
          </div>
          {note && f.detail && openDetail[f.id] && (
            <div style={{ fontSize: 12.5, color: T.textMuted, lineHeight: 1.45, marginTop: 6 }}>{f.detail}</div>
          )}
        </div>
      </div>
    );
  };

  // Publications run long on a common surname, and a license list runs long
  // on a physician working several states, so a group past PREVIEW_ROWS
  // collapses until the physician asks for the rest.
  const groupBlock = (g) => {
    const showAll = expanded[g.section] || g.findings.length <= PREVIEW_ROWS;
    const shown = showAll ? g.findings : g.findings.slice(0, PREVIEW_ROWS);
    // Rows already ticked on the far side of the fold. The button names them,
    // so the count in the footer is never a surprise.
    const hiddenInGroup = showAll ? 0 : countSelected(g.findings.slice(PREVIEW_ROWS), selected);
    const pickable = g.findings.filter(isSelectable).length;
    const onFile = g.findings.filter((f) => f.alreadyOnFile).length;
    const shut = g.findings.filter((f) => f.planLocked).length;
    return (
      <div key={g.section} style={{ ...card, padding: "12px 14px" }}>
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8, marginBottom: 8 }}>
          <div style={heading}>{g.title}</div>
          <div style={{ fontSize: 11.5, color: T.textDim, fontWeight: 700 }}>
            {joinWords([
              `${pickable} to review`,
              onFile ? `${onFile} on file` : "",
              shut ? `${shut} not on your plan` : "",
            ].filter(Boolean))}
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {shown.map(row)}
        </div>
        {!showAll && (
          <button onClick={() => setExpanded((e) => ({ ...e, [g.section]: true }))}
            style={{ ...secondaryBtn, width: "100%", marginTop: 8 }}>
            Show the other {g.findings.length - PREVIEW_ROWS}
            {hiddenInGroup ? ` (${hiddenInGroup} already ticked)` : ""}
          </button>
        )}
      </div>
    );
  };

  // ── start ─────────────────────────────────────────────────────────────────
  if (phase === "start" || phase === "loading") {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={card}>
          <div style={{ fontSize: 16, fontWeight: 800, color: T.text }}>
            {focusCopy ? `${focusCopy.title}, from the public registers` : "Fill this in from the public registers"}
          </div>
          <div style={{ fontSize: 13.5, color: T.textMuted, lineHeight: 1.5, marginTop: 6 }}>
            {focusCopy
              ? focusCopy.line
              : "Your NPI record, Medicare Care Compare and PubMed already hold your license numbers, your degree, where you practise and your papers. This reads all three and shows you what it found. Nothing is saved until you tick it."}
          </div>
          {focusCopy && (
            <div style={{ fontSize: 13, color: T.textMuted, lineHeight: 1.5, marginTop: 6 }}>
              Nothing is saved until you tick it. The search reads all three registers at once, so whatever it finds for the rest of your record is shown here too.
            </div>
          )}
          <ul style={{ margin: "10px 0 0", paddingLeft: 18, fontSize: 12.5, color: T.textDim, lineHeight: 1.6 }}>
            <li>NPPES NPI Registry: your name, degree, state license numbers, practice address</li>
            <li>Medicare Care Compare: graduation year, the organizations you bill under, the hospitals your claims came from</li>
            <li>PubMed: papers under your author name</li>
          </ul>
        </div>

        {!hasNpi && (
          <div style={card}>
            <div style={heading}>First, your NPI</div>
            <div style={{ fontSize: 13, color: T.textMuted, lineHeight: 1.5, margin: "6px 0 10px" }}>
              Every one of these registers is keyed on it. Look it up here and the search runs on the number the registry returns.
            </div>
            <NpiPanel dense />
          </div>
        )}

        {hasNpi && (
          <div style={card}>
            <div style={{ fontSize: 13, color: T.textMuted, marginBottom: 10 }}>
              Searching as NPI <strong style={{ color: T.text, fontVariantNumeric: "tabular-nums" }}>{npi}</strong>
              {s.name ? ` (${s.name})` : ""}.
            </div>
            <button onClick={() => run()} disabled={phase === "loading"} style={{ ...primaryBtn(), width: "100%", opacity: phase === "loading" ? 0.7 : 1 }}>
              {phase === "loading" ? "Asking the registers..." : "Search the public registers"}
            </button>
            {phase === "loading" && (
              <div style={{ fontSize: 12.5, color: T.textDim, marginTop: 8, lineHeight: 1.5 }}>
                Four calls go out at once. A register that does not answer is named and the rest still come back.
              </div>
            )}
          </div>
        )}

        {error && (
          <div style={{ ...card, borderColor: T.danger, backgroundColor: T.dangerDim }}>
            <div style={{ fontSize: 13.5, color: T.danger, fontWeight: 700, lineHeight: 1.5 }}>{error}</div>
            {hasNpi && (
              <button onClick={() => run()} style={{ ...secondaryBtn, marginTop: 10 }}>Try again</button>
            )}
          </div>
        )}

        {onClose && <button onClick={onClose} style={secondaryBtn}>Close</button>}
      </div>
    );
  }

  // ── saved ─────────────────────────────────────────────────────────────────
  if (phase === "saved" && saved) {
    const written = savedSummary(saved);
    const leftOver = countSelected(findings, selected);
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ ...card, borderColor: T.success, backgroundColor: T.successDim }}>
          <div style={{ fontSize: 16, fontWeight: 800, color: T.success }}>
            Saved {saved.count} item{saved.count === 1 ? "" : "s"}.
          </div>
          <div style={{ fontSize: 13, color: T.textMuted, lineHeight: 1.5, marginTop: 6 }}>
            They are in your record now and sync like anything else you type. Rows that came back as leads still need the dates and the confirmation each one named.
          </div>
        </div>

        {written.map((g) => (
          <div key={g.section} style={{ ...card, padding: "12px 14px" }}>
            <div style={heading}>{g.title}</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 6 }}>
              {g.findings.map((f) => (
                <div key={f.id} style={{ fontSize: 13.5, color: T.text, lineHeight: 1.4 }}>
                  {f.label}
                  {needsLabel(f.needs) && (
                    <span style={{ color: T.textDim, fontSize: 12 }}> &middot; add the {needsLabel(f.needs)}</span>
                  )}
                </div>
              ))}
            </div>
          </div>
        ))}

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button onClick={() => { setPhase("review"); setSaved(null); }} style={{ ...secondaryBtn, flex: 1 }}>
            Back to the findings{leftOver ? ` (${leftOver} still ticked)` : ""}
          </button>
          {onClose && <button onClick={onClose} style={{ ...primaryBtn(), flex: 1 }}>Done</button>}
        </div>
      </div>
    );
  }

  // ── review ────────────────────────────────────────────────────────────────
  const nothing = findings.length === 0;
  // Opened on one row, the count in the header is that row's count. The rest
  // of the search is announced by its own button rather than folded into a
  // number the physician cannot see the parts of.
  const headShown = focus ? focusGroups.flatMap((g) => g.findings) : findings;
  const headOnFile = headShown.filter((f) => f.alreadyOnFile).length;
  const headNoun = focus && focusCopy ? focusCopy.title.toLowerCase() : `NPI ${npi}`;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={card}>
        <div style={{ fontSize: 16, fontWeight: 800, color: T.text }}>
          {headShown.length === 0
            ? (focus ? `Nothing came back for ${headNoun}` : "Nothing came back to add")
            : `${headShown.length} thing${headShown.length === 1 ? "" : "s"} found for ${headNoun}`}
        </div>
        <div style={{ fontSize: 13, color: T.textMuted, lineHeight: 1.5, marginTop: 6 }}>
          {headShown.length === 0
            ? (focus
              // Opened on one section, the sentence is about that section.
              // The whole-NPI claim would contradict the fold below, which is
              // announcing what the same search found everywhere else.
              ? (failed.length
                ? `The registers that answered had nothing to add for ${headNoun}.`
                : `The registers answered and had nothing to add for ${headNoun}.`)
              : (failed.length
                ? "The registers that answered had nothing on file for this NPI."
                : "The registers answered and had nothing on file for this NPI beyond what you already have. That is common early on, and it is not a problem with your record."))
            : <>Tick what is yours. Nothing is saved until you press Save at the bottom.{headOnFile > 0 && ` ${headOnFile} of these ${headOnFile === 1 ? "is" : "are"} already on file and shown greyed.`}</>}
        </div>
        {envelope?.message && (
          <div style={{ fontSize: 12.5, color: T.textMuted, marginTop: 8, lineHeight: 1.5 }}>{envelope.message}</div>
        )}
      </div>

      {failed.length > 0 && (
        <div style={{ ...card, borderColor: T.warning, backgroundColor: T.warningDim }}>
          <div style={{ fontSize: 13.5, fontWeight: 700, color: T.warning, lineHeight: 1.5 }}>
            {joinWords(failed)} did not answer, so nothing from {failed.length === 1 ? "it" : "them"} is below.
          </div>
          <div style={{ fontSize: 12.5, color: T.textMuted, marginTop: 4, lineHeight: 1.5 }}>
            Everything else came back and can be reviewed now.
          </div>
          <button onClick={() => run(retrySources(envelope?.errors))} disabled={retrying}
            style={{ ...secondaryBtn, marginTop: 10, opacity: retrying ? 0.6 : 1 }}>
            {retrying ? "Asking again..." : `Try ${failed.length === 1 ? "it" : "them"} again`}
          </button>
        </div>
      )}

      {error && (
        <div style={{ fontSize: 13, color: T.danger, fontWeight: 700, lineHeight: 1.5 }}>{error}</div>
      )}

      <div style={gridStyle}>{(focus ? focusGroups : groups).map(groupBlock)}</div>

      {/* Opened on one row, everything else the same search found is one tap
          away. It is never dropped: a register that answered for a section
          the physician was not looking at still answered. */}
      {focus && restGroups.length > 0 && (
        <>
          <button onClick={() => setShowRest((r) => !r)} style={secondaryBtn}>
            {showRest
              ? "Hide the rest of what was found"
              : (restPickable
                ? `The same search found ${restPickable} other ${restPickable === 1 ? "thing" : "things"} for your record`
                // Everything else the search found is already on file or shut
                // on this plan. There is still something to look at, and none
                // of it is a decision, so the button does not count it.
                : "See the rest of what the search found")}
          </button>
          {showRest && <div style={gridStyle}>{restGroups.map(groupBlock)}</div>}
        </>
      )}

      {!nothing && (
      <div style={{
        ...card, position: "sticky", bottom: 0, zIndex: 2,
        display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap",
      }}>
        <div style={{ flex: 1, minWidth: 140 }}>
          <div style={{ fontSize: 14, fontWeight: 800, color: T.text }}>
            {selectedCount} selected
          </div>
          <div style={{ fontSize: 12, color: T.textDim }}>
            {selectedCount === 0 ? "Tick what you want to keep." : "Only these get saved."}
          </div>
          {/* Save counts every tick, including one made in a group that has
              since been folded shut. The number never stands for more rows
              than the screen is showing without saying so. */}
          {hiddenTicked > 0 && (
            <div style={{ fontSize: 12, color: T.warning, fontWeight: 700 }}>
              {hiddenTicked} {hiddenTicked === 1 ? "is" : "are"} in the part you have hidden.
            </div>
          )}
          {previewHidden > 0 && (
            <div style={{ fontSize: 12, color: T.warning, fontWeight: 700 }}>
              {previewHidden} {previewHidden === 1 ? "is" : "are"} below a "Show the other" button.
            </div>
          )}
        </div>
        <button onClick={() => setSelected([])} disabled={selectedCount === 0}
          style={{ ...secondaryBtn, opacity: selectedCount === 0 ? 0.5 : 1 }}>Clear</button>
        <button onClick={save} disabled={selectedCount === 0} style={primaryBtn(selectedCount > 0)}>
          Save {selectedCount || ""}
        </button>
      </div>
      )}

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button onClick={searchAgain} style={secondaryBtn}>Search again</button>
        {onClose && <button onClick={onClose} style={secondaryBtn}>Close</button>}
      </div>
    </div>
  );
}

export default memo(PublicRecordReview);
