import { useApp } from "../../context/AppContext";
import { attachmentKind, attachmentLabel } from "../../utils/ticketAttachments";

/**
 * What a ticket message carries, rendered from its signed links.
 *
 * A picture is shown. A PDF or a document cannot be, so it gets a row that
 * says what it is and opens in a new tab. Before this, every link was put in
 * an <img> tag, which for a PDF drew a broken image icon and nothing else.
 *
 * The only thing known about a link here is its path: the original filename
 * lives on the sender's phone, not in the bucket.
 */
export default function TicketAttachments({ urls, size = 160 }) {
  const { theme: T } = useApp();
  const list = (Array.isArray(urls) ? urls : [urls]).filter(Boolean);
  if (!list.length) return null;

  return (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
      {list.map((u, i) => {
        const label = attachmentLabel(u, i);
        if (attachmentKind(u) === "image") {
          return (
            <a key={u} href={u} target="_blank" rel="noreferrer">
              <img src={u} alt={label} style={{
                maxWidth: size, maxHeight: size, borderRadius: 8,
                border: `1px solid ${T.border}`, display: "block",
              }} />
            </a>
          );
        }
        return (
          <a key={u} href={u} target="_blank" rel="noreferrer" style={{
            display: "flex", alignItems: "center", gap: 8, padding: "9px 12px",
            borderRadius: 10, border: `1px solid ${T.border}`, backgroundColor: T.input,
            color: T.text, fontSize: 12.5, fontWeight: 700, textDecoration: "none",
          }}>
            <span style={{ fontSize: 16, lineHeight: 1 }}>{"\u{1F4C4}"}</span>
            <span>{label}</span>
            <span style={{ color: T.textMuted, fontWeight: 600 }}>Open</span>
          </a>
        );
      })}
    </div>
  );
}
