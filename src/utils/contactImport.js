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
