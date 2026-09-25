// Activation requires a separately reviewed deployment. This browser flag never
// replaces the independent server gate or recipient authorization.
export const PORTAL_CONFIG = Object.freeze({
  enabled: true,
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

// Standing administrator access: a live, view-only credential file. The
// server shapes it (credentialPortalView.mjs); this page only validates the
// shape, bounds it, and renders text nodes. Nothing is persisted.
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DOT = " \u{b7} ";
const clip = (value, max = 500) => typeof value === "string" ? value.slice(0, max) : "";
const MIME_LABELS = { "application/pdf": "PDF", "image/png": "PNG image", "image/jpeg": "JPEG image", "text/plain": "Text file" };

export function fileMeta(item) {
  const label = MIME_LABELS[item.mimeType] || "File";
  if (!Number.isInteger(item.sizeBytes)) return label;
  const size = item.sizeBytes < 1024 * 1024 ? `${Math.max(1, Math.ceil(item.sizeBytes / 1024))} KB` : `${(item.sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${label}${DOT}${size}`;
}

export function formatDate(value) {
  const date = new Date(typeof value === "string" && DATE.test(value) ? `${value}T12:00:00Z` : value);
  return Number.isFinite(date.getTime()) ? date.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" }) : "";
}

/**
 * When the access itself ends. That is a moment, not a date-only record field,
 * so it is shown in the viewer's own zone with the time and zone name ("Oct
 * 25, 2026, 7:00 PM MDT"). A UTC date would read a day late for a grant made
 * on a US evening. timeZone is for tests; the page uses the browser's.
 */
export function formatEnd(value, timeZone) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const options = { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" };
  try { return date.toLocaleString("en-US", timeZone ? { ...options, timeZone } : options).replace(/[\u{a0}\u{202f}]/gu, " "); }
  catch { return date.toLocaleString("en-US", { ...options, timeZone: "UTC" }).replace(/[\u{a0}\u{202f}]/gu, " "); }
}

// A visit lasts at most 60 minutes (standing) or 30 (selection). The server
// says how many seconds are left and the page counts down from its own clock,
// so an office PC whose clock is minutes out neither rejects a good visit nor
// keeps a dead one open. expiresAt is only a fallback, with generous slack.
const CLOCK_SLACK_MS = 15 * 60 * 1000;
export function sessionExpiry(value, kind, now = Date.now()) {
  const longest = (kind === "standing" ? 60 : 30) * 60 * 1000;
  const remaining = value?.expiresInSeconds;
  if (remaining !== undefined) {
    if (!Number.isInteger(remaining) || remaining <= 0 || remaining * 1000 > longest + 60 * 1000) throw new Error("invalid_response");
    return now + remaining * 1000;
  }
  const expiry = Date.parse(value?.expiresAt);
  if (!Number.isFinite(expiry) || expiry <= now - CLOCK_SLACK_MS || expiry > now + longest + CLOCK_SLACK_MS) throw new Error("invalid_response");
  return Math.min(Math.max(expiry, now + 60 * 1000), now + longest);
}

/**
 * What to tell the administrator when a file cannot be shown. The Download
 * button is named only when it exists: with downloads off there is none, so
 * the next step is asking the physician.
 */
export function fileMessage(reason, allowDownload) {
  const off = allowDownload !== true;
  if (reason === "not_previewable") return off
    ? "This file cannot be shown here and downloads are turned off for this access. Ask the physician for a copy."
    : "This file cannot be previewed here. Choose Download to save it to your device.";
  if (reason === "pdf_ready") return off
    ? "The PDF preview is below. If it does not display, ask the physician for a copy."
    : "The PDF preview is below. Download the original if it cannot be displayed.";
  if (reason === "pdf_failed") return off
    ? "The PDF preview could not open, and downloads are turned off for this access. Ask the physician for a copy."
    : "The PDF preview could not open. Choose Download to save the original.";
  if (reason === "view_refused") return "This file cannot be shown here and downloads are turned off for this access. Ask the physician for a copy.";
  if (reason === "download_refused") return "The physician has turned off downloads for this access. You can still preview files.";
  return "";
}

/** The badge beside a record: expired, due within 90 days, or current. */
export function expiryStatus(date, now = Date.now()) {
  if (typeof date !== "string" || !DATE.test(date)) return null;
  const end = Date.parse(`${date}T23:59:59Z`);
  if (end < now) return { tone: "expired", label: `Expired ${formatDate(date)}` };
  const days = Math.floor((end - now) / 86400000);
  if (days <= 90) return { tone: "soon", label: days < 1 ? "Expires today" : `Expires in ${days} day${days === 1 ? "" : "s"}` };
  return { tone: "current", label: `Current until ${formatDate(date)}` };
}

/** What a file row may offer. No Download button at all when downloads are off. */
export function documentActions(item, allowDownload) {
  if (Number.isInteger(item.sizeBytes) && item.sizeBytes > MAX_FILE_BYTES) return [];
  return [...(INLINE_TYPES.has(item.mimeType) ? ["view"] : []), ...(allowDownload === true ? ["download"] : [])];
}

export function parseStandingView(value) {
  if (!value || typeof value !== "object" || !Array.isArray(value.sections) || value.sections.length > 80) throw new Error("invalid_response");
  const physician = value.physician && typeof value.physician === "object" ? value.physician : {};
  const grant = value.grant && typeof value.grant === "object" ? value.grant : {};
  const accessEndsAt = Date.parse(grant.accessEndsAt);
  if (!Number.isFinite(accessEndsAt)) throw new Error("invalid_response");
  const list = items => Array.isArray(items) ? items.filter(item => typeof item === "string").slice(0, 60).map(item => item.slice(0, 120)) : [];
  const seen = new Set();
  let records = 0, documents = 0;
  const sections = value.sections.map(section => {
    if (!section || typeof section.key !== "string" || typeof section.label !== "string" || !Array.isArray(section.records)) throw new Error("invalid_response");
    return {
      key: section.key.slice(0, 80), label: clip(section.label, 120) || "Records",
      records: section.records.map(record => {
        if (!record || !UUID.test(record.id) || !Array.isArray(record.fields) || record.fields.length > 40 || !Array.isArray(record.documents) || ++records > 10000) throw new Error("invalid_response");
        return {
          id: record.id, title: clip(record.title, 200) || "Record",
          expirationDate: typeof record.expirationDate === "string" && DATE.test(record.expirationDate) ? record.expirationDate : null,
          fields: record.fields.map(field => ({ label: clip(field?.label, 60), value: clip(field?.value, 2000) })).filter(field => field.label && field.value),
          documents: record.documents.map(item => {
            if (!item || !UUID.test(item.id) || seen.has(item.id) || typeof item.name !== "string" || typeof item.mimeType !== "string"
              || (item.sizeBytes !== null && (!Number.isInteger(item.sizeBytes) || item.sizeBytes < 0)) || ++documents > 2000) throw new Error("invalid_response");
            seen.add(item.id);
            return { id: item.id, name: item.name.slice(0, 500) || "Credential document", mimeType: item.mimeType.slice(0, 120), sizeBytes: item.sizeBytes };
          }),
        };
      }),
    };
  });
  return {
    physician: {
      name: clip(physician.name, 200), degreeType: clip(physician.degreeType, 20), npi: clip(physician.npi, 20), specialties: list(physician.specialties),
      primaryState: clip(physician.primaryState, 40), additionalStates: list(physician.additionalStates), email: clip(physician.email, 254),
    },
    grant: { purpose: clip(grant.purpose, 120), accessEndsAt, allowDownload: grant.allowDownload === true },
    sections, documentCount: documents,
  };
}

/** Header lines: who, their identifiers and states, and what this access is for. */
export function standingHeader(view, { timeZone } = {}) {
  const p = view.physician;
  const name = p.name && p.degreeType && !new RegExp(`[\\s,]${p.degreeType.replace(/[^A-Za-z]/g, "")}\\.?$`, "i").test(p.name) ? `${p.name}, ${p.degreeType}` : p.name || "Credential file";
  const states = [p.primaryState ? `${p.primaryState} (primary)` : "", ...p.additionalStates.filter(state => state !== p.primaryState)].filter(Boolean);
  const detail = [p.npi ? `NPI ${p.npi}` : "", p.specialties.join(", "), states.length ? `Licensed in ${states.join(", ")}` : "", p.email].filter(Boolean).join(DOT);
  const grant = [view.grant.purpose ? `Shared for: ${view.grant.purpose}.` : "", `Access ends ${formatEnd(view.grant.accessEndsAt, timeZone)}.`].filter(Boolean).join(" ");
  const downloads = view.grant.allowDownload
    ? "View only: nothing here can be changed. Downloads save a copy on your device, and that copy stays after access ends."
    : "View only: nothing here can be changed. The physician has turned off downloads for this access.";
  return { name, detail, grant, downloads };
}

/** Sections, records with expiry badges, and each record's files. Text nodes only. */
export function renderStandingView(container, view, { onOpen = () => {}, doc = document } = {}) {
  const el = (tag, className, text) => {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const nodes = [];
  if (!view.sections.length) nodes.push(el("p", "muted", "Nothing is shared right now. The physician may have changed what this access includes."));
  for (const section of view.sections) {
    const wrapper = el("section", "record-section");
    const heading = el("h3", null, `${section.label} (${section.records.length})`);
    const list = el("ul", "record-list");
    for (const record of section.records) {
      const item = el("li", "record");
      const head = el("div", "record-head");
      head.append(el("strong", "record-title", record.title));
      const status = expiryStatus(record.expirationDate);
      if (status) head.append(el("span", `badge ${status.tone}`, status.label));
      item.append(head);
      if (record.fields.length) {
        const fields = el("dl", "record-fields");
        for (const field of record.fields) fields.append(el("dt", null, field.label), el("dd", null, DATE.test(field.value) ? formatDate(field.value) : field.value));
        item.append(fields);
      }
      if (record.documents.length) {
        const files = el("ul", "record-files");
        for (const file of record.documents) {
          const row = el("li", "record-file");
          row.append(el("span", "document-name", file.name), el("span", "document-meta", fileMeta(file)));
          const actions = el("div", "document-actions");
          const available = documentActions(file, view.grant.allowDownload);
          for (const action of available) {
            const button = el("button", "secondary", action === "view" ? "Preview" : "Download");
            button.type = "button";
            button.setAttribute("aria-label", `${button.textContent} ${file.name}`);
            button.addEventListener("click", () => onOpen(file, action, row, button));
            actions.append(button);
          }
          if (!available.length) actions.append(el("span", "hint", Number.isInteger(file.sizeBytes) && file.sizeBytes > MAX_FILE_BYTES
            ? "Too large to open here. Ask the physician for a copy."
            : "This file type can only be downloaded, and downloads are off for this access."));
          row.append(actions);
          files.append(row);
        }
        item.append(files);
      }
      list.append(item);
    }
    if (section.records.length > 25) {
      const more = el("details", "record-more");
      more.append(el("summary", null, `Show all ${section.records.length}`), list);
      wrapper.append(heading, more);
    } else wrapper.append(heading, list);
    nodes.push(wrapper);
  }
  container.replaceChildren(...nodes);
}

// No browser persistence, analytics or automatic API calls. All document bytes
// arrive through authenticated POSTs; object URLs live only until closed/ended.
export function mountPortal({ inviteToken: initialInvite = "", config = PORTAL_CONFIG, fetchImpl = (...args) => fetch(...args) } = {}) {
  const byId = id => document.getElementById(id);
  const elements = Object.fromEntries([
    "loading-message", "access-panel", "steps", "message-view", "message-title", "message-detail",
    "email-form", "recipient-email", "code-form", "verification-code", "code-email", "resend-code", "change-email",
    "documents-view", "documents-title", "session-detail", "document-list", "refresh-documents", "end-access",
    "standing-view", "physician-name", "physician-detail", "grant-detail", "visit-detail", "download-note", "section-list", "refresh-standing", "end-standing",
    "preview-panel", "preview-title", "preview-frame", "close-preview", "status", "error",
  ].map(id => [id, byId(id)]));
  let inviteToken = TOKEN.test(initialInvite) ? initialInvite : "";
  initialInvite = "";
  let sessionToken = "", email = "", documents = [], expiresAt = 0, codeRequestedAt = 0, kind = "selection", standing = null;
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
    inviteToken = ""; sessionToken = ""; email = ""; documents = []; expiresAt = 0; kind = "selection"; standing = null;
    elements["email-form"].reset(); elements["code-form"].reset();
    elements["code-email"].textContent = ""; elements["session-detail"].textContent = "";
    elements["document-list"].replaceChildren(); elements["section-list"].replaceChildren();
    for (const id of ["physician-name", "physician-detail", "grant-detail", "visit-detail", "download-note"]) elements[id].textContent = "";
    closePreview(false);
    for (const url of urls) URL.revokeObjectURL(url);
    urls.clear();
    for (const timer of downloads) clearTimeout(timer);
    downloads.clear();
    busy = false;
  }
  function setStage(next) {
    stage = next;
    for (const [id, value] of [["message-view", "message"], ["email-form", "email"], ["code-form", "code"], ["documents-view", "documents"], ["standing-view", "standing"]]) elements[id].hidden = value !== stage;
    elements.steps.hidden = stage === "message";
    for (const item of elements.steps.children) {
      if (item.dataset.step === (stage === "standing" ? "documents" : stage)) item.setAttribute("aria-current", "step");
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
  // A standing link can be reopened until its end date; each visit gets a new code.
  const visitEnded = () => standing && Date.now() < standing.grant.accessEndsAt
    ? ["This visit has ended", `Open the link in your email again to start a new visit. You will get a new code. The link works until ${formatEnd(standing.grant.accessEndsAt)} unless the physician ends access sooner.`]
    : ["Your access has ended", "Ask the physician for a new invitation if you still need these documents. Files you already downloaded remain on your device."];
  function ensureSession() {
    if (sessionToken && Date.now() < expiresAt) return true;
    finish(...visitEnded());
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
    if (sessionToken) {
      const until = new Date(expiresAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
      elements["session-detail"].textContent = `Access ends at ${until}. Keep this page open.`;
      elements["visit-detail"].textContent = `This visit ends at ${until}. Reloading or closing the page also ends it.`;
    }
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
    const parsed = parseDocuments(value.documents);
    const nextKind = verifying ? (value.kind === "standing" ? "standing" : "selection") : kind;
    // A single-use selection visit lasts 30 minutes; a standing visit 60.
    const expiry = sessionExpiry(value, nextKind);
    if (verifying && !TOKEN.test(value.sessionToken || "")) throw new Error("invalid_response");
    if (verifying) { sessionToken = value.sessionToken; kind = nextKind; }
    expiresAt = expiry; documents = parsed;
  }
  function readStanding(value) {
    const parsed = parseStandingView(value);
    const expiry = sessionExpiry(value, "standing");
    standing = parsed; expiresAt = Math.min(expiresAt || expiry, expiry);
  }
  function renderStanding() {
    const header = standingHeader(standing);
    elements["physician-name"].textContent = header.name;
    elements["physician-detail"].textContent = header.detail;
    elements["grant-detail"].textContent = header.grant;
    elements["download-note"].textContent = header.downloads;
    renderStandingView(elements["section-list"], standing, { onOpen: (item, action, row, button) => openDocument(item, action, row, button) });
    updateControls();
  }
  async function refreshStanding(notice = "") {
    const value = await request("summary");
    if (!ensureSession()) return;
    readStanding(value);
    closePreview(false); renderStanding();
    status(notice || "Refreshed.");
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
        if (failure.status === 401 && kind === "standing") {
          // Either the visit ended or this file is no longer shared: ask for the live view.
          try { await refreshStanding("That file is no longer shared. The list below is current."); }
          catch (inner) { if (inner.status === 401) { finish(...visitEnded()); return; } throw inner; }
          return;
        }
        if (failure.status === 403 && kind === "standing") {
          // Downloads are off: a download, or a file that could only leave as one.
          standing.grant.allowDownload = false; renderStanding();
          status(""); error(fileMessage(action === "view" ? "view_refused" : "download_refused", false)); return;
        }
        if (failure.status === 401) { finish("These documents are no longer available", "Your access may have expired or been revoked, or a document may have changed. Ask the physician for a new invitation."); return; }
        if (failure.status === 409 && kind === "standing") { status(""); error("This file could not be opened right now. Try again, or ask the physician for a copy."); return; }
        if (failure.status === 409) {
          closePreview(false);
          for (const button of row.querySelectorAll("button")) button.dataset.unavailable = "true";
          const note = document.createElement("p"); note.className = "unavailable"; note.textContent = "This file has changed. Ask the physician for a new invitation.";
          row.append(note); status(""); error(note.textContent); return;
        }
        throw failure;
      }
      if (!ensureSession()) return;
      const canDownload = kind !== "standing" || standing?.grant.allowDownload === true;
      if (action === "view" && !previewAllowed(result.headers)) {
        status(fileMessage("not_previewable", canDownload)); return;
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
          if (previewOperation === previewGeneration && sessionOperation === generation) status(fileMessage("pdf_ready", canDownload));
        } catch {
          if (previewOperation === previewGeneration && sessionOperation === generation) { closePreview(false); error(fileMessage("pdf_failed", canDownload)); status(""); }
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
      let answeredKind = "";
      try {
        const result = await request("verify", { inviteToken, email, code });
        answeredKind = result?.kind === "standing" ? "standing" : "selection";
        readSessionResponse(result, true);
      } catch (failure) {
        elements["verification-code"].value = "";
        if (failure.status === 401) { status(""); error("That code could not be verified. Check the latest code and the invited email address. The access may have ended or been revoked. Repeated incorrect attempts can lock it."); return; }
        if (failure.status === 503) throw failure;
        if (failure.message === "discarded") return;
        // A standing link keeps working: a new visit needs only a new code.
        // A single-use invitation is spent once a code is accepted.
        finish("Verification was interrupted", answeredKind === "standing" ? "Open the link in your email again for a new code."
          : answeredKind === "selection" ? "Ask the physician for a new invitation. To protect these documents, access cannot be recovered from an interrupted verification."
          : "Open the link in your email again for a new code. If it no longer works, ask the physician for a new invitation."); return;
      }
      inviteToken = ""; email = "";
      elements["email-form"].reset(); elements["code-form"].reset(); elements["code-email"].textContent = "";
      if (kind === "standing") {
        status("Opening the credential file...");
        try { readStanding(await request("summary")); }
        catch (failure) {
          if (failure.message === "discarded") return;
          finish("The credential file could not open", "Open the link in your email again to start a new visit. You will get a new code."); return;
        }
        renderStanding(); setStage("standing"); status(""); focus(elements["physician-name"]);
        return;
      }
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
  listen(elements["end-standing"], "click", () => {
    const [, detail] = visitEnded();
    finish("You ended this visit", detail);
  });
  listen(elements["refresh-standing"], "click", () => {
    if (!ensureSession()) return;
    operation(async () => {
      status("Refreshing...");
      try { await refreshStanding(); }
      catch (failure) { if (failure.status === 401) { finish(...visitEnded()); return; } throw failure; }
    });
  });
  listen(elements["close-preview"], "click", () => closePreview());
  listen(window, "pagehide", () => finish(...(standing ? visitEnded() : ["This access has ended", "Reopen the invitation if you have not verified it yet. If you already verified a code, ask the physician for a new invitation."]), false));
  const checkTime = () => { if (sessionToken && Date.now() >= expiresAt) ensureSession(); else updateControls(); };
  listen(window, "focus", checkTime); listen(document, "visibilitychange", checkTime);
  const ticker = setInterval(checkTime, 1000);
  elements["loading-message"].hidden = true;
  // Never inside another site's frame (clickjacking). Headers add frame-ancestors too.
  let framed = false;
  try { framed = window.top !== window.self; } catch { framed = true; }
  if (framed) finish("Open this page directly", "For your security this page does not open inside another site. Open the link from your email in a new browser tab.", false);
  else if (!config.enabled) finish("Private invitations are not available yet", "Ask the physician for another way to receive the documents. This page will be available after private sharing is activated.", false);
  else if (!inviteToken) finish("Open your invitation email", "Use the link in your invitation email to start. Standing access sends a new code each time you open it.", false);
  else { setStage("email"); }
  return () => { finish("This visit has ended", "Open the link in your email again to continue.", false); clearInterval(ticker); for (const remove of listeners) remove(); };
}
