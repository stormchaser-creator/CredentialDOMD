import { formatDate } from "./helpers";

/**
 * The one place a CV's shape is decided. Preview, plain text, and PDF all
 * consume this — so what the physician sees on screen is what a program
 * director receives, verbatim.
 *
 * Section order and date presentation follow a working physician CV
 * (summary → experience → education → student activities → languages →
 * license block → privileges → publications → organizations → development),
 * not a credentialing dump.
 */

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

  // Build CV content — section order and presentation follow Eric's real CV
  // (Whitney CV 2026): summary → experience → education → medical student →
  // languages → license block → privileges → publications → organizations →
  // professional development. Dates ride inline in parentheses, as on paper.
export function buildCvContent(data, template = "clinical") {
  const s = data.settings || {};
    const sections = [];
    const deg = s.degreeType || "MD";
    const fullDegree = deg === "DO" ? "Doctor of Osteopathic Medicine" : "Doctor of Medicine";
    const yr = (d) => (d ? String(d).slice(0, 4) : "");
    const longDate = (d) => {
      if (!d) return "";
      const dt = new Date(d + (String(d).length === 10 ? "T12:00:00" : ""));
      return isNaN(dt) ? String(d) : dt.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
    };
    const isTrue = (v) => v === true || v === "true" || v === 1;
    // Scanned credentials often get saved under the physician's OWN name, which
    // reads as nonsense on a CV — those fall back to the credential type.
    const ownWords = String(s.name || "").toLowerCase().replace(/[^a-z ]/g, "").split(/\s+/).filter(w => w.length > 2);
    const namesThePhysician = (n) => {
      if (!n) return true;
      const words = String(n).toLowerCase().replace(/[^a-z ]/g, "").split(/\s+/).filter(Boolean);
      return words.length <= 5 && ownWords.length > 0
        && words.filter(w => ownWords.includes(w)).length >= Math.min(2, ownWords.length);
    };
    const range = (a, b, current) => {
      const from = longDate(a);
      const to = isTrue(current) ? "current" : longDate(b);
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
          primary: `${w.employer || w.position || "Position"}${w.startDate || w.endDate || isTrue(w.current ?? w.isCurrent) ? ` (${range(w.startDate, w.endDate, w.current ?? w.isCurrent)})` : ""}`,
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
        if (db - da !== 0) return db - da;
        const sa = a.startDate ? new Date(a.startDate) : new Date(0);
        const sb = b.startDate ? new Date(b.startDate) : new Date(0);
        return sb - sa;
      });
      const edu = eduSort(data.education.filter(e => !isActivity(e)));
      const activities = eduSort(data.education.filter(isActivity));
      // A scanned diploma often gets saved under the physician's OWN name.
      // That reads as nonsense on a CV, so those fall back to the credential.
      const eduYears = (e) => {
        const a = yr(e.startDate), b = yr(e.graduationDate);
        if (a && b && a !== b) return `${a}\u2013${b}`;
        return b || a || "";
      };
      sections.push({
        type: "section",
        title: "Education",
        items: edu.map(e => {
          const label = namesThePhysician(e.name) ? (e.type || "Degree") : e.name;
          const years = eduYears(e);
          return {
            primary: `${label}${years ? `, ${years}` : ""}`,
            secondary: [e.institution, e.fieldOfStudy, e.honors].filter(Boolean).join(" | "),
            detail: "",
            date: "",
          };
        }),
      });
      if (activities.length > 0) {
        sections.push({
          type: "section",
          title: "Medical Student",
          items: activities.map(e => ({
            primary: `${namesThePhysician(e.name) ? e.type : e.name}${eduYears(e) ? ` ${eduYears(e)}` : ""}`,
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
      for (const b of lic.filter(isBoard)) {
        items.push({
          primary: namesThePhysician(b.name) ? b.type : b.name,
          secondary: [b.licenseNumber ? `Certificate ${b.licenseNumber}` : "", b.expirationDate ? `Expires ${formatDate(b.expirationDate)}` : ""].filter(Boolean).join(" \u00b7 "),
          date: "",
        });
      }
      const meds = lic.filter(isMedical);
      if (meds.length > 0) {
        items.push({ primary: "Medical Licenses", secondary: "", date: "", subhead: true });
        for (const m of meds) {
          const provisional = /provisional|temporary/i.test(m.type || "") ? " (provisional temporary)" : "";
          const stateLabel = STATE_NAMES[m.state] || m.state || "";
          items.push({ primary: [stateLabel, m.licenseNumber].filter(Boolean).join(": ") + provisional, secondary: "", date: "" });
        }
      }
      const deas = lic.filter(isDEA);
      if (deas.length > 0) {
        items.push({ primary: "DEA", secondary: "", date: "", subhead: true });
        for (const d of deas) {
          items.push({ primary: ["DEA" + (d.state ? ` ${d.state}` : ""), d.licenseNumber].filter(Boolean).join(": "), secondary: "", date: "" });
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
          const facility = p.facility || p.name || "";
          return {
            primary: `${facility}${span ? `: ${span}` : ""}${place ? ` ${place}` : ""}`,
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
      // A course date of Jan 1 means "that year" — a CV never invents a day.
      const courseWhen = (d) => {
        if (!d) return "";
        const str = String(d);
        if (str.length <= 4) return str;
        const [y, m, day] = str.split("-");
        if (!m) return y;
        if (m === "01" && (!day || day === "01")) return y;
        const dt = new Date(`${y}-${m}-15T12:00:00`);
        return isNaN(dt) ? y : `${dt.toLocaleDateString("en-US", { month: "long" })} ${y}`;
      };
      const items = courses.map(c => ({
        primary: `${c.title || "Course"}${courseWhen(c.date) ? ` ${courseWhen(c.date)}` : ""}`,
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
            primary: namesThePhysician(i.name) ? (i.type || "Professional Liability") : i.name,
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
}
