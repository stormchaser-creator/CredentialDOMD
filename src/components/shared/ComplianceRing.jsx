import { memo, useEffect, useState, useRef, useId } from "react";
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
  const [displayNum, setDisplayNum] = useState(0);
  const rafRef = useRef(null);
  const gradId = useId().replace(/:/g, "");

  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (animatedPercent / 100) * circumference;

  // Animate stroke on mount/change
  useEffect(() => {
    const timer = setTimeout(() => setAnimatedPercent(Math.min(100, Math.max(0, percent))), 80);
    return () => clearTimeout(timer);
  }, [percent]);

  // Count-up number animation
  useEffect(() => {
    const target = Math.min(100, Math.max(0, percent));
    const duration = 800;
    const start = performance.now();
    const from = displayNum;

    const step = (now) => {
      const elapsed = now - start;
      const progress = Math.min(elapsed / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3); // ease-out-cubic
      setDisplayNum(Math.round(from + (target - from) * eased));
      if (progress < 1) rafRef.current = requestAnimationFrame(step);
    };

    rafRef.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(rafRef.current);
  }, [percent]); // eslint-disable-line react-hooks/exhaustive-deps

  // Gradient colors based on percentage
  const gradStart = percent >= 80 ? "#10b981" : percent >= 50 ? "#f59e0b" : "#ef4444";
  const gradEnd   = percent >= 80 ? "#34d399" : percent >= 50 ? "#fbbf24" : "#f87171";
  const trackColor = T.input;

  return (
    <div style={{ position: "relative", width: size, height: size, flexShrink: 0 }}>
      <svg
        width={size}
        height={size}
        style={{ transform: "rotate(-90deg)", filter: `drop-shadow(0 0 6px ${gradStart}40)` }}
      >
        <defs>
          <linearGradient id={`ring-grad-${gradId}`} x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%"   stopColor={gradStart} />
            <stop offset="100%" stopColor={gradEnd}   />
          </linearGradient>
        </defs>

        {/* Background track */}
        <circle
          cx={size / 2} cy={size / 2} r={radius}
          fill="none" stroke={trackColor} strokeWidth={stroke}
        />

        {/* Progress arc — gradient stroke */}
        <circle
          cx={size / 2} cy={size / 2} r={radius}
          fill="none"
          stroke={`url(#ring-grad-${gradId})`}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          style={{ transition: "stroke-dashoffset 0.9s cubic-bezier(0,0,0.2,1)" }}
        />
      </svg>

      {/* Center text */}
      <div style={{
        position: "absolute", inset: 0,
        display: "flex", flexDirection: "column",
        alignItems: "center", justifyContent: "center",
      }}>
        <div style={{
          fontSize: Math.round(size * 0.22),
          fontWeight: 800,
          color: T.text,
          lineHeight: 1,
          fontFeatureSettings: "'tnum'",
          fontVariantNumeric: "tabular-nums",
        }}>
          {displayNum}%
        </div>
        <div style={{ fontSize: Math.round(size * 0.09), fontWeight: 600, color: T.textMuted, marginTop: 3 }}>
          {label}
        </div>
      </div>
    </div>
  );
}

export default memo(ComplianceRing);
