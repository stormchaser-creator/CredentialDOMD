// The references a member already has, shown at the top of the Add form so
// they can see who is on the list before adding another (ticket 0b15a181).
// Each line is the first and last name, the credential (MD, DO or what was
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

// "Dr. Jane Q. Smith, MD" -> { name: "Jane Smith", credential: "MD" }.
// The part after the first comma is the credential written into the name.
// Middle initials are dropped; a compound surname is kept whole.
export function splitReferenceName(raw) {
  const full = String(raw || "").trim();
  const comma = full.indexOf(",");
  const head = comma >= 0 ? full.slice(0, comma) : full;
  const tail = comma >= 0 ? full.slice(comma + 1).trim() : "";
  const words = head.split(/\s+/).filter(Boolean)
    .filter((w, i) => !(i === 0 && /^dr\.?$/i.test(w)))
    .filter((w, i, all) => !(i > 0 && i < all.length - 1 && /^[A-Za-z]\.?$/.test(w)));
  return { name: words.join(" "), credential: tail.split(",")[0].trim() };
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
