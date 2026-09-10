import { useRef, useState } from "react";
import { useApp } from "../../context/AppContext";
import { readTicketAttachment } from "../../utils/imageAttachment";
import {
  MAX_TICKET_IMAGES, TICKET_ATTACH_ACCEPT, addImages, attachmentKind, mimeOfDataUrl,
} from "../../utils/ticketAttachments";

/**
 * The attach control shared by the two new-ticket forms and both reply boxes.
 *
 * It takes SEVERAL files now, because a physician asked: one picture rarely
 * shows a bug, and the previous control replaced whatever was attached the
 * moment a second file was picked. It also takes more than pictures, because
 * the next thing he asked was to attach the PDF he was complaining about and
 * found every file in the picker grayed out.
 *
 * `value` is an array of { data: dataURL, name } and `onChange` gets the same.
 * A single object or null is normalised, so a caller not yet updated keeps
 * working.
 */
export default function ScreenshotAttach({ value, onChange, style }) {
  const { theme: T } = useApp();
  const fileRef = useRef(null);
  const [error, setError] = useState("");

  const images = Array.isArray(value) ? value : (value ? [value] : []);
  const full = images.length >= MAX_TICKET_IMAGES;

  const pick = async (e) => {
    const files = [...(e.target.files || [])];
    e.target.value = "";
    if (!files.length) return;
    setError("");
    const read = [];
    for (const file of files) {
      try {
        read.push({ data: await readTicketAttachment(file), name: file.name });
      } catch (err) {
        setError(err.message);
        return;
      }
    }
    const { images: next, error: why } = addImages(images, read);
    if (why) setError(why);
    onChange(next);
  };

  const removeAt = (i) => {
    setError("");
    onChange(images.filter((_, n) => n !== i));
  };

  const removeButton = (img, i) => (
    <button onClick={() => removeAt(i)} aria-label={`Remove ${img.name || `attachment ${i + 1}`}`} style={{
      position: "absolute", top: -6, right: -6, width: 22, height: 22, borderRadius: 11,
      border: `1px solid ${T.border}`, backgroundColor: T.card, color: T.textMuted,
      fontSize: 13, fontWeight: 800, cursor: "pointer", lineHeight: 1, padding: 0,
    }}>&times;</button>
  );

  return (
    <div style={style}>
      <input ref={fileRef} type="file" accept={TICKET_ATTACH_ACCEPT} multiple onChange={pick} style={{ display: "none" }} />

      {images.length > 0 && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
          {images.map((img, i) => (
            <div key={`${img.name}-${i}`} style={{ position: "relative" }}>
              {attachmentKind(img.name, mimeOfDataUrl(img.data)) === "image" ? (
                <img src={img.data} alt={img.name || `Attachment ${i + 1}`}
                  style={{ width: 64, height: 64, objectFit: "cover", borderRadius: 8, border: `1px solid ${T.border}`, display: "block" }} />
              ) : (
                // A PDF has no thumbnail on a phone, so the name is the preview.
                <div style={{
                  width: 64, height: 64, borderRadius: 8, border: `1px solid ${T.border}`,
                  backgroundColor: T.input, display: "flex", flexDirection: "column",
                  alignItems: "center", justifyContent: "center", gap: 2, padding: 4, overflow: "hidden",
                }}>
                  <span style={{ fontSize: 18, lineHeight: 1 }}>{"\u{1F4C4}"}</span>
                  <span style={{
                    fontSize: 9, fontWeight: 700, color: T.textMuted, textAlign: "center",
                    lineHeight: 1.15, wordBreak: "break-all", maxHeight: 24, overflow: "hidden",
                  }}>{img.name || "File"}</span>
                </div>
              )}
              {removeButton(img, i)}
            </div>
          ))}
        </div>
      )}

      <button onClick={() => fileRef.current?.click()} disabled={full} style={{
        display: "block", width: "100%", padding: "10px 12px", borderRadius: 10,
        border: `1px dashed ${T.border}`, backgroundColor: "transparent",
        color: full ? T.textDim : T.textMuted, fontSize: 13, fontWeight: 600,
        cursor: full ? "not-allowed" : "pointer", textAlign: "left",
      }}>
        {full
          ? `${MAX_TICKET_IMAGES} files attached, the most one message can carry`
          : images.length
            ? `\u{1F4CE} Attach another file (${images.length} of ${MAX_TICKET_IMAGES})`
            : "\u{1F4CE} Attach a screenshot or file"}
      </button>

      {!images.length && (
        <div style={{ marginTop: 4, fontSize: 11.5, color: T.textDim, lineHeight: 1.45 }}>
          A screenshot, a photo, a PDF, or a document. Up to {MAX_TICKET_IMAGES}, 5 MB each.
        </div>
      )}

      {error && <div style={{ marginTop: 6, fontSize: 12, color: "#ef4444", fontWeight: 600 }}>{error}</div>}
    </div>
  );
}
