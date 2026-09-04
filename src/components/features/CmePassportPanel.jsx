import { useState, useMemo, memo } from "react";
import { useApp } from "../../context/AppContext";
import { ExternalLinkIcon, CheckIcon } from "../shared/Icons";
import { copyToClipboard } from "../../utils/helpers";
import { CME_INBOX_ADDRESS } from "../../utils/inboxDocs";
import {
  CME_PASSPORT_LOGIN, CME_PASSPORT_SEARCH, reportingCard,
} from "../../utils/cmePassport";

/**
 * CME Passport, in the only two directions that exist.
 *
 * Coming back: the transcript the physician exports, which the importer
 * already reads. Going out: the details a CME provider needs before it can
 * report a credit into PARS, which is why a transcript comes back empty.
 * There is no API in either direction; src/utils/cmePassport.js says why.
 */
function CmePassportPanel({ onImport }) {
  const { data, theme: T, navigate } = useApp();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  const card = useMemo(() => reportingCard(data), [data]);

  const linkStyle = {
    display: "inline-flex", alignItems: "center", gap: 6, padding: "8px 14px",
    borderRadius: 10, border: `1px solid ${T.border}`, backgroundColor: "transparent",
    color: T.textMuted, fontSize: 13, fontWeight: 600, cursor: "pointer", textDecoration: "none",
  };

  const copy = async () => {
    await copyToClipboard(card.text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2500);
  };

  return (
    <div style={{
      border: `1px solid ${T.border}`, borderRadius: 12, marginBottom: 16,
      backgroundColor: T.card, overflow: "hidden",
    }}>
      <button onClick={() => setOpen(!open)} style={{
        display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10,
        width: "100%", padding: "12px 14px", border: "none", backgroundColor: "transparent",
        cursor: "pointer", textAlign: "left",
      }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 700, color: T.text }}>ACCME CME Passport</div>
          <div style={{ fontSize: 12.5, color: T.textDim, marginTop: 2 }}>
            {card.complete
              ? "Your reporting details are ready to hand to a CME provider."
              : `${card.missing.length} detail${card.missing.length === 1 ? "" : "s"} missing before a CME provider can report your credit.`}
          </div>
        </div>
        <span style={{ fontSize: 12, color: T.textDim, flexShrink: 0 }}>{open ? "Hide" : "Open"}</span>
      </button>

      {open && (
        <div style={{ padding: "0 14px 14px", fontSize: 13, color: T.textMuted, lineHeight: 1.5 }}>
          <p style={{ margin: "0 0 12px" }}>
            CME Passport is ACCME&rsquo;s free record of the credit that accredited CME providers
            have reported on your behalf, and the boards that collaborate with ACCME read it
            directly. It holds nothing you have not been reported for, so it is a second copy of
            your record, not a replacement for this one.
          </p>

          <div style={{ fontSize: 12, fontWeight: 700, color: T.accent, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6 }}>
            1. Get your credit reported
          </div>
          <p style={{ margin: "0 0 10px" }}>
            A provider can only report your credit if you give them these, and your permission.
            Hand this to the CME coordinator when you register, or after the activity.
          </p>

          <div style={{
            border: `1px solid ${T.border}`, borderRadius: 10, padding: "10px 12px",
            backgroundColor: T.input, marginBottom: 8,
          }}>
            {card.fields.map(f => (
              <div key={f.key} style={{ display: "flex", gap: 8, justifyContent: "space-between", padding: "3px 0" }}>
                <span style={{ color: T.textDim, fontSize: 12.5 }}>{f.label}</span>
                <span style={{
                  fontWeight: 600, fontSize: 12.5, textAlign: "right",
                  color: f.value ? T.text : T.textDim,
                }}>{f.value || "not on file"}</span>
              </div>
            ))}
            <div style={{ fontSize: 12, color: T.textDim, marginTop: 6, paddingTop: 6, borderTop: `1px solid ${T.border}` }}>
              Copied with: &ldquo;I give permission to report this CME credit to the ACCME.&rdquo;
              ACCME asks for the month and day of birth only, never the year.
            </div>
          </div>

          {card.missing.length > 0 && (
            <div style={{
              fontSize: 12.5, color: T.warning, backgroundColor: T.warningDim,
              borderRadius: 10, padding: "8px 12px", marginBottom: 8,
            }}>
              {card.missing.map(m => <div key={m.key} style={{ padding: "1px 0" }}>{m.fix}</div>)}
              <button onClick={() => navigate("more", "settings")} style={{
                marginTop: 4, padding: 0, border: "none", backgroundColor: "transparent",
                color: T.accent, fontSize: 12.5, fontWeight: 700, cursor: "pointer",
              }}>Open Settings</button>
            </div>
          )}

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16 }}>
            <button onClick={copy} style={{ ...linkStyle, borderColor: copied ? T.success : T.border, color: copied ? T.success : T.textMuted }}>
              {copied ? <><CheckIcon /> Copied</> : "Copy reporting details"}
            </button>
          </div>

          <div style={{ fontSize: 12, fontWeight: 700, color: T.accent, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6 }}>
            2. Bring the transcript back
          </div>
          <p style={{ margin: "0 0 10px" }}>
            Sign in at CME Passport, download your transcript, and import it here. Nothing is
            saved until you approve every row. You can also email the transcript from CME Passport
            to <span style={{ fontWeight: 600, color: T.text }}>{CME_INBOX_ADDRESS}</span>, which
            files it in Documents for you to import.
          </p>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16 }}>
            <a href={CME_PASSPORT_LOGIN} target="_blank" rel="noopener noreferrer" style={linkStyle}>
              Open CME Passport <ExternalLinkIcon />
            </a>
            <button onClick={onImport} style={linkStyle}>Import transcript</button>
          </div>

          <div style={{ fontSize: 12, fontWeight: 700, color: T.accent, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6 }}>
            3. Find accredited CME
          </div>
          <p style={{ margin: "0 0 10px" }}>
            Every activity in the search is from an ACCME-accredited provider, so credit earned
            there can be reported for you. Filter by state, credit type, specialty and fee.
          </p>
          <a href={CME_PASSPORT_SEARCH} target="_blank" rel="noopener noreferrer" style={linkStyle}>
            Search CME Passport <ExternalLinkIcon />
          </a>

          <p style={{ margin: "16px 0 0", fontSize: 12, color: T.textDim }}>
            There is no direct connection to build: CME Passport has no public API, ACCME&rsquo;s
            PARS web services are issued to accredited CME providers and cannot read a
            physician&rsquo;s transcript, and ACCME&rsquo;s terms prohibit automated extraction.
            Your transcript moves as a file you export, which is the part that works.
          </p>
        </div>
      )}
    </div>
  );
}

export default memo(CmePassportPanel);
