// The references a member already has, shown at the top of the Add form so
// they can see who is on the list before adding another (ticket 0b15a181).
// Each line is the first and last name, the credential (DO, MD or what was
// entered) and the date the reference was added when the record carries it.

// "M.D." and "md" read as MD; anything else stays as the member wrote it.
function normalizeCredential(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  const bare = s.replace(/[.\s]/g, "").toUpperCase();
  if (bare === "MD") return "MD";
  if (bare === "DO") return "DO";
  return s;
}

// Degrees and suffixes a member may type after the name, with or without a
// comma or periods. A suffix (Jr., III) is dropped; a degree is kept as the
// credential.
const DEGREES = new Set(["MD", "DO", "PA", "PA-C", "NP", "APRN", "CRNA", "CNM", "RN", "DNP", "FNP", "FNP-BC", "PHD", "MBBS", "MBCHB", "DDS", "DMD", "DPM", "MPH", "MBA", "MS", "FACS", "FACP", "FAAN"]);
const SUFFIXES = new Set(["JR", "SR", "II", "III", "IV"]);
const bareToken = w => w.replace(/[.,]/g, "").toUpperCase();
const isDegree = w => DEGREES.has(bareToken(w));
const isSuffix = w => SUFFIXES.has(bareToken(w));
// de, van, von, la: part of the surname that follows it.
const isParticle = w => /^(da|de|del|della|der|di|du|la|le|van|von|st\.?)$/i.test(w);

// "Dr. Jane Q. Smith, MD" -> { name: "Jane Smith", credential: "MD" }.
// Only the first and last name are kept: a title, middle names and initials,
// a suffix and degrees are dropped. A surname with a particle ("de la Cruz")
// stays whole. "Smith, Jane" (last name first) reads as "Jane Smith".
export function splitReferenceName(raw) {
  const full = String(raw || "").trim();
  const comma = full.indexOf(",");
  let head = comma >= 0 ? full.slice(0, comma) : full;
  let tail = comma >= 0 ? full.slice(comma + 1).trim() : "";
  const tailWords = tail.split(/[\s,]+/).filter(Boolean);
  if (tailWords.length && !tailWords.some(w => isDegree(w) || isSuffix(w)) && head.trim().split(/\s+/).length === 1) {
    head = `${tail} ${head}`;
    tail = "";
  }
  const words = head.split(/\s+/).filter(Boolean)
    .filter((w, i) => !(i === 0 && /^dr\.?$/i.test(w)));
  let credential = tailWords.find(isDegree) || "";
  while (words.length > 1 && (isDegree(words[words.length - 1]) || isSuffix(words[words.length - 1]))) {
    const w = words.pop();
    if (isDegree(w)) credential = w;
  }
  if (!credential && tail && !tailWords.some(isSuffix)) credential = tail.split(",")[0].trim();
  if (words.length <= 2) return { name: words.join(" "), credential };
  let start = words.length - 1;
  while (start > 1 && isParticle(words[start - 1])) start--;
  return { name: [words[0], ...words.slice(start)].join(" "), credential };
}

function addedDate(item) {
  const s = item?.createdAt || item?.created_at;
  if (!s) return "";
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? "" : s;
}

// One line per saved reference with a name, sorted by name.
export function existingReferenceLines(items) {
  return (Array.isArray(items) ? items : [])
    .filter(it => it && String(it.name || "").trim())
    .map(it => {
      const { name, credential } = splitReferenceName(it.name);
      return { id: it.id, name, credential: normalizeCredential(it.degree) || normalizeCredential(credential), added: addedDate(it) };
    })
    .filter(l => l.name)
    .sort((a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base" }));
}
