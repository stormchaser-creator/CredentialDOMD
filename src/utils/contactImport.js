// Contact Picker API (Chrome for Android, secure contexts only). The OS
// owns the picker UI and its search box, so "find Ajay" is just the user
// typing into the native picker, so there is no in-app contact search to build.
export function isContactPickerSupported() {
  return typeof navigator !== "undefined" && "contacts" in navigator && typeof window !== "undefined" && "ContactsManager" in window;
}

export async function pickContact() {
  if (!isContactPickerSupported()) return null;
  try {
    const [contact] = await navigator.contacts.select(["name", "email", "tel"], { multiple: false });
    if (!contact) return null;
    return {
      name: contact.name?.[0] || "",
      email: contact.email?.[0] || "",
      phone: contact.tel?.[0] || "",
    };
  } catch (err) {
    if (err?.name === "AbortError") return null; // user backed out of the native picker
    throw err;
  }
}

/**
 * iPhone path: iOS has no Contact Picker API, but Contacts shares any card
 * as a .vcf file (Share Contact → Save to Files / AirDrop). Parse the vCard
 * text and prefill the same fields the native picker would have.
 */
/**
 * The vCard a phone actually produces.
 *
 * Two things broke this on the one platform it exists for. Apple Contacts
 * writes a GROUP PREFIX on any property that carries a label, so a labelled
 * mobile number is "item1.TEL;type=CELL;type=pref:..." and a labelled work
 * address is "item2.EMAIL;...". RFC 6350 allows that on any content line, and
 * matching on the property name alone missed every one of them: the card came
 * in with a name and nothing else, which is exactly the failure a physician
 * reported. And the escape rules run the other way round from how they were
 * applied: a structured value has to be SPLIT on its unescaped separators
 * before anything is unescaped, or "St. Mary\;s Hospital;Neurosurgery"
 * truncates at the escaped semicolon it was supposed to keep.
 */

/** "item1.TEL;type=CELL" -> "TEL". The group and the parameters both go. */
function propertyName(head) {
  const semi = head.indexOf(";");
  const prop = semi === -1 ? head : head.slice(0, semi);
  const dot = prop.lastIndexOf(".");
  return (dot === -1 ? prop : prop.slice(dot + 1)).trim().toUpperCase();
}

/** Split a structured value on its separators, leaving escaped ones alone. */
function splitStructured(raw) {
  const out = [];
  let cur = "";
  for (let i = 0; i < raw.length; i += 1) {
    const c = raw[i];
    if (c === "\\" && i + 1 < raw.length) { cur += c + raw[i + 1]; i += 1; continue; }
    if (c === ";") { out.push(cur); cur = ""; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}

/** The characters vCard escapes, put back. */
function unescapeValue(v) {
  return String(v)
    .replace(/\\n/gi, "\n")
    .replace(/\\([,;\\])/g, "$1")
    .trim();
}

export function parseVCard(text) {
  // Unfold: a line starting with a space or tab continues the one before it.
  const unfolded = String(text || "").replace(/\r\n/g, "\n").replace(/\n[ \t]/g, "");
  const lines = unfolded.split("\n");

  let name = "", email = "", phone = "", org = "", structuredName = null;
  for (const ln of lines) {
    const i = ln.indexOf(":");
    if (i === -1) continue;
    const prop = propertyName(ln.slice(0, i));
    const raw = ln.slice(i + 1);
    if (prop === "FN" && !name) name = unescapeValue(raw);
    else if (prop === "EMAIL" && !email) email = unescapeValue(raw);
    else if (prop === "TEL" && !phone) phone = unescapeValue(raw);
    else if (prop === "ORG" && !org) org = unescapeValue(splitStructured(raw)[0]);
    else if (prop === "N" && !structuredName) structuredName = splitStructured(raw).map(unescapeValue);
  }

  // No formatted name on the card: build one from the structured N property,
  // which is given family-first.
  if (!name && structuredName) {
    name = [structuredName[1], structuredName[0]].filter(Boolean).join(" ").trim();
  }

  if (!name && !email && !phone) return null;
  return { name, email, phone, institution: org };
}
