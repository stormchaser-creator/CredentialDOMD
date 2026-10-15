// Clipboard failures are a normal browser permission outcome. Never report
// success until the browser confirms the write, including the legacy fallback.
export async function writeClipboardText(text) {
  try {
    await navigator.clipboard.writeText(String(text));
    return true;
  } catch { /* Try the legacy copy path while the click is still active. */ }
  let area, focused;
  try {
    focused = document.activeElement;
    area = document.createElement("textarea");
    area.value = String(text);
    area.style.cssText = "position:fixed;left:-9999px";
    document.body.appendChild(area);
    area.select();
    return document.execCommand("copy") === true;
  } catch { return false; }
  finally {
    // A cleanup error must not reject the fail-closed result or leave secret
    // text in a detached/hidden textarea. Restore the user's editing focus.
    try { if (area) area.value = ""; } catch { /* best-effort cleanup */ }
    try { if (area?.parentNode) area.parentNode.removeChild(area); } catch { /* DOM may already be gone */ }
    try { focused?.focus?.({ preventScroll: true }); } catch { /* element may have been removed */ }
  }
}
