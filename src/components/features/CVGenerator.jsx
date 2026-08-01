import { useState, useMemo, memo } from "react";
import { useApp } from "../../context/AppContext";
import { AsclepiusIcon, ExternalLinkIcon } from "../shared/Icons";
import { formatDate, copyToClipboard } from "../../utils/helpers";
import { shareCvPdf } from "../../utils/cvPdf";

const STATE_NAMES = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado",
  CT: "Connecticut", DE: "Delaware", FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho",
  IL: "Illinois", IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky", LA: "Louisiana",
  ME: "Maine", MD: "Maryland", MA: "Massachusetts", MI: "Michigan", MN: "Minnesota",
  MS: "Mississippi", MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada",
  NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico", NY: "New York", NC: "North Carolina",
  ND: "North Dakota", OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania",
  RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota", TN: "Tennessee", TX: "Texas",
  UT: "Utah", VT: "Vermont", VA: "Virginia", WA: "Washington", WV: "West Virginia",
  WI: "Wisconsin", WY: "Wyoming", DC: "District of Columbia",
};

const CV_TEMPLATES = [
  { id: "clinical", name: "Clinical CV", description: "Standard format for hospital credentialing" },
  { id: "academic", name: "Academic CV", description: "Detailed format for academic positions" },
  { id: "locum", name: "Locum Tenens", description: "Compact format for locum assignments" },
];

function CVGenerator() {
  const { data, theme: T } = useApp();
  const [template, setTemplate] = useState("clinical");
  const [preview, setPreview] = useState(true);
  const [note, setNote] = useState("");

  const s = data.settings;

  // Build CV content — section order and presentation follow Eric's real CV
  // (Whitney CV 2026): summary → experience → education → medical student →
  // languages → license block → privileges → publications → organizations →
  // professional development. Dates ride inline in parentheses, as on paper.
  const cvContent = useMemo(() => {
    const sections = [];
    const deg = s.degreeType || "MD";
    const fullDegree = deg === "DO" ? "Doctor of Osteopathic Medicine" : "Doctor of Medicine";
    const yr = (d) => (d ? String(d).slice(0, 4) : "");
    const longDate = (d) => {
      if (!d) return "";
      const dt = new Date(d + (String(d).length === 10 ? "T12:00:00" : ""));
      return isNaN(dt) ? String(d) : dt.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
    };
    const range = (a, b, current) => {
      const from = longDate(a);
      const to = current ? "current" : longDate(b);
      if (!from && !to) return "";
      return `${from || "?"} \u2013 ${to || "current"}`;
    };

    // HEADER — Dr. Name / address / email / website / phone
    sections.push({
      type: "header",
      name: s.name ? `Dr. ${s.name}` : "Physician Name",
      degree: deg,
      fullDegree,
      address: s.address || "",
      email: s.email,
      website: s.website || "",
      phone: s.phone,
      npi: "", // NPI lives in the License section, as on the paper CV
      specialties: s.specialties || [],
    });

    // PROFESSIONAL SUMMARY + highlight line
    if (s.professionalSummary || s.cvHighlights) {
      sections.push({
        type: "section",
        title: "Professional Summary",
        items: [
          ...(s.professionalSummary ? [{ primary: "", secondary: s.professionalSummary, date: "" }] : []),
          ...(s.cvHighlights ? [{ primary: s.cvHighlights, secondary: "", date: "" }] : []),
        ],
      });
    }

    // PROFESSIONAL EXPERIENCE — employer (dates) bold, then role + detail
    if (data.workHistory?.length > 0) {
      sections.push({
        type: "section",
        title: "Professional Experience",
        items: [...data.workHistory].sort((a, b) => {
          const da = a.startDate ? new Date(a.startDate) : new Date(0);
          const db = b.startDate ? new Date(b.startDate) : new Date(0);
          return db - da;
        }).map(w => ({
          primary: `${w.employer || w.position || "Position"}${w.startDate || w.endDate || w.current ? ` (${range(w.startDate, w.endDate, w.current)})` : ""}`,
          secondary: [w.position, [w.city, w.state].filter(Boolean).join(", ")].filter(Boolean).join(" \u2014 "),
          detail: w.description || "",
          date: "",
        })),
      });
    }

    // EDUCATION — "name, years, institution" single lines, newest first
    if (data.education?.length > 0) {
      const isActivity = (e) => /activity|club|leadership/i.test(e.type || "");
      const eduSort = (arr) => [...arr].sort((a, b) => {
        const da = a.graduationDate ? new Date(a.graduationDate) : new Date(0);
        const db = b.graduationDate ? new Date(b.graduationDate) : new Date(0);
        return db - da;
      });
      const edu = eduSort(data.education.filter(e => !isActivity(e)));
      const activities = eduSort(data.education.filter(isActivity));
      sections.push({
        type: "section",
        title: "Education",
        items: edu.map(e => ({
          primary: `${e.name && !/^\s*(dr\.?\s)?[a-z][a-z.'-]+(\s[a-z][a-z.'-]+){1,3}\s*$/i.test(e.name) ? e.name : (e.type || "Degree")}${e.graduationDate ? `, ${yr(e.graduationDate)}` : ""}`,
          secondary: [e.institution, e.fieldOfStudy, e.honors].filter(Boolean).join(" | "),
          detail: "",
          date: "",
        })),
      });
      if (activities.length > 0) {
        sections.push({
          type: "section",
          title: "Medical Student",
          items: activities.map(e => ({
            primary: `${e.name || e.type}${e.graduationDate ? ` ${yr(e.graduationDate)}` : ""}`,
            secondary: e.institution || "",
            date: "",
          })),
        });
      }
    }

    // LANGUAGES
    if (s.languages) {
      sections.push({ type: "section", title: "Languages", items: [{ primary: s.languages, secondary: "", date: "" }] });
    }

    // LICENSE — NPI, board certification, medical licenses, DEA (as on paper)
    {
      const items = [];
      if (s.npi) items.push({ primary: `NPI: ${s.npi}`, secondary: "", date: "" });
      const lic = data.licenses || [];
      const isBoard = (l) => /board/i.test(l.type || "");
      const isMedical = (l) => /medical license/i.test(l.type || "");
      const isDEA = (l) => /dea/i.test(l.type || "");
      const looksLikePersonName = (n) => !n || /^\s*[a-z][a-z.,'-]*(\s[a-z.,'-]+){1,4}\s*$/i.test(n) && !/board|surgery|medicine|academy|american/i.test(n);
      for (const b of lic.filter(isBoard)) {
        items.push({
          primary: looksLikePersonName(b.name) ? b.type : b.name,
          secondary: [b.licenseNumber ? `Certificate ${b.licenseNumber}` : "", b.expirationDate ? `Expires ${formatDate(b.expirationDate)}` : ""].filter(Boolean).join(" \u00b7 "),
          date: "",
        });
      }
      const meds = lic.filter(isMedical);
      if (meds.length > 0) {
        items.push({ primary: "Medical Licenses", secondary: "", date: "", subhead: true });
        for (const m of meds) {
          const provisional = /provisional|temporary/i.test(m.type || "") ? " (provisional temporary)" : "";
          items.push({ primary: `${STATE_NAMES[m.state] || m.state || ""}: ${m.licenseNumber || ""}${provisional}`, secondary: "", date: "" });
        }
      }
      const deas = lic.filter(isDEA);
      if (deas.length > 0) {
        items.push({ primary: "DEA", secondary: "", date: "", subhead: true });
        for (const d of deas) {
          items.push({ primary: `DEA ${d.state || ""}: ${d.licenseNumber || ""}`, secondary: "", date: "" });
        }
      }
      if (items.length > 0) sections.push({ type: "section", title: "License", items });
    }

    // HOSPITAL PRIVILEGES — "Facility: (start to current) City, ST"
    if (data.privileges.length > 0) {
      sections.push({
        type: "section",
        title: "Hospital Privileges",
        items: data.privileges.map(p => {
          const from = longDate(p.appointmentDate);
          const active = !p.expirationDate || new Date(p.expirationDate) >= new Date();
          const span = from ? `(${from} to ${active ? "current" : formatDate(p.expirationDate)})` : "";
          const place = [p.city || p.customFields?.city, p.state].filter(Boolean).join(", ");
          return {
            primary: `${p.facility || p.name}${span ? `: ${span}` : ""}${place ? ` ${place}` : ""}`,
            secondary: "",
            date: "",
          };
        }),
      });
    }

    // PUBLICATIONS — full citations in the order set (sortOrder, then year desc)
    if (data.publications?.length > 0) {
      const pubs = [...data.publications].sort((a, b) => {
        const ao = a.sortOrder ?? null, bo = b.sortOrder ?? null;
        if (ao != null && bo != null) return ao - bo;
        if (ao != null) return -1;
        if (bo != null) return 1;
        return (b.year || "").localeCompare(a.year || "");
      });
      sections.push({
        type: "section",
        title: "Publications",
        items: pubs.map(p => ({ primary: "", secondary: p.citation || p.name || "", date: "" })),
      });
    }

    // PROFESSIONAL ORGANIZATIONS
    if (data.memberships?.length > 0) {
      sections.push({
        type: "section",
        title: "Professional Organizations",
        items: data.memberships.map(m => ({
          primary: m.organization ? `${m.role || "Member"} of the ${m.organization}` : (m.name || ""),
          secondary: "",
          date: "",
        })),
      });
    }

    // CONTINUAL PROFESSIONAL DEVELOPMENT — named courses (CME category "Course")
    {
      const courses = (data.cme || []).filter(c => /course/i.test(c.category || ""));
      const items = courses.map(c => ({
        primary: `${c.title || "Course"}${c.date ? ` ${c.date.length <= 7 ? yr(c.date) : formatDate(c.date)}` : ""}`,
        secondary: c.provider || "",
        date: "",
      }));
      if (template === "academic") {
        const tracked = (data.cme || []).filter(c => !/course/i.test(c.category || ""));
        const recent = [...tracked].sort((a, b) => {
          const da = a.date ? new Date(a.date) : new Date(0);
          const db = b.date ? new Date(b.date) : new Date(0);
          return db - da;
        }).slice(0, 20).map(c => ({
          primary: c.title || c.category || "CME Activity",
          secondary: [c.provider, c.hours ? `${c.hours} hrs` : "", c.category].filter(Boolean).join(" | "),
          date: c.date ? formatDate(c.date) : "",
        }));
        items.push(...recent);
      }
      if (items.length > 0) sections.push({ type: "section", title: "Continual Professional Development", items });
    }

    // Clinical template extras — credentialing packets want these; the paper CV
    // format stays untouched for the other templates
    if (template === "clinical") {
      if (data.insurance.length > 0) {
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
      if (data.peerReferences?.length > 0) {
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
    }

    return sections;
  }, [data, template, s]);


  // Generate plain text
  const generatePlainText = () => {
    const lines = [];
    const divider = "=".repeat(60);
    const subDivider = "-".repeat(40);

    cvContent.forEach(section => {
      if (section.type === "header") {
        lines.push(divider);
        lines.push(`  ${section.name}`);
        if (section.address) lines.push(`  ${section.address}`);
        if (section.email) lines.push(`  ${section.email}`);
        if (section.website) lines.push(`  ${section.website}`);
        if (section.phone) lines.push(`  ${section.phone}`);
        if (section.specialties.length > 0) {
          const names = section.specialties.map(id => id.split(":").pop());
          lines.push(`  ${section.fullDegree} \u2014 ${names.join(", ")}`);
        }
        lines.push(divider);
        lines.push("");
      } else {
        lines.push(section.title.toUpperCase());
        lines.push(subDivider);
        section.items.forEach(item => {
          const datePart = item.date ? `  [${item.date}]` : "";
          if (item.primary) lines.push(`${item.subhead ? "  " : "  "}${item.primary}${datePart}`);
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

  const flash = (msg) => { setNote(msg); setTimeout(() => setNote(""), 2500); };

  const handleCopyCV = async () => {
    await copyToClipboard(generatePlainText());
    flash("Copied — paste it anywhere.");
  };

  const handlePdfCV = async () => {
    try {
      const result = await shareCvPdf(cvContent, { name: s.name || "Physician", degree: s.degreeType || "" });
      if (result === "download") flash("PDF downloaded.");
      else if (result === "share") flash("PDF ready in the share sheet.");
    } catch (err) {
      flash(`Couldn't build the PDF: ${err.message}`);
    }
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
        <button onClick={handlePdfCV} style={{
          flex: 1, padding: "12px 16px", borderRadius: 12, border: `1px solid ${T.border}`,
          backgroundColor: T.card, color: T.text, fontSize: 14, fontWeight: 600, cursor: "pointer",
        }}>Save PDF</button>
      </div>

      {note && (
        <div style={{ marginBottom: 12, padding: "9px 12px", borderRadius: 10, backgroundColor: T.accentDim, color: T.accent, fontSize: 13, fontWeight: 700 }}>{note}</div>
      )}

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
                      <div style={{ fontSize: 20, fontWeight: 800, color: T.text }}>{section.name}</div>
                      {section.address && <div style={{ fontSize: 13, color: T.textMuted }}>{section.address}</div>}
                      <div style={{ fontSize: 13, color: T.textMuted }}>{[section.email, section.website, section.phone].filter(Boolean).join(" \u00b7 ")}</div>
                      {section.specialties.length > 0 && (
                        <div style={{ fontSize: 14, color: T.accent, fontWeight: 600, marginTop: 2 }}>
                          {`${section.fullDegree} — ${section.specialties.map(id => id.split(":").pop()).join(", ")}`}
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
                      <div key={i} style={{ marginBottom: item.subhead ? 4 : 10, paddingLeft: item.subhead ? 0 : 10, marginTop: item.subhead ? 6 : 0 }}>
                        {item.primary && (
                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                            <div style={{ fontSize: item.subhead ? 14 : 15, fontWeight: item.subhead ? 800 : 600, color: T.text }}>{item.primary}</div>
                            {item.date && <div style={{ fontSize: 12, color: T.textDim, flexShrink: 0, marginLeft: 10 }}>{item.date}</div>}
                          </div>
                        )}
                        {item.secondary && <div style={{ fontSize: 13, color: item.primary ? T.textMuted : T.text, lineHeight: 1.5 }}>{item.secondary}</div>}
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
