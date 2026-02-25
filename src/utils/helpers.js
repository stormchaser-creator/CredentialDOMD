export const MS_PER_DAY = 86400000;

export function generateId() {
  // Use cryptographically secure UUID when available
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  // Fallback for older browsers
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
    const r = (crypto.getRandomValues(new Uint8Array(1))[0] & 15) >> (c === "x" ? 0 : 2);
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

export function getStatusColor(expDate, lead = 90) {
  if (!expDate) return "gray";
  const days = Math.ceil((new Date(expDate) - new Date()) / MS_PER_DAY);
  if (days < 0) return "red";
  if (days <= 30) return "orange";
  if (days <= lead) return "amber";
  return "green";
}

export function getStatusLabel(expDate) {
  if (!expDate) return "No date";
  const days = Math.ceil((new Date(expDate) - new Date()) / MS_PER_DAY);
  if (days < 0) return `Expired ${Math.abs(days)}d ago`;
  if (days === 0) return "Expires today";
  return `${days}d left`;
}

export function formatDate(s) {
  if (!s) return "\u2014";
  // For YYYY-MM-DD strings, append T00:00:00 to avoid timezone shift
  // For full ISO datetime strings, parse as-is
  const d = s.length === 10 ? new Date(s + "T00:00:00") : new Date(s);
  return d.toLocaleDateString("en-US", {
    month: "short", day: "numeric", year: "numeric",
  });
}

export function daysUntil(dateStr) {
  if (!dateStr) return Infinity;
  return Math.ceil((new Date(dateStr) - new Date()) / MS_PER_DAY);
}

export function buildCredentialText(item, section, settings) {
  const lines = [];
  const name = settings.name || "Dr.";
  const deg = settings.degreeType || "MD";
  const div = "\u2500".repeat(36);

  lines.push("CREDENTIAL VERIFICATION", div);
  lines.push("Physician: " + name + ", " + deg);
  if (settings.npi) lines.push("NPI: " + settings.npi);
  if (settings.specialties?.length) {
    const names = settings.specialties.map(id => {
      const parts = id.split(":");
      return parts[parts.length - 1];
    });
    lines.push("Specialty: " + names.join(", "));
  }
  lines.push("Degree: " + (deg === "DO" ? "Doctor of Osteopathic Medicine" : "Doctor of Medicine"));
  lines.push(div, item.name || item.type || item.title || item.category || "Credential", "");

  const a = (k, v) => { if (v) lines.push(k + ": " + v); };

  if (section === "licenses") {
    a("Type", item.type); a("License #", item.licenseNumber); a("State", item.state);
    a("Issued", formatDate(item.issuedDate)); a("Expires", formatDate(item.expirationDate));
  } else if (section === "privileges") {
    a("Type", item.type); a("Facility", item.facility); a("State", item.state);
    a("Appointed", formatDate(item.appointmentDate)); a("Reappointment Due", formatDate(item.expirationDate));
  } else if (section === "insurance") {
    a("Policy Type", item.type); a("Carrier", item.provider); a("Policy #", item.policyNumber);
    a("Per Claim", item.coveragePerClaim); a("Aggregate", item.coverageAggregate);
    a("Effective", formatDate(item.effectiveDate)); a("Expires", formatDate(item.expirationDate));
  } else if (section === "cme") {
    a("Category", item.category); a("Hours", item.hours);
    a("Completed", formatDate(item.date)); a("Provider", item.provider);
    a("Certificate #", item.certificateNumber);
  } else if (section === "caseLogs") {
    a("Category", item.category); a("Date", formatDate(item.date));
    a("Facility", item.facility); a("Role", item.role); a("CPT", item.cptCodes);
  } else if (section === "healthRecords") {
    a("Category", item.category); a("Type", item.type);
    a("Date Administered", formatDate(item.dateAdministered)); a("Expires", formatDate(item.expirationDate));
    a("Result", item.result); a("Lot #", item.lotNumber); a("Facility", item.facility);
  } else if (section === "education") {
    a("Type", item.type); a("Institution", item.institution);
    a("Graduated", formatDate(item.graduationDate)); a("Field of Study", item.fieldOfStudy);
    a("Honors", item.honors);
  }

  if (item.notes) lines.push("", "Notes: " + item.notes);
  lines.push("", div, "Sent via CredentialDOMD \u00b7 " + new Date().toLocaleDateString());
  return lines.join("\n");
}

export function buildEmailSubject(item, section, settings) {
  const label = item.name || item.type || item.title || item.category || "Credential";
  const physician = settings.name || "Physician";
  return `Credential Verification: ${label} - ${physician}`;
}

export function getItemLabel(item) {
  return item.name || item.type || item.title || item.category || item.facility || "Credential";
}

export async function copyToClipboard(text) {
  try { await navigator.clipboard.writeText(text); }
  catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.cssText = "position:fixed;left:-9999px";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
  }
}

export const STATUS_COLORS = {
  red: "#ef4444",
  orange: "#f97316",
  amber: "#eab308",
  green: "#22c55e",
  gray: "#94a3b8",
};
