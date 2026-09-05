import { useRef, useState } from "react";
import { useApp } from "../../context/AppContext";
import { readImageAttachment } from "../../utils/imageAttachment";
import { MAX_TICKET_IMAGES, addImages } from "../../utils/ticketAttachments";

/**
 * "Attach a screenshot" control shared by the two new-ticket forms and both
 * reply boxes.
 *
 * It takes SEVERAL images now, because a physician asked: one picture rarely
 * shows a bug, and the previous control replaced whatever was attached the
 * moment a second file was picked.
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
        read.push({ data: await readImageAttachment(file), name: file.name });
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

  return (
    <div style={style}>
      <input ref={fileRef} type="file" accept="image/*" multiple onChange={pick} style={{ display: "none" }} />

      {images.length > 0 && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
          {images.map((img, i) => (
            <div key={`${img.name}-${i}`} style={{ position: "relative" }}>
              <img src={img.data} alt={img.name || `Screenshot ${i + 1}`}
                style={{ width: 64, height: 64, objectFit: "cover", borderRadius: 8, border: `1px solid ${T.border}`, display: "block" }} />
              <button onClick={() => removeAt(i)} aria-label={`Remove ${img.name || `screenshot ${i + 1}`}`} style={{
                position: "absolute", top: -6, right: -6, width: 22, height: 22, borderRadius: 11,
                border: `1px solid ${T.border}`, backgroundColor: T.card, color: T.textMuted,
                fontSize: 13, fontWeight: 800, cursor: "pointer", lineHeight: 1, padding: 0,
              }}>&times;</button>
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
          ? `${MAX_TICKET_IMAGES} screenshots attached, the most one message can carry`
          : images.length
            ? `\u{1F4CE} Attach another screenshot (${images.length} of ${MAX_TICKET_IMAGES})`
            : "\u{1F4CE} Attach a screenshot"}
      </button>

      {error && <div style={{ marginTop: 6, fontSize: 12, color: "#ef4444", fontWeight: 600 }}>{error}</div>}
    </div>
  );
}
