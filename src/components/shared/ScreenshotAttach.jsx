import { useRef, useState } from "react";
import { useApp } from "../../context/AppContext";
import { readImageAttachment } from "../../utils/imageAttachment";

/**
 * "Attach a screenshot" control shared by the two new-ticket forms and both
 * reply boxes. Hidden file input; a dashed button while empty, a thumbnail
 * plus Remove once an image is picked. One image at a time: `value` is
 * { data: dataURL, name } or null and `onChange` gets the same.
 */
export default function ScreenshotAttach({ value, onChange, style }) {
  const { theme: T } = useApp();
  const fileRef = useRef(null);
  const [error, setError] = useState("");

  const pick = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setError("");
    try {
      onChange({ data: await readImageAttachment(file), name: file.name });
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <div style={style}>
      <input ref={fileRef} type="file" accept="image/*" onChange={pick} style={{ display: "none" }} />
      {value ? (
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <img src={value.data} alt="Attached screenshot" style={{ width: 56, height: 56, objectFit: "cover", borderRadius: 8, border: `1px solid ${T.border}` }} />
          <button onClick={() => { onChange(null); setError(""); }} style={{
            padding: "8px 12px", borderRadius: 8, border: `1px solid ${T.border}`,
            backgroundColor: "transparent", color: T.textMuted, fontSize: 12.5, fontWeight: 700, cursor: "pointer",
          }}>Remove</button>
        </div>
      ) : (
        <button onClick={() => fileRef.current?.click()} style={{
          display: "block", width: "100%", padding: "10px 12px", borderRadius: 10, border: `1px dashed ${T.border}`,
          backgroundColor: "transparent", color: T.textMuted, fontSize: 13, fontWeight: 600, cursor: "pointer", textAlign: "left",
        }}>{"📎"} Attach a screenshot</button>
      )}
      {error && <div style={{ marginTop: 6, fontSize: 12, color: "#ef4444", fontWeight: 600 }}>{error}</div>}
    </div>
  );
}
