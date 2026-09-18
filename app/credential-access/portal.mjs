// Activation requires a separately reviewed deployment. This browser flag never
// replaces the independent server gate or recipient authorization.
export const PORTAL_CONFIG = Object.freeze({
  enabled: false,
  endpoint: "https://hkpnnsjcwprrwobmpqyy.supabase.co/functions/v1/credential-portal",
});

const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const INLINE_TYPES = new Set(["application/pdf", "image/png", "image/jpeg", "text/plain"]);
const MAX_FILE_BYTES = 10 * 1024 * 1024;

export function parseDocuments(value) {
  if (!Array.isArray(value) || value.length > 10) throw new Error("invalid_response");
  const seen = new Set();
  let total = 0;
  return value.map(item => {
    if (!item || !UUID.test(item.id) || seen.has(item.id) || typeof item.name !== "string"
      || typeof item.mimeType !== "string" || !Number.isInteger(item.sizeBytes)
      || item.sizeBytes < 0 || item.sizeBytes > MAX_FILE_BYTES) throw new Error("invalid_response");
    seen.add(item.id);
    total += item.sizeBytes;
    if (total > 30 * 1024 * 1024) throw new Error("invalid_response");
    return { id: item.id, name: item.name.slice(0, 500) || "Credential document", mimeType: item.mimeType, sizeBytes: item.sizeBytes };
  });
}

export function previewAllowed(headers) {
  const mime = (headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  return /^inline(?:;|$)/i.test(headers.get("content-disposition") || "") && INLINE_TYPES.has(mime);
}

export function downloadName(name) {
  return (name || "credential-document").replace(/[\u0000-\u001f\u007f/\\:]/g, "_").replace(/^\.+/, "_").slice(0, 160) || "credential-document";
}

// No browser persistence, analytics or automatic API calls. All document bytes
// arrive through authenticated POSTs; object URLs live only until closed/ended.
export function mountPortal({ inviteToken: initialInvite = "", config = PORTAL_CONFIG, fetchImpl = (...args) => fetch(...args) } = {}) {
  const byId = id => document.getElementById(id);
  const elements = Object.fromEntries([
    "loading-message", "access-panel", "steps", "message-view", "message-title", "message-detail",
    "email-form", "recipient-email", "code-form", "verification-code", "code-email", "resend-code", "change-email",
    "documents-view", "documents-title", "session-detail", "document-list", "refresh-documents", "end-access",
    "preview-panel", "preview-title", "preview-frame", "close-preview", "status", "error",
  ].map(id => [id, byId(id)]));
  let inviteToken = TOKEN.test(initialInvite) ? initialInvite : "";
  initialInvite = "";
  let sessionToken = "", email = "", documents = [], expiresAt = 0, codeRequestedAt = 0;
  let stage = "message", busy = false, generation = 0, controller = null, previewUrl = "", previewTrigger = null;
  let pdfPreview = null, previewGeneration = 0;
  const urls = new Set(), downloads = new Set(), listeners = [];
  const listen = (target, event, handler) => { target.addEventListener(event, handler); listeners.push(() => target.removeEventListener(event, handler)); };
  const status = message => { elements.status.textContent = message; };
  const error = message => { elements.error.textContent = message; elements.error.hidden = !message; };
  const focus = element => element.focus({ preventScroll: true });

  function closePreview(restoreFocus = true) {
    previewGeneration++;
    pdfPreview?.close(); pdfPreview = null;
    elements["preview-frame"].replaceChildren();
    elements["preview-panel"].hidden = true;
    elements["preview-title"].textContent = "Document preview";
    if (previewUrl) { URL.revokeObjectURL(previewUrl); urls.delete(previewUrl); previewUrl = ""; }
    if (restoreFocus && previewTrigger?.isConnected) focus(previewTrigger);
    previewTrigger = null;
  }
  function clearSensitive() {
    generation++;
    controller?.abort(); controller = null;
    inviteToken = ""; sessionToken = ""; email = ""; documents = []; expiresAt = 0;
    elements["email-form"].reset(); elements["code-form"].reset();
    elements["code-email"].textContent = ""; elements["session-detail"].textContent = "";
    elements["document-list"].replaceChildren();
    closePreview(false);
    for (const url of urls) URL.revokeObjectURL(url);
    urls.clear();
    for (const timer of downloads) clearTimeout(timer);
    downloads.clear();
    busy = false;
  }
  function setStage(next) {
    stage = next;
    for (const [id, value] of [["message-view", "message"], ["email-form", "email"], ["code-form", "code"], ["documents-view", "documents"]]) elements[id].hidden = value !== stage;
    elements.steps.hidden = stage === "message";
    for (const item of elements.steps.children) {
      if (item.dataset.step === stage) item.setAttribute("aria-current", "step");
      else item.removeAttribute("aria-current");
    }
    updateControls();
  }
  function finish(title, detail, shouldFocus = true) {
    clearSensitive();
    setStage("message"); error(""); status("");
    elements["message-title"].textContent = title;
    elements["message-detail"].textContent = detail;
    if (shouldFocus) focus(elements["message-title"]);
  }
  function ensureSession() {
    if (sessionToken && Date.now() < expiresAt) return true;
    finish("Your access has ended", "Ask the physician for a new invitation if you still need these documents. Files you already downloaded remain on your device.");
    return false;
  }
  function updateControls() {
    elements["access-panel"].setAttribute("aria-busy", String(busy));
    for (const control of elements["access-panel"].querySelectorAll("button, input")) {
      control.disabled = control.id !== "end-access" && (busy || control.dataset.unavailable === "true");
    }
    const wait = Math.max(0, 60 - Math.floor((Date.now() - codeRequestedAt) / 1000));
    elements["resend-code"].disabled = busy || wait > 0;
    elements["resend-code"].textContent = wait ? `Send another code in ${wait}s` : "Send another code";
    if (sessionToken) elements["session-detail"].textContent = `Access ends at ${new Date(expiresAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}. Keep this page open.`;
  }
  async function request(action, fields = {}, binary = false) {
    const operation = generation;
    const abort = new AbortController(); controller = abort;
    const timeout = setTimeout(() => abort.abort(), 30000);
    try {
      const response = await fetchImpl(config.endpoint, {
        method: "POST", headers: { "Content-Type": "application/json", ...(sessionToken ? { Authorization: `Bearer ${sessionToken}` } : {}) },
        body: JSON.stringify({ action, ...fields }), cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer", redirect: "error", signal: abort.signal,
      });
      if (operation !== generation) throw new Error("discarded");
      if (!response.ok) {
        let code = "unavailable";
        try { code = (await response.json()).error || code; } catch { /* Fixed UI copy below; never show raw server content. */ }
        if (operation !== generation) throw new Error("discarded");
        const failure = new Error(code); failure.status = response.status; throw failure;
      }
      if (!binary) {
        const result = await response.json();
        if (operation !== generation) throw new Error("discarded");
        return result;
      }
      const size = Number(response.headers.get("content-length"));
      if (size > MAX_FILE_BYTES) throw new Error("invalid_response");
      const reader = response.body?.getReader(), chunks = [];
      let total = 0;
      if (!reader) throw new Error("invalid_response");
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > MAX_FILE_BYTES || operation !== generation) {
            await reader.cancel(); throw new Error(operation !== generation ? "discarded" : "invalid_response");
          }
          chunks.push(value);
        }
      } finally { reader.releaseLock(); }
      const blob = new Blob(chunks);
      if (operation !== generation) throw new Error("discarded");
      if (blob.size > MAX_FILE_BYTES) throw new Error("invalid_response");
      return { blob, headers: response.headers };
    } finally {
      clearTimeout(timeout);
      if (controller === abort) controller = null;
    }
  }
  async function operation(task) {
    if (busy) return;
    const current = generation;
    busy = true; error(""); status(""); updateControls();
    try { await task(); }
    catch (failure) {
      if (current !== generation || failure.message === "discarded") return;
      status("");
      if (failure.status === 503) error("Private document access is unavailable right now. Please contact the physician if you need the documents urgently.");
      else error("The request could not be completed. Check your connection and try again.");
    } finally {
      if (current === generation) { busy = false; updateControls(); }
    }
  }
  async function requestCode() {
    await operation(async () => {
      status("Requesting your code…");
      await request("request-code", { inviteToken, email });
      codeRequestedAt = Date.now();
      elements["verification-code"].value = "";
      elements["code-email"].textContent = email;
      setStage("code"); status("Check your inbox for the latest code.");
      // Focus after controls become enabled by operation's finally block.
      setTimeout(() => { if (stage === "code") focus(elements["verification-code"]); }, 0);
    });
  }
  function readSessionResponse(value, verifying = false) {
    const expiry = Date.parse(value.expiresAt);
    const parsed = parseDocuments(value.documents);
    if (!Number.isFinite(expiry) || expiry <= Date.now() || expiry > Date.now() + 31 * 60 * 1000
      || (verifying && !TOKEN.test(value.sessionToken || ""))) throw new Error("invalid_response");
    if (verifying) sessionToken = value.sessionToken;
    expiresAt = expiry; documents = parsed;
  }
  function renderDocuments() {
    elements["document-list"].replaceChildren();
    if (!documents.length) {
      const empty = document.createElement("li");
      empty.textContent = "No documents are available in this invitation. Contact the physician for a new invitation.";
      elements["document-list"].append(empty);
    }
    for (const item of documents) {
      const row = document.createElement("li"), name = document.createElement("strong"), meta = document.createElement("p"), actions = document.createElement("div");
      name.className = "document-name"; name.textContent = item.name;
      meta.className = "document-meta";
      const labels = { "application/pdf": "PDF", "image/png": "PNG image", "image/jpeg": "JPEG image", "text/plain": "Text file" };
      meta.textContent = `${labels[item.mimeType] || "File"} · ${item.sizeBytes < 1024 * 1024 ? `${Math.max(1, Math.ceil(item.sizeBytes / 1024))} KB` : `${(item.sizeBytes / (1024 * 1024)).toFixed(1)} MB`}`;
      actions.className = "document-actions";
      for (const action of ["view", "download"]) {
        if (action === "view" && !INLINE_TYPES.has(item.mimeType)) continue;
        const button = document.createElement("button"); button.type = "button"; button.className = "secondary";
        button.textContent = action === "view" ? "Preview" : "Download";
        button.setAttribute("aria-label", `${button.textContent} ${item.name}`);
        button.addEventListener("click", () => openDocument(item, action, row, button));
        actions.append(button);
      }
      row.append(name, meta, actions); elements["document-list"].append(row);
    }
  }
  async function openDocument(item, action, row, trigger) {
    if (!ensureSession()) return;
    await operation(async () => {
      status(action === "view" ? "Opening preview…" : "Preparing download…");
      let result;
      try { result = await request(action, { documentId: item.id }, true); }
      catch (failure) {
        if (failure.status === 401) { finish("These documents are no longer available", "Your access may have expired or been revoked, or a document may have changed. Ask the physician for a new invitation."); return; }
        if (failure.status === 409) {
          closePreview(false);
          for (const button of row.querySelectorAll("button")) button.dataset.unavailable = "true";
          const note = document.createElement("p"); note.className = "unavailable"; note.textContent = "This file has changed. Ask the physician for a new invitation.";
          row.append(note); status(""); error(note.textContent); return;
        }
        throw failure;
      }
      if (!ensureSession()) return;
      if (action === "view" && !previewAllowed(result.headers)) {
        status("This file cannot be previewed here. Choose Download to save it to your device."); return;
      }
      const mime = action === "view" ? result.headers.get("content-type").split(";")[0].trim().toLowerCase() : "application/octet-stream";
      if (action === "view" && mime === "application/pdf") {
        closePreview(false);
        const previewOperation = previewGeneration, sessionOperation = generation;
        previewTrigger = trigger;
        elements["preview-title"].textContent = item.name;
        elements["preview-panel"].hidden = false; focus(elements["preview-title"]);
        status("Preparing the PDF preview…");
        try {
          const { createPdfPreview } = await import("./pdf-preview.mjs");
          const bytes = new Uint8Array(await result.blob.arrayBuffer());
          if (previewOperation !== previewGeneration || sessionOperation !== generation || !ensureSession()) return;
          pdfPreview = createPdfPreview(elements["preview-frame"], bytes, item.name);
          await pdfPreview.ready;
          if (previewOperation === previewGeneration && sessionOperation === generation) status("The PDF preview is below. Download the original if it cannot be displayed.");
        } catch {
          if (previewOperation === previewGeneration && sessionOperation === generation) { closePreview(false); error("The PDF preview could not open. Choose Download to save the original."); status(""); }
        }
        return;
      }
      const url = URL.createObjectURL(new Blob([result.blob], { type: mime })); urls.add(url);
      if (action === "view") {
        closePreview(false); previewUrl = url; previewTrigger = trigger;
        const frame = document.createElement("iframe");
        frame.setAttribute("sandbox", ""); frame.setAttribute("referrerpolicy", "no-referrer"); frame.title = `Preview: ${item.name}`; frame.src = url;
        elements["preview-frame"].append(frame); elements["preview-title"].textContent = item.name;
        elements["preview-panel"].hidden = false; focus(elements["preview-title"]); status("Preview opened below.");
      } else {
        const link = document.createElement("a"); link.href = url; link.download = downloadName(item.name); link.hidden = true;
        document.body.append(link); link.click(); link.remove();
        const timer = setTimeout(() => { URL.revokeObjectURL(url); urls.delete(url); downloads.delete(timer); }, 60000); downloads.add(timer);
        status("Download requested. Check your browser’s downloads.");
      }
    });
  }
  listen(elements["email-form"], "submit", event => {
    event.preventDefault(); if (busy || stage !== "email") return;
    email = elements["recipient-email"].value.trim();
    requestCode();
  });
  listen(elements["resend-code"], "click", () => { if (stage === "code" && !elements["resend-code"].disabled) requestCode(); });
  listen(elements["change-email"], "click", () => { if (busy) return; elements["verification-code"].value = ""; error(""); status(""); setStage("email"); focus(elements["recipient-email"]); });
  listen(elements["code-form"], "submit", event => {
    event.preventDefault(); if (busy || stage !== "code") return;
    const code = elements["verification-code"].value;
    if (!/^\d{6}$/.test(code)) { error("Enter the six digits from your latest email."); return; }
    operation(async () => {
      status("Verifying your code…");
      try {
        const result = await request("verify", { inviteToken, email, code });
        readSessionResponse(result, true);
      } catch (failure) {
        elements["verification-code"].value = "";
        if (failure.status === 401) { status(""); error("That code could not be verified. Check the latest code and invited email. The invitation may have expired, been used, or been revoked. Repeated incorrect attempts can lock it."); return; }
        if (failure.status === 503) throw failure;
        if (failure.message === "discarded") return;
        finish("Verification was interrupted", "Ask the physician for a new invitation. To protect these documents, access cannot be recovered from an interrupted verification."); return;
      }
      inviteToken = ""; email = "";
      elements["email-form"].reset(); elements["code-form"].reset(); elements["code-email"].textContent = "";
      renderDocuments(); setStage("documents"); status(""); focus(elements["documents-title"]);
    });
  });
  listen(elements["refresh-documents"], "click", () => {
    if (!ensureSession()) return;
    operation(async () => {
      status("Refreshing documents…");
      try { const value = await request("documents"); if (!ensureSession()) return; readSessionResponse(value); }
      catch (failure) { if (failure.status === 401) { finish("Your access has ended", "Ask the physician for a new invitation if you still need these documents."); return; } throw failure; }
      closePreview(false); renderDocuments(); status("Document list refreshed.");
    });
  });
  listen(elements["end-access"], "click", () => finish("You’ve ended access", "This page no longer has access to the invitation. Ask the physician for a new one to return. Files you downloaded remain on your device."));
  listen(elements["close-preview"], "click", () => closePreview());
  listen(window, "pagehide", () => finish("This access has ended", "Reopen the invitation if you have not verified it yet. If you already verified a code, ask the physician for a new invitation.", false));
  const checkTime = () => { if (sessionToken && Date.now() >= expiresAt) ensureSession(); else updateControls(); };
  listen(window, "focus", checkTime); listen(document, "visibilitychange", checkTime);
  const ticker = setInterval(checkTime, 1000);
  elements["loading-message"].hidden = true;
  if (!config.enabled) finish("Private invitations are not available yet", "Ask the physician for another way to receive the documents. This page will be available after private sharing is activated.", false);
  else if (!inviteToken) finish("Open your invitation email", "Use the original invitation link to start. If you already verified a code and then closed or reloaded this page, ask the physician for a new invitation.", false);
  else { setStage("email"); }
  return () => { finish("This access has ended", "Reopen the invitation if you have not verified it yet. If you already verified a code, ask the physician for a new invitation.", false); clearInterval(ticker); for (const remove of listeners) remove(); };
}
