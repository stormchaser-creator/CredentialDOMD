/**
 * The three ways a contact gets into a peer reference, and why there are three.
 *
 * An iPhone cannot hand a contact to a web app. There is no Contact Picker API
 * in Safari and no Web Share Target, so nothing in the iOS share sheet can
 * reach this app directly, whatever the app does. A physician asked to share a
 * contact into References "just like I share to text or email", and the honest
 * answer is that the share sheet's Mail entry IS the route: mailing the card to
 * CONTACT_EMAIL writes the reference for him (supabase/functions/email-inbound,
 * the contacts@ route). The other two are the saved .vcf and the clipboard.
 */

/** Share Contact > Mail > here, and the reference is written server-side. */
export const CONTACT_EMAIL = "contacts@credentialdomd.com";

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

/**
 * Anything that is not a vCard: an email signature, a line from a text
 * message, three lines typed by hand.
 *
 * Nothing here is saved by itself. It prefills the form, the physician reads
 * it, and a wrong guess costs one correction. That is the whole reason this is
 * allowed to be loose where the vCard parser is strict.
 */
export function parseLooseContact(text) {
  const raw = String(text || "");
  if (!raw.trim()) return null;

  const email = (raw.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z0-9.-]+[A-Za-z]/) || [""])[0];
  // Seven digits or more, which is a phone. A year or a suite number is not.
  const phoneMatch = raw.match(/(\(?\+?\d[\d\s().-]{6,}\d)/);
  const phone = phoneMatch ? phoneMatch[0].trim().replace(/\s{2,}/g, " ") : "";

  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const isNameish = (l) =>
    l !== email && l !== phone
    && !l.includes("@")
    && !/\d{3}/.test(l)
    && !/^(tel|phone|mobile|cell|fax|email|e-mail)\b/i.test(l)
    && l.length <= 80;
  // A signature leads with the person. A credential suffix is part of the name.
  const name = lines.find(isNameish) || "";
  // The line after the name is usually the title, the one after that the place.
  const rest = lines.filter((l) => l !== name && isNameish(l));
  const institution = rest.find((l) => /hospital|clinic|health|medical|university|center|centre|institute|group|associates|practice/i.test(l)) || "";

  // A way to reach the person is the whole point of a reference, and prose
  // with neither an address nor a number in it is prose. Reading "hello there"
  // as a reference named "hello there" would be worse than saying no.
  if (!email && !phone) return null;
  return { name, email, phone, institution };
}

/** A contact out of whatever was pasted: a card if it is one, a guess if not. */
export function parseContactText(text) {
  return parseVCard(text) || parseLooseContact(text);
}
