// Contact Picker API (Chrome for Android, secure contexts only). The OS
// owns the picker UI and its search box, so "find Ajay" is just the user
// typing into the native picker — no in-app contact search to build.
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
export function parseVCard(text) {
  // Unfold: a line starting with space/tab continues the previous line
  const unfolded = String(text || "").replace(/\r\n/g, "\n").replace(/\n[ \t]/g, "");
  const lines = unfolded.split("\n");
  const val = (line) => {
    const i = line.indexOf(":");
    return i === -1 ? "" : line.slice(i + 1).trim().replace(/\\,/g, ",").replace(/\;/g, ";");
  };
  let name = "", email = "", phone = "", org = "";
  for (const ln of lines) {
    const u = ln.toUpperCase();
    if (!name && u.startsWith("FN")) name = val(ln);
    else if (!email && u.startsWith("EMAIL")) email = val(ln);
    else if (!phone && (u.startsWith("TEL"))) phone = val(ln);
    else if (!org && u.startsWith("ORG")) org = val(ln).split(";")[0];
  }
  if (!name) {
    const nLine = lines.find(l => l.toUpperCase().startsWith("N:") || l.toUpperCase().startsWith("N;"));
    if (nLine) {
      const parts = val(nLine).split(";");
      name = [parts[1], parts[0]].filter(Boolean).join(" ").trim();
    }
  }
  if (!name && !email && !phone) return null;
  return { name, email, phone, institution: org };
}
