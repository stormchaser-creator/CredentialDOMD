import { memo, useEffect, useState } from "react";
import { useApp } from "../../context/AppContext";

/**
 * Circular SVG progress ring — hero metric for the dashboard.
 * @param {number} percent — 0-100
 * @param {number} size — diameter in px (default 140)
 * @param {number} stroke — stroke width (default 10)
 * @param {string} label — text below the number (default "Compliant")
 */
function ComplianceRing({ percent = 0, size = 140, stroke = 10, label = "Compliant" }) {
  const { theme: T } = useApp();
  const [animatedPercent, setAnimatedPercent] = useState(0);

  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (animatedPercent / 100) * circumference;

  // Animate on mount
  useEffect(() => {
    const timer = setTimeout(() => setAnimatedPercent(Math.min(100, Math.max(0, percent))), 100);
    return () => clearTimeout(timer);
  }, [percent]);

  // Color based on percentage
  const ringColor = percent >= 80 ? T.success : percent >= 50 ? T.warning : T.danger;
  const trackColor = T.input;

  return (
    <div style={{ position: "relative", width: size, height: size }}>
      <svg width={size} height={size} style={{ transform: "rotate(-90deg)" }}>
        {/* Background track */}
        <circle
          cx={size / 2} cy={size / 2} r={radius}
          fill="none" stroke={trackColor} strokeWidth={stroke}
        />
        {/* Progress arc */}
        <circle
          cx={size / 2} cy={size / 2} r={radius}
          fill="none" stroke={ringColor} strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          style={{ transition: "stroke-dashoffset 0.8s cubic-bezier(0,0,0.2,1), stroke 0.3s ease" }}
        />
      </svg>
      {/* Center text */}
      <div style={{
        position: "absolute", inset: 0,
        display: "flex", flexDirection: "column",
        alignItems: "center", justifyContent: "center",
      }}>
        <div style={{
          fontSize: 28, fontWeight: 700, color: T.text, lineHeight: 1,
          fontFeatureSettings: "'tnum'",
        }}>
          {Math.round(percent)}%
        </div>
        <div style={{ fontSize: 12, fontWeight: 500, color: T.textMuted, marginTop: 2 }}>
          {label}
        </div>
      </div>
    </div>
  );
}

export default memo(ComplianceRing);
