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

// RFC 6068: a mailto body needs CRLF line breaks — a bare "\n" reads as one
// continuous line in several mail clients. Every mailto in the app goes
// through here so no send path can miss the conversion again.
export function mailtoHref(email, subject, body) {
  return `mailto:${encodeURIComponent(email || "")}`
    + `?subject=${encodeURIComponent(subject || "")}`
    + `&body=${encodeURIComponent(String(body || "").replace(/\r?\n/g, "\r\n"))}`;
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
  lines.push(div, describeItem(item, settings.name, section), "");

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
    a("Started", item.startDate ? formatDate(item.startDate) : "");
    a("Graduated", formatDate(item.graduationDate)); a("Field of Study", item.fieldOfStudy);
    a("Honors", item.honors);
  } else if (section === "publications") {
    a("Citation", item.citation); a("Year", item.year);
    a("DOI", item.doi); a("PMID", item.pmid); a("Link", item.url);
  } else if (section === "memberships") {
    a("Organization", item.organization); a("Membership", item.role);
    a("Member Since", item.startDate ? formatDate(item.startDate) : "");
    a("Ended", item.endDate ? formatDate(item.endDate) : "");
  } else if (section === "peerReferences") {
    a("Name", item.name); a("Degree/Credential", item.degree); a("Specialty", item.specialty);
    a("Institution", item.institution); a("Relationship", item.relationship);
    a("Known Since", item.knownSince ? formatDate(item.knownSince + "-01") : "");
    a("Email", item.email); a("Phone", item.phone);
  } else if (section === "malpracticeHistory") {
    a("Date of Incident", formatDate(item.dateOfIncident)); a("Date Filed", formatDate(item.dateFiled));
    a("State", item.state); a("Outcome", item.outcome); a("Settlement Amount", item.settlementAmount);
    a("Facility", item.facility); a("Insurance Carrier", item.insuranceCarrier);
    a("Date Resolved", formatDate(item.dateResolved)); a("Description", item.description);
  } else if (section === "workHistory") {
    a("Position", item.position); a("Employer", item.employer);
    a("Location", [item.city, item.state].filter(Boolean).join(", "));
    a("Start Date", formatDate(item.startDate));
    a("End Date", item.current === "Yes" ? "Current" : formatDate(item.endDate));
    a("Reason for Leaving", item.reasonForLeaving); a("Description", item.description);
  } else if (section === "travelDocs") {
    a("Type", item.type); a("Provider", item.provider); a("Number", item.number);
    a("Expires", formatDate(item.expirationDate));
  } else if (section === "professionalPhotos") {
    a("Date Taken", formatDate(item.dateTaken));
  }

  if (item.notes) lines.push("", "Notes: " + item.notes);
  lines.push("", div, "Sent via CredentialDOMD \u00b7 " + new Date().toLocaleDateString());
  return lines.join("\n");
}

/**
 * Share-sheet text for a credential. iOS Mail ignores the share title when
 * files are attached, promotes the FIRST LINE of text to the subject, and
 * strips every line break — so this must be ONE flowing paragraph whose
 * opening words read as a subject. The formatted letter goes to the
 * clipboard alongside (see ShareModal.doShare).
 */
export function buildCredentialBlurb(item, section, settings, hasDocs, note) {
  const facts = buildCredentialText(item, section, settings)
    .split("\n")
    .map(l => l.trim())
    .filter(l => l && !/^\u2500+$/.test(l) && l !== "CREDENTIAL VERIFICATION");
  return "Credential verification: " + facts.join("; ") + ". "
    + (note ? note.trim().replace(/\s+/g, " ") + " " : "")
    + (hasDocs ? "Supporting documentation is attached. " : "")
    + "A formatted copy of this verification is on the sender's clipboard for pasting if preferred.";
}

export function buildEmailSubject(item, section, settings) {
  const label = item.name || item.type || item.title || item.category || "Credential";
  const physician = settings.name || "Physician";
  return `Credential Verification: ${label} - ${physician}`;
}

export function getItemLabel(item) {
  return item.name || item.type || item.title || item.category || item.facility || "Credential";
}

/**
 * Descriptive label for lists. AI scans sometimes put the PHYSICIAN'S name in
 * item.name ("Eric Whitney"), which makes every row read the same. If name is
 * missing or just the physician's name, build a label from what the
 * credential actually is: type/title + state/facility/institution.
 */
/**
 * A scanned credential often carries the PHYSICIAN'S name in its name field
 * ("WHITNEY, ERIC", "Eric E. Whitney, DO") — useless as a label. Detect any
 * variant of the person's name (case, commas, middle names/initials, degree
 * suffixes) and label by type + state instead.
 */
function isPersonName(name, physicianName) {
  if (!name || !physicianName) return false;
  const strip = (s) => s.toLowerCase().replace(/[.,()]/g, " ").split(/\s+/)
    .filter(t => t && !["do", "md", "jr", "sr", "ii", "iii", "iv", "phd", "np", "pa"].includes(t));
  const a = strip(name), b = strip(physicianName);
  if (!a.length || !b.length) return false;
  // Every word of the shorter name must appear in the longer one, allowing
  // middle initials to match full middle names ("e" ~ "edwin")
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  // Initials match full names in BOTH directions: a license reading
  // "Eric Edwin Whitney" is the person whose profile says "Eric E. Whitney"
  const matches = (t, u) => t === u
    || (t.length === 1 && u.startsWith(t))
    || (u.length === 1 && t.startsWith(u));
  return short.every(t => long.some(u => matches(t, u)));
}

// Every category titles CANONICALLY — the same fields in the same order for
// every card in a section — so two DEA registrations, two policies, or two
// degrees always read alike. The physician's own name is never information:
// it appears on half the documents a scanner reads, and it never becomes a
// headline (peer references excepted — there the person IS the record).
// Free text the scanner stored stays visible in the detail view.
export function describeItem(item, physicianName, sectionKey) {
  const t = (v) => (v && String(v).trim()) || null;
  const notMe = (v) => (t(v) && !isPersonName(v, physicianName) ? String(v).trim() : null);
  const join = (...parts) => parts.filter(Boolean).join(" — ");

  // Callers that know their section say so; the rest is inferred from the
  // fields only that section has, so alerts and share sheets match the cards.
  const sec = sectionKey
    || ("licenseNumber" in item ? "licenses" : null)
    || ("policyNumber" in item ? "insurance" : null)
    || ("appointmentDate" in item ? "privileges" : null)
    || ("employer" in item ? "workHistory" : null)
    || ("graduationDate" in item && "institution" in item ? "education" : null)
    || ("citation" in item ? "publications" : null)
    || ("organization" in item ? "memberships" : null);

  switch (sec) {
    case "licenses":
      return join(t(item.type) || "License", t(item.state));
    case "insurance":
      return join(t(item.type) || "Policy", t(item.provider));
    case "privileges":
      return join(t(item.type) || "Privileges", t(item.facility));
    case "workHistory":
      return join(t(item.position) || t(item.type) || "Position", t(item.employer));
    case "education":
      // The curated display name IS the information ("Skull Base
      // Fellowship") — type-first collapsed every card into "Residency,
      // Residency, Certification, Certification". Person names (a diploma
      // reads the graduate's name) still fall through to type — school.
      return notMe(item.name) || join(t(item.type) || "Education", t(item.institution));
    case "healthRecords":
      return join(t(item.type) || "Health record", notMe(item.name) || t(item.provider));
    case "malpracticeHistory":
      return join(t(item.outcome) || "Claim", t(item.facility) || t(item.state));
    case "memberships":
      // Organization leads — role-first made every card read "Member — …"
      return join(t(item.organization), t(item.role)) || "Membership";
    case "peerReferences":
      return join(t(item.name) || "Reference", t(item.degree));
    case "travelDocs":
      return join(t(item.type) || "Travel", t(item.provider) || notMe(item.name));
    case "publications":
      return notMe(item.name)
        || (item.citation ? String(item.citation).split(".").slice(0, 2).join(".").slice(0, 90) : "Publication");
    case "caseLogs":
      return notMe(item.title) || t(item.category) || "Case";
    default:
      break;
  }

  // Sections without a canonical shape (documents, CME courses, photos…):
  // the record's own title is the information — unless it's a person's name.
  if (notMe(item.name)) return String(item.name).trim();
  if (item.citation) return String(item.citation).split(".").slice(0, 2).join(".").slice(0, 90);
  const base = item.type || item.title || item.category || "Credential";
  const where = item.state || item.facility || item.institution || item.provider || "";
  return where ? `${base} — ${where}` : base;
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

// Downscale a photo for the profile avatar — full-res photos are megabytes;
// the avatar syncs inside the profile row, so keep it small.
export function downscalePhoto(dataUrl, max = 512) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL("image/jpeg", 0.85));
    };
    img.onerror = reject;
    img.src = dataUrl;
  });
}

// Invoice numbers must never repeat — an AP department treats the number as
// identity. Count-based numbering (invoices.length + 1) reissued a number
// whenever an earlier invoice was deleted; this scans what actually exists.
export function nextInvoiceNumber(invoices) {
  const prefix = `INV-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}`;
  let seq = (invoices || []).filter(i => String(i.number || "").startsWith(prefix)).length + 1;
  let num;
  do {
    num = `${prefix}-${String(seq).padStart(2, "0")}`;
    seq += 1;
  } while ((invoices || []).some(i => i.number === num));
  return num;
}
