import { useRef, useState } from "react";
import { useApp } from "../../../context/AppContext";
import Modal from "../../shared/Modal";
import { CROP_FRAME, CROP_OUTPUT, cropDimensions, cropPoint, cropSourceRect, initialCrop, moveCrop, zoomCrop } from "../../../utils/headshotCrop";

export default function HeadshotCropModal({ src, onCancel, onConfirm }) {
  const { theme: T } = useApp();
  const imgRef = useRef(null);
  const pointers = useRef(new Map());
  const cropRef = useRef({ zoom: 1, x: 0, y: 0 });
  const [natural, setNatural] = useState(null);
  const [crop, setCrop] = useState(cropRef.current);
  const [error, setError] = useState("");
  const ready = !!natural;
  const dimensions = ready ? cropDimensions(natural, crop.zoom) : { w: 0, h: 0 };
  const update = next => { cropRef.current = next; setCrop(next); };
  const point = e => cropPoint(e.clientX, e.clientY, e.currentTarget.getBoundingClientRect());

  const start = e => {
    if (!ready || (e.pointerType === "mouse" && e.button !== 0) || pointers.current.size >= 2) return;
    e.preventDefault();
    pointers.current.set(e.pointerId, point(e));
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const move = e => {
    if (!ready || !pointers.current.has(e.pointerId)) return;
    const before = [...pointers.current.values()];
    pointers.current.set(e.pointerId, point(e));
    update(moveCrop(cropRef.current, before, [...pointers.current.values()], natural));
  };
  const end = e => { pointers.current.delete(e.pointerId); };

  const confirm = () => {
    if (!ready) return;
    try {
      const canvas = document.createElement("canvas");
      canvas.width = CROP_OUTPUT;
      canvas.height = CROP_OUTPUT;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Canvas unavailable");
      const { x, y, side } = cropSourceRect(cropRef.current, natural);
      ctx.drawImage(imgRef.current, x, y, side, side, 0, 0, CROP_OUTPUT, CROP_OUTPUT);
      onConfirm(canvas.toDataURL("image/jpeg", 0.9));
    } catch {
      setError("This photo could not be saved. Please try another photo.");
    }
  };

  const button = { flex: 1, padding: "12px 16px", borderRadius: 12, fontSize: 14.5,
    fontWeight: 700, cursor: "pointer", fontFamily: "inherit" };
  return <Modal open onClose={onCancel} title="Position your headshot" width={420}>
    <div style={{ fontSize: 12.5, color: T.textMuted, lineHeight: 1.5, marginBottom: 12 }}>
      Drag to reposition. Pinch with two fingers or use the slider to zoom. The frame is exactly what gets saved.
    </div>
    <div role="img" aria-label="Headshot crop preview"
      onPointerDown={start} onPointerMove={move} onPointerUp={end}
      onPointerCancel={end} onLostPointerCapture={end}
      style={{ width: "100%", maxWidth: CROP_FRAME, aspectRatio: "1", margin: "0 auto",
        borderRadius: 12, overflow: "hidden", position: "relative", backgroundColor: T.border,
        cursor: "grab", touchAction: "none" }}>
      <img ref={imgRef} src={src} alt="" draggable={false}
        onLoad={() => {
          const image = imgRef.current;
          if (!image?.naturalWidth || !image?.naturalHeight) return;
          const size = { w: image.naturalWidth, h: image.naturalHeight };
          pointers.current.clear();
          setNatural(size); update(initialCrop(size)); setError("");
        }}
        onError={() => { setNatural(null); pointers.current.clear(); setError("This photo could not be opened. Please choose another photo."); }}
        style={{ position: "absolute", left: `${crop.x / CROP_FRAME * 100}%`, top: `${crop.y / CROP_FRAME * 100}%`,
          width: `${dimensions.w / CROP_FRAME * 100}%`, height: `${dimensions.h / CROP_FRAME * 100}%`,
          maxWidth: "none", visibility: ready ? "visible" : "hidden", userSelect: "none", pointerEvents: "none" }} />
    </div>
    <input type="range" aria-label="Photo zoom" min={1} max={3} step={0.01} value={crop.zoom}
      disabled={!ready} onChange={e => {
        pointers.current.clear();
        update(zoomCrop(cropRef.current, Number(e.target.value), natural));
      }} style={{ width: "100%", marginTop: 14 }} />
    {error && <p role="alert" style={{ color: T.danger || T.text }}>{error}</p>}
    <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
      <button onClick={onCancel} style={{ ...button, border: `1px solid ${T.border}`,
        backgroundColor: "transparent", color: T.text }}>Cancel</button>
      <button onClick={confirm} disabled={!ready} style={{ ...button, border: "none",
        backgroundColor: T.accent, color: "#fff", cursor: ready ? "pointer" : "default" }}>Use this photo</button>
    </div>
  </Modal>;
}
