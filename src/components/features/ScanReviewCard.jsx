import { useState, memo } from "react";
import { useApp } from "../../context/AppContext";
import { useInputStyle } from "../shared/useInputStyle";
import { SECTION_META, getLicenseTypes, PRIVILEGE_TYPES, INSURANCE_TYPES, HEALTH_RECORD_CATEGORIES, getHealthRecordTypes, TB_RESULTS, EDUCATION_TYPES } from "../../constants/credentialTypes";

const FIELD_DEFS = {
  license: [
    { key: "type", label: "Type" }, { key: "name", label: "Display Name" },
    { key: "licenseNumber", label: "License #" }, { key: "state", label: "State" },
    { key: "issuedDate", label: "Issued", type: "date" }, { key: "expirationDate", label: "Expires", type: "date" },
  ],
  cme: [
    { key: "title", label: "Activity / Title" }, { key: "category", label: "Category" },
    { key: "hours", label: "Hours", type: "number" }, { key: "date", label: "Completed", type: "date" },
    { key: "provider", label: "Provider" }, { key: "certificateNumber", label: "Certificate #" },
  ],
  privilege: [
    { key: "type", label: "Type" }, { key: "name", label: "Display Name" },
    { key: "facility", label: "Facility" }, { key: "state", label: "State" },
    { key: "appointmentDate", label: "Appointed", type: "date" }, { key: "expirationDate", label: "Expires", type: "date" },
  ],
  insurance: [
    { key: "type", label: "Type" }, { key: "name", label: "Display Name" },
    { key: "provider", label: "Carrier" }, { key: "policyNumber", label: "Policy #" },
    { key: "coveragePerClaim", label: "Per Claim" }, { key: "coverageAggregate", label: "Aggregate" },
    { key: "effectiveDate", label: "Effective", type: "date" }, { key: "expirationDate", label: "Expires", type: "date" },
  ],
  healthRecord: [
    { key: "category", label: "Category" }, { key: "type", label: "Type" },
    { key: "name", label: "Display Name" }, { key: "dateAdministered", label: "Date Administered", type: "date" },
    { key: "expirationDate", label: "Expires", type: "date" }, { key: "result", label: "Result" },
    { key: "lotNumber", label: "Lot / Batch #" }, { key: "facility", label: "Administrator / Facility" },
  ],
  education: [
    { key: "type", label: "Type" }, { key: "name", label: "Display Name" },
    { key: "institution", label: "Institution" }, { key: "graduationDate", label: "Graduation Date", type: "date" },
    { key: "fieldOfStudy", label: "Field of Study / Specialty" }, { key: "honors", label: "Honors" },
  ],
};

const TYPE_OPTIONS = {
  license: (deg) => getLicenseTypes(deg),
  privilege: () => PRIVILEGE_TYPES,
  insurance: () => INSURANCE_TYPES,
  healthRecord: (_deg, edited) => getHealthRecordTypes(edited?.category),
  education: () => EDUCATION_TYPES,
};

function ScanReviewCard({ result, imageData, fileName, onSave, onDiscard }) {
  const { theme: T, data } = useApp();
  const iS = useInputStyle();
  const [edited, setEdited] = useState({ ...result.extracted });
  const [docType, setDocType] = useState(result.documentType);
  const meta = SECTION_META[docType] || SECTION_META.unknown;
  const confColor = result.confidence === "high" ? T.success : result.confidence === "medium" ? T.warning : T.danger;
  const fields = FIELD_DEFS[docType] || [];
  const typeOpts = TYPE_OPTIONS[docType]?.(data.settings.degreeType, edited) || null;

  return (
    <div style={{ backgroundColor: T.card, border: `2px solid ${meta.color}`, borderRadius: 16, overflow: "hidden", marginBottom: 12, boxShadow: T.shadow1 }}>
      {/* Header */}
      <div style={{
        padding: "14px 18px", backgroundColor: meta.color + "18", borderBottom: `1px solid ${meta.color}40`,
        display: "flex", alignItems: "center", justifyContent: "space-between",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: 24 }}>{meta.icon}</span>
          <div>
            <div style={{ fontSize: 15, fontWeight: 700, color: T.text }}>{meta.label}</div>
            <div style={{ fontSize: 13, color: T.textDim }}>{fileName}</div>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <div style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: confColor }} />
          <span style={{ fontSize: 12, fontWeight: 600, color: confColor, textTransform: "capitalize" }}>{result.confidence}</span>
        </div>
      </div>

      {/* Image preview */}
      {imageData?.startsWith("data:image") && (
        <div style={{ padding: "10px 18px", backgroundColor: T.bg }}>
          <img src={imageData} alt="scanned" style={{ width: "100%", maxHeight: 140, objectFit: "contain", borderRadius: 10 }} />
        </div>
      )}

      {/* Reclassify */}
      <div style={{ padding: "10px 18px", display: "flex", alignItems: "center", gap: 4, borderBottom: `1px solid ${T.border}` }}>
        <span style={{ fontSize: 12, color: T.textDim, marginRight: 6 }}>Not right?</span>
        {["license", "cme", "privilege", "insurance", "healthRecord", "education"].map(dt => (
          <button key={dt} onClick={() => setDocType(dt)} style={{
            padding: "4px 10px", borderRadius: 6, border: "none", fontSize: 11, fontWeight: 600, cursor: "pointer",
            backgroundColor: dt === docType ? meta.color : T.input,
            color: dt === docType ? "#fff" : T.textMuted,
          }}>
            {SECTION_META[dt].label.split(" ")[0]}
          </button>
        ))}
      </div>

      {/* Fields */}
      <div style={{ padding: "14px 18px" }}>
        {docType === "unknown" ? (
          <div style={{ textAlign: "center", padding: "18px 0", color: T.textMuted, fontSize: 15 }}>
            Could not identify this document. Tap a category above to classify it manually.
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {fields.map(f => (
              <div key={f.key}>
                <div style={{ fontSize: 12, fontWeight: 700, color: T.textDim, textTransform: "uppercase", marginBottom: 2 }}>{f.label}</div>
                {f.key === "category" && docType === "healthRecord" ? (
                  <select
                    value={edited[f.key] || ""}
                    onChange={e => setEdited(p => ({ ...p, [f.key]: e.target.value, type: "" }))}
                    style={{ ...iS, appearance: "auto", borderColor: edited[f.key] ? T.success + "60" : T.inputBorder }}
                  >
                    <option value="">Select category...</option>
                    {HEALTH_RECORD_CATEGORIES.map(o => <option key={o} value={o}>{o}</option>)}
                  </select>
                ) : f.key === "result" && docType === "healthRecord" ? (
                  <select
                    value={edited[f.key] || ""}
                    onChange={e => setEdited(p => ({ ...p, [f.key]: e.target.value }))}
                    style={{ ...iS, appearance: "auto", borderColor: edited[f.key] ? T.success + "60" : T.inputBorder }}
                  >
                    <option value="">Select result...</option>
                    {TB_RESULTS.map(o => <option key={o} value={o}>{o}</option>)}
                  </select>
                ) : f.key === "type" && typeOpts ? (
                  <select
                    value={edited[f.key] || ""}
                    onChange={e => setEdited(p => ({ ...p, [f.key]: e.target.value }))}
                    style={{ ...iS, appearance: "auto", borderColor: edited[f.key] ? T.success + "60" : T.inputBorder }}
                  >
                    <option value="">Select type...</option>
                    {typeOpts.map(o => <option key={o} value={o}>{o}</option>)}
                  </select>
                ) : (
                  <input
                    type={f.type || "text"}
                    value={edited[f.key] || ""}
                    onChange={e => setEdited(p => ({ ...p, [f.key]: e.target.value }))}
                    style={{ ...iS, borderColor: edited[f.key] ? T.success + "60" : T.inputBorder }}
                  />
                )}
              </div>
            ))}
            {docType === "cme" && edited.topics?.length > 0 && (
              <div>
                <div style={{ fontSize: 12, fontWeight: 700, color: T.textDim, textTransform: "uppercase", marginBottom: 6 }}>Detected Topics</div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                  {edited.topics.map(t => (
                    <span key={t} style={{ fontSize: 12, padding: "2px 8px", borderRadius: 8, backgroundColor: T.accentGlow, color: T.accent, fontWeight: 600 }}>{t}</span>
                  ))}
                </div>
              </div>
            )}
            {docType === "healthRecord" && edited.doses?.length > 0 && (
              <div>
                <div style={{ fontSize: 12, fontWeight: 700, color: T.textDim, textTransform: "uppercase", marginBottom: 6 }}>Detected Doses ({edited.doses.length})</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  {edited.doses.map((dose, i) => (
                    <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", borderRadius: 8, backgroundColor: T.input, fontSize: 13 }}>
                      <span style={{ fontWeight: 700, color: meta.color, minWidth: 18 }}>#{dose.doseNumber || i + 1}</span>
                      <span style={{ color: T.text, fontWeight: 600 }}>{dose.date || "\u2014"}</span>
                      {dose.manufacturer && <span style={{ color: T.textDim }}>{dose.manufacturer}</span>}
                      {dose.lotNumber && <span style={{ color: T.textDim }}>Lot: {dose.lotNumber}</span>}
                      {dose.facility && <span style={{ color: T.textDim }}>{dose.facility}</span>}
                    </div>
                  ))}
                </div>
              </div>
            )}
            {result.notes && <div style={{ fontSize: 13, color: T.textDim, fontStyle: "italic", marginTop: 6 }}>{result.notes}</div>}
          </div>
        )}
      </div>

      {/* Actions */}
      {docType !== "unknown" ? (
        <div style={{ padding: "0 18px 16px", display: "flex", gap: 10 }}>
          <button onClick={() => onSave(docType, edited, imageData, fileName)} style={{
            flex: 1, padding: "12px", borderRadius: 12, border: "none", backgroundColor: meta.color, color: "#fff",
            fontSize: 15, fontWeight: 700, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
          }}>
            Save to {meta.label.split("/")[0].trim()}
          </button>
          <button onClick={onDiscard} style={{
            padding: "12px 18px", borderRadius: 12, border: `1px solid ${T.border}`, backgroundColor: "transparent",
            color: T.textMuted, fontSize: 14, fontWeight: 600, cursor: "pointer",
          }}>Discard</button>
        </div>
      ) : (
        <div style={{ padding: "0 18px 16px" }}>
          <button onClick={onDiscard} style={{
            width: "100%", padding: "12px", borderRadius: 12, border: `1px solid ${T.border}`, backgroundColor: "transparent",
            color: T.textMuted, fontSize: 14, fontWeight: 600, cursor: "pointer",
          }}>Discard</button>
        </div>
      )}
    </div>
  );
}

export default memo(ScanReviewCard);
