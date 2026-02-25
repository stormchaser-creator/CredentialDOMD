import { memo } from "react";

const svg = (children, size = 22) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    {children}
  </svg>
);

export const HomeIcon = memo(() => svg(<><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></>));
export const DocsIcon = memo(() => svg(<><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></>));
export const ShareIcon = memo(() => svg(<><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></>));
export const CredsIcon = memo(() => svg(<><rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/></>));
export const MoreIcon = memo(() => svg(<><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></>));
export const UploadIcon = memo(() => svg(<><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></>, 18));
export const CameraIcon = memo(() => svg(<><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></>, 18));
export const ScanIcon = memo(() => svg(<><path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/><path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/><line x1="7" y1="12" x2="17" y2="12"/></>, 18));
export const CheckIcon = memo(() => svg(<><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></>, 18));
export const AlertIcon = memo(() => svg(<><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></>, 16));
export const EditIcon = memo(() => svg(<><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></>, 14));
export const TrashIcon = memo(() => svg(<><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></>, 14));
export const SendIcon = memo(() => svg(<><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></>, 14));
export const CloseIcon = memo(() => svg(<><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></>, 20));
export const PlusIcon = memo(() => svg(<><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></>, 18));
export const SearchIcon = memo(() => svg(<><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></>, 16));
export const EmailIcon = memo(() => svg(<><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></>, 18));
export const TextMsgIcon = memo(() => svg(<><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></>, 18));
export const CopyIcon = memo(() => svg(<><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></>, 18));
export const HistoryIcon = memo(() => svg(<><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></>, 18));
export const SunIcon = memo(() => svg(<><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></>, 18));
export const MoonIcon = memo(() => svg(<><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></>, 18));
export const BellIcon = memo(() => svg(<><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></>, 20));
export const BackIcon = memo(() => svg(<><polyline points="15 18 9 12 15 6"/></>, 20));
export const FileIcon = memo(() => svg(<><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/></>, 16));
export const ExternalLinkIcon = memo(() => svg(<><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></>, 14));
export const GraduationIcon = memo(() => svg(<><path d="M22 10v6M2 10l10-5 10 5-10 5z"/><path d="M6 12v5c0 1.66 2.69 3 6 3s6-1.34 6-3v-5"/></>, 18));

// Rod of Asclepius — single serpent wrapped around a staff
export const AsclepiusIcon = memo(({ size = 28, color }) => (
  <svg width={size} height={size} viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
    {/* Staff */}
    <line x1="16" y1="3" x2="16" y2="29" stroke={color || "currentColor"} strokeWidth="2.2" strokeLinecap="round" />
    {/* Staff top ornament */}
    <circle cx="16" cy="3" r="1.5" fill={color || "currentColor"} />
    {/* Serpent body — sinuous S-curves wrapping around the staff */}
    <path
      d="M16 8 C20 8, 22 10, 22 12 C22 14, 20 15.5, 16 15.5 C12 15.5, 10 17, 10 19 C10 21, 12 22.5, 16 22.5 C20 22.5, 22 24, 22 25.5"
      stroke={color || "currentColor"}
      strokeWidth="2"
      strokeLinecap="round"
      fill="none"
    />
    {/* Serpent head */}
    <circle cx="22" cy="25.5" r="1.8" fill={color || "currentColor"} />
    {/* Serpent eye */}
    <circle cx="22.6" cy="25" r="0.5" fill={color === "#fff" || color === "#ffffff" ? "#1a2744" : "#fff"} />
  </svg>
));

// Logo lockup — Rod of Asclepius + CREDENTIALMD text
export const LogoMark = memo(({ color = "#fff", accentColor, size = "default" }) => {
  const iconSize = size === "small" ? 22 : 28;
  const fontSize = size === "small" ? 16 : 22;
  const subSize = size === "small" ? 8 : 9;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: size === "small" ? 8 : 10 }}>
      <div style={{
        width: iconSize + 8, height: iconSize + 8, borderRadius: iconSize / 2.5,
        background: accentColor || "rgba(255,255,255,0.12)",
        display: "flex", alignItems: "center", justifyContent: "center",
        boxShadow: `0 0 20px ${accentColor || "rgba(255,255,255,0.08)"}`,
      }}>
        <AsclepiusIcon size={iconSize} color={color} />
      </div>
      <div>
        <div style={{
          fontSize, fontWeight: 800, color, letterSpacing: 1.5,
          lineHeight: 1, fontFamily: "'DM Sans', sans-serif",
        }}>
          CREDENTIAL<span style={{ opacity: 0.7 }}>MD</span>
        </div>
        <div style={{
          fontSize: subSize, fontWeight: 600, color, opacity: 0.5,
          letterSpacing: 2, textTransform: "uppercase", marginTop: 2,
        }}>
          Physician Credentials
        </div>
      </div>
    </div>
  );
});
