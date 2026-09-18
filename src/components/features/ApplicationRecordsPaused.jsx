import { PAUSED_APPLICATION_SECTIONS } from "../../utils/pausedApplicationRecords.js";

export default function ApplicationRecordsPaused({ section, count = 0, theme: T }) {
  return <section style={{ padding: 20, borderRadius: 12, border: `1px solid ${T.border}`, background: T.card, color: T.text }}>
    <h2 style={{ fontSize: 20, margin: "0 0 12px" }}>{PAUSED_APPLICATION_SECTIONS[section]}</h2>
    <p role="status" style={{ lineHeight: 1.6 }}>New entries, edits and sharing are paused while cloud storage and backup restoration are completed.</p>
    <p style={{ color: T.textMuted, lineHeight: 1.6 }}>Existing records in this section are kept only in this browser for your account. They do not sync to another device.</p>
    {count > 0 && <p style={{ lineHeight: 1.6 }}>This browser has {count} saved {count === 1 ? "record" : "records"}. Keep a full JSON backup before signing out or clearing browser data; signing out clears the local copy and its saved lock code.</p>}
    <p style={{ color: T.textMuted, lineHeight: 1.6 }}>A full JSON backup includes these records, but the app cannot restore them yet. Keep the backup private. {section === "identityVault"
      ? "Legal names and notes are plain text. SSN and full-date-of-birth fields saved through the protected form remain encrypted and need your original lock code."
      : "Saved answers, explanations and notes are plain text."}</p>
  </section>;
}
