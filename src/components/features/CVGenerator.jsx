import { useState, useMemo, memo } from "react";
import { useApp } from "../../context/AppContext";
import { AsclepiusIcon, ExternalLinkIcon } from "../shared/Icons";
import { formatDate, copyToClipboard } from "../../utils/helpers";
import { computeCompliance } from "../../utils/compliance";

const CV_TEMPLATES = [
  { id: "clinical", name: "Clinical CV", description: "Standard format for hospital credentialing" },
  { id: "academic", name: "Academic CV", description: "Detailed format for academic positions" },
  { id: "locum", name: "Locum Tenens", description: "Compact format for locum assignments" },
];

function CVGenerator() {
  const { data, theme: T, allTrackedStates } = useApp();
  const [template, setTemplate] = useState("clinical");
  const [preview, setPreview] = useState(true);

  const s = data.settings;

  // Build CV content
  const cvContent = useMemo(() => {
    const sections = [];
    const deg = s.degreeType || "MD";
    const fullDegree = deg === "DO" ? "Doctor of Osteopathic Medicine" : "Doctor of Medicine";

    // HEADER
    sections.push({
      type: "header",
      name: s.name || "Physician Name",
      degree: deg,
      npi: s.npi,
      email: s.email,
      phone: s.phone,
      specialties: s.specialties || [],
    });

    // EDUCATION
    if (data.education?.length > 0) {
      sections.push({
        type: "section",
        title: "Education & Training",
        items: [...data.education].sort((a, b) => {
          const da = a.graduationDate ? new Date(a.graduationDate) : new Date(0);
          const db = b.graduationDate ? new Date(b.graduationDate) : new Date(0);
          return db - da;
        }).map(e => ({
          primary: e.type || "Degree",
          secondary: e.institution || "",
          detail: [e.fieldOfStudy, e.honors].filter(Boolean).join(" | "),
          date: e.graduationDate ? formatDate(e.graduationDate) : "",
        })),
      });
    }

    // LICENSES & CERTIFICATIONS
    if (data.licenses.length > 0) {
      const licenseItems = [...data.licenses].sort((a, b) => {
        const order = { "State Medical License": 0, "State Medical License (DO)": 0, "DEA Registration": 1 };
        const oa = order[a.type] ?? 2;
        const ob = order[b.type] ?? 2;
        return oa - ob;
      }).map(l => ({
        primary: l.name || l.type,
        secondary: [l.state, l.licenseNumber ? `#${l.licenseNumber}` : ""].filter(Boolean).join(" | "),
        date: l.expirationDate ? `Exp: ${formatDate(l.expirationDate)}` : "",
        status: l.expirationDate && new Date(l.expirationDate) < new Date() ? "expired" : "active",
      }));
      sections.push({ type: "section", title: "Licensure & Certifications", items: licenseItems });
    }

    // HOSPITAL PRIVILEGES
    if (data.privileges.length > 0) {
      sections.push({
        type: "section",
        title: "Hospital Privileges",
        items: data.privileges.map(p => ({
          primary: p.name || p.type,
          secondary: [p.facility, p.state].filter(Boolean).join(", "),
          date: p.expirationDate ? `Reappointment: ${formatDate(p.expirationDate)}` : "",
        })),
      });
    }

    // INSURANCE (only for clinical template)
    if (template !== "locum" && data.insurance.length > 0) {
      sections.push({
        type: "section",
        title: "Professional Liability Insurance",
        items: data.insurance.map(i => ({
          primary: i.name || i.type,
          secondary: [i.provider, i.policyNumber ? `Policy #${i.policyNumber}` : ""].filter(Boolean).join(" | "),
          detail: [i.coveragePerClaim ? `${i.coveragePerClaim}/claim` : "", i.coverageAggregate ? `${i.coverageAggregate} aggregate` : ""].filter(Boolean).join(", "),
          date: i.expirationDate ? `Exp: ${formatDate(i.expirationDate)}` : "",
        })),
      });
    }

    // CME SUMMARY
    if (data.cme.length > 0) {
      const totalHrs = data.cme.reduce((s, c) => s + (parseFloat(c.hours) || 0), 0);
      const categories = {};
      data.cme.forEach(c => {
        const cat = c.category || "Other";
        categories[cat] = (categories[cat] || 0) + (parseFloat(c.hours) || 0);
      });

      const cmeItems = [
        { primary: `Total CME Hours: ${totalHrs}`, secondary: Object.entries(categories).map(([k, v]) => `${k}: ${v}h`).join(" | "), date: "" },
      ];

      // State compliance summary
      if (allTrackedStates.length > 0) {
        allTrackedStates.forEach(st => {
          const comp = computeCompliance(data.cme, st, deg);
          cmeItems.push({
            primary: `${st} Compliance: ${comp.fullyCompliant ? "Met" : "In Progress"}`,
            secondary: comp.noGeneralReq ? "Topic-specific requirements" : `${comp.totalEarned}/${comp.totalRequired} hours`,
            date: "",
          });
        });
      }

      if (template === "academic") {
        // Academic includes full CME list
        const recentCME = [...data.cme].sort((a, b) => {
          const da = a.date ? new Date(a.date) : new Date(0);
          const db = b.date ? new Date(b.date) : new Date(0);
          return db - da;
        }).slice(0, 20).map(c => ({
          primary: c.title || c.category || "CME Activity",
          secondary: [c.provider, c.hours ? `${c.hours} hrs` : "", c.category].filter(Boolean).join(" | "),
          date: c.date ? formatDate(c.date) : "",
        }));
        sections.push({ type: "section", title: "Continuing Medical Education", items: [...cmeItems, ...recentCME] });
      } else {
        sections.push({ type: "section", title: "CME Summary", items: cmeItems });
      }
    }

    // CASE LOGS (only for clinical and academic)
    if (template !== "locum" && data.caseLogs?.length > 0) {
      const categoryCounts = {};
      data.caseLogs.forEach(c => {
        const cat = c.category || "Other";
        categoryCounts[cat] = (categoryCounts[cat] || 0) + 1;
      });
      sections.push({
        type: "section",
        title: "Surgical Case Log Summary",
        items: Object.entries(categoryCounts).sort((a, b) => b[1] - a[1]).map(([cat, count]) => ({
          primary: cat, secondary: `${count} case${count > 1 ? "s" : ""}`, date: "",
        })),
      });
    }

    // WORK HISTORY
    if (data.workHistory?.length > 0) {
      sections.push({
        type: "section",
        title: "Professional Experience",
        items: [...data.workHistory].sort((a, b) => {
          const da = a.startDate ? new Date(a.startDate) : new Date(0);
          const db = b.startDate ? new Date(b.startDate) : new Date(0);
          return db - da;
        }).map(w => ({
          primary: w.position || "Physician",
          secondary: [w.employer, w.city, w.state].filter(Boolean).join(", "),
          detail: w.description || "",
          date: [w.startDate ? formatDate(w.startDate) : "", w.current ? "Present" : (w.endDate ? formatDate(w.endDate) : "")].filter(Boolean).join(" - "),
        })),
      });
    }

    // PEER REFERENCES
    if (template === "clinical" && data.peerReferences?.length > 0) {
      sections.push({
        type: "section",
        title: "Professional References",
        items: data.peerReferences.map(r => ({
          primary: `${r.name}${r.degree ? `, ${r.degree}` : ""}`,
          secondary: [r.specialty, r.institution].filter(Boolean).join(" | "),
          detail: [r.email, r.phone].filter(Boolean).join(" | "),
          date: r.relationship || "",
        })),
      });
    }

    // HEALTH RECORDS summary (for credentialing CV)
    if (template === "clinical" && data.healthRecords?.length > 0) {
      sections.push({
        type: "section",
        title: "Health Clearances",
        items: data.healthRecords.map(h => ({
          primary: h.type || h.category,
          secondary: [h.result, h.facility].filter(Boolean).join(" | "),
          date: h.dateAdministered ? formatDate(h.dateAdministered) : "",
        })),
      });
    }

    return sections;
  }, [data, template, s, allTrackedStates]);

  // Generate plain text
  const generatePlainText = () => {
    const lines = [];
    const divider = "=".repeat(60);
    const subDivider = "-".repeat(40);

    cvContent.forEach(section => {
      if (section.type === "header") {
        lines.push(divider);
        lines.push(`  ${section.name}, ${section.degree}`);
        if (section.npi) lines.push(`  NPI: ${section.npi}`);
        if (section.email || section.phone) {
          lines.push(`  ${[section.email, section.phone].filter(Boolean).join(" | ")}`);
        }
        if (section.specialties.length > 0) {
          const names = section.specialties.map(id => id.split(":").pop());
          lines.push(`  Specialty: ${names.join(", ")}`);
        }
        lines.push(divider);
        lines.push("");
      } else {
        lines.push(section.title.toUpperCase());
        lines.push(subDivider);
        section.items.forEach(item => {
          const datePart = item.date ? `  [${item.date}]` : "";
          lines.push(`  ${item.primary}${datePart}`);
          if (item.secondary) lines.push(`    ${item.secondary}`);
          if (item.detail) lines.push(`    ${item.detail}`);
        });
        lines.push("");
      }
    });

    lines.push(subDivider);
    lines.push(`Generated by CredentialDOMD | ${new Date().toLocaleDateString()}`);
    return lines.join("\n");
  };

  const handleCopyCV = async () => {
    await copyToClipboard(generatePlainText());
  };

  const handlePrintCV = () => {
    const text = generatePlainText();
    const w = window.open("", "_blank");
    if (!w) return;
    const doc = w.document;
    doc.open();
    const style = doc.createElement("style");
    style.textContent = "body{font-family:'SF Pro Display','DM Sans',sans-serif;max-width:700px;margin:40px auto;padding:0 20px;color:#1a1a1a;line-height:1.6;font-size:13px}pre{white-space:pre-wrap;font-family:inherit}";
    doc.head.appendChild(style);
    doc.title = `CV - ${s.name || "Physician"}`;
    const pre = doc.createElement("pre");
    pre.textContent = text;
    doc.body.appendChild(pre);
    doc.close();
    w.onafterprint = () => w.close();
    w.print();
  };

  const hasData = data.licenses.length > 0 || data.education?.length > 0 || data.cme.length > 0;

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
        <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: T.text }}>CV Generator</h2>
      </div>
      <p style={{ margin: "0 0 16px", fontSize: 14, color: T.textMuted }}>
        Auto-generate a professional CV from your credential data.
      </p>

      {/* Template selector */}
      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        {CV_TEMPLATES.map(t => (
          <button key={t.id} onClick={() => setTemplate(t.id)} style={{
            flex: 1, padding: "12px 10px", borderRadius: 12,
            border: `1px solid ${template === t.id ? T.accent : T.border}`,
            backgroundColor: template === t.id ? T.accentGlow : T.card,
            cursor: "pointer", textAlign: "center",
          }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: template === t.id ? T.accent : T.text }}>{t.name}</div>
            <div style={{ fontSize: 12, color: T.textDim, marginTop: 2 }}>{t.description}</div>
          </button>
        ))}
      </div>

      {/* Action buttons */}
      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        <button onClick={handleCopyCV} style={{
          flex: 1, padding: "12px 16px", borderRadius: 12, border: "none",
          backgroundColor: T.accent, color: "#fff", fontSize: 14, fontWeight: 600, cursor: "pointer",
        }}>Copy to Clipboard</button>
        <button onClick={handlePrintCV} style={{
          flex: 1, padding: "12px 16px", borderRadius: 12, border: `1px solid ${T.border}`,
          backgroundColor: T.card, color: T.text, fontSize: 14, fontWeight: 600, cursor: "pointer",
        }}>Print / Save PDF</button>
      </div>

      {!hasData && (
        <div style={{ textAlign: "center", padding: "26px 18px", backgroundColor: T.card, borderRadius: 14, border: `1px solid ${T.border}`, boxShadow: T.shadow1 }}>
          <div style={{ marginBottom: 10 }}><AsclepiusIcon size={32} color={T.textDim} /></div>
          <div style={{ fontSize: 15, fontWeight: 600, color: T.text, marginBottom: 4 }}>Add credentials first</div>
          <div style={{ fontSize: 14, color: T.textMuted }}>Your CV will be auto-generated from the licenses, education, and other credentials you add.</div>
        </div>
      )}

      {/* Preview */}
      {hasData && (
        <div>
          <button onClick={() => setPreview(!preview)} style={{
            padding: "6px 12px", fontSize: 13, fontWeight: 600, borderRadius: 8,
            border: `1px solid ${T.border}`, backgroundColor: "transparent", color: T.textMuted,
            cursor: "pointer", marginBottom: 10,
          }}>{preview ? "Hide Preview" : "Show Preview"}</button>

          {preview && (
            <div style={{
              backgroundColor: T.card, border: `1px solid ${T.border}`, borderRadius: 14,
              padding: "18px 20px", boxShadow: T.shadow1,
            }}>
              {cvContent.map((section, idx) => {
                if (section.type === "header") {
                  return (
                    <div key={idx} style={{ marginBottom: 16, paddingBottom: 12, borderBottom: `2px solid ${T.accent}` }}>
                      <div style={{ fontSize: 20, fontWeight: 800, color: T.text }}>{section.name}, {section.degree}</div>
                      {section.npi && <div style={{ fontSize: 14, color: T.textMuted }}>NPI: {section.npi}</div>}
                      <div style={{ fontSize: 14, color: T.textMuted }}>{[section.email, section.phone].filter(Boolean).join(" | ")}</div>
                      {section.specialties.length > 0 && (
                        <div style={{ fontSize: 14, color: T.accent, fontWeight: 600, marginTop: 2 }}>
                          {section.specialties.map(id => id.split(":").pop()).join(", ")}
                        </div>
                      )}
                    </div>
                  );
                }
                return (
                  <div key={idx} style={{ marginBottom: 14 }}>
                    <div style={{ fontSize: 15, fontWeight: 700, color: T.accent, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 8, borderBottom: `1px solid ${T.border}`, paddingBottom: 4 }}>
                      {section.title}
                    </div>
                    {section.items.map((item, i) => (
                      <div key={i} style={{ marginBottom: 10, paddingLeft: 10 }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                          <div style={{ fontSize: 15, fontWeight: 600, color: T.text }}>{item.primary}</div>
                          {item.date && <div style={{ fontSize: 12, color: T.textDim, flexShrink: 0, marginLeft: 10 }}>{item.date}</div>}
                        </div>
                        {item.secondary && <div style={{ fontSize: 13, color: T.textMuted }}>{item.secondary}</div>}
                        {item.detail && <div style={{ fontSize: 13, color: T.textDim }}>{item.detail}</div>}
                      </div>
                    ))}
                  </div>
                );
              })}
              <div style={{ fontSize: 11, color: T.textDim, textAlign: "center", marginTop: 10, borderTop: `1px solid ${T.border}`, paddingTop: 8 }}>
                Generated by CredentialDOMD | {new Date().toLocaleDateString()}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default memo(CVGenerator);
