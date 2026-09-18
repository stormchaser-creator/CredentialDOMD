// Display-only PDF rendering. The full PDF.js viewer, scripting sandbox,
// interactive annotations/forms, embedded files and external links are absent.
// Static annotation appearances can be painted as pixels, without their actions.
export const PDF_LIMITS = Object.freeze({ pages: 50, pagePixels: 4_000_000, canvasPixels: 16_000_000, imagePixels: 16_000_000, loadMs: 15000, pageMs: 10000 });
const FONTS = new Set([
  "FoxitDingbats.pfb", "FoxitFixed.pfb", "FoxitFixedBold.pfb", "FoxitFixedBoldItalic.pfb", "FoxitFixedItalic.pfb",
  "FoxitSerif.pfb", "FoxitSerifBold.pfb", "FoxitSerifBoldItalic.pfb", "FoxitSerifItalic.pfb", "FoxitSymbol.pfb",
  "LiberationSans-Bold.ttf", "LiberationSans-BoldItalic.ttf", "LiberationSans-Italic.ttf", "LiberationSans-Regular.ttf",
]);

export function pageDimensions(width, height, availableWidth, pixelRatio = 1) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0 || width > 14400 || height > 14400) throw new Error("unsupported_pdf_dimensions");
  const desired = Math.min(Math.max(availableWidth, 200), 1200) / width * Math.min(Math.max(pixelRatio, 1), 2);
  const scale = Math.min(desired, Math.sqrt(PDF_LIMITS.pagePixels / (width * height)));
  return { scale, width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)) };
}

export function createPdfPreview(container, bytes, name, loadLibrary = () => import("./vendor/pdf.min.mjs")) {
  let disposed = false, loading = null, pdf = null, port = null, worker = null, renderTask = null, page = null, number = 1, pending = false;
  let controller = new AbortController();
  const timers = new Set(), canvases = new Map();
  const toolbar = document.createElement("div"), previous = document.createElement("button"), next = document.createElement("button"), label = document.createElement("span"), canvas = document.createElement("canvas"), note = document.createElement("p");
  toolbar.className = "pdf-toolbar"; label.setAttribute("role", "status"); label.textContent = "Preparing PDF…";
  for (const [button, text] of [[previous, "Previous page"], [next, "Next page"]]) { button.type = "button"; button.textContent = text; button.className = "secondary"; button.disabled = true; }
  toolbar.append(previous, label, next);
  canvas.className = "pdf-canvas"; canvas.setAttribute("role", "img"); canvas.hidden = true;
  note.className = "hint"; note.textContent = "Read-only page preview. Links, form editing and document actions are unavailable. Some features may display differently; download the original for all content or to use your preferred accessible PDF reader.";
  container.replaceChildren(toolbar, note, canvas);

  function controls() { previous.disabled = disposed || pending || number <= 1; next.disabled = disposed || pending || !pdf || number >= pdf.numPages; }
  function release() {
    if (disposed) return;
    disposed = true; controller.abort();
    for (const timer of timers) clearTimeout(timer); timers.clear();
    renderTask?.cancel(); renderTask = null;
    // Terminate the actual worker even when document parsing has not completed.
    try { loading?.destroy()?.catch(() => {}); } catch { /* already destroyed */ }
    try { worker?.destroy(); } catch { /* already destroyed */ }
    port?.terminate(); port = null; loading = null; worker = null; pdf = null; page = null; bytes = null;
    for (const target of canvases.keys()) target.width = target.height = 0;
    canvases.clear(); canvas.width = canvas.height = 0; canvas.hidden = true;
    controls();
  }
  async function bounded(promise, ms) {
    let timer, aborted;
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("pdf_preview_timeout")), ms); timers.add(timer); });
    const closed = new Promise((_, reject) => { aborted = () => reject(new Error("preview_closed")); controller.signal.addEventListener("abort", aborted, { once: true }); if (controller.signal.aborted) aborted(); });
    try { return await Promise.race([promise, timeout, closed]); }
    finally { clearTimeout(timer); timers.delete(timer); controller.signal.removeEventListener("abort", aborted); }
  }
  function fail() {
    release();
    label.textContent = "Preview unavailable";
    note.textContent = "This PDF cannot be previewed here. It may be protected, too complex, or exceed the 50-page preview limit. Close this preview and choose Download to open the original.";
  }
  // Bounds also apply to intermediate canvases allocated by the display layer.
  class BoundedCanvasFactory {
    create(width, height) {
      const target = document.createElement("canvas"); this.reset({ canvas: target }, width, height);
      const context = target.getContext("2d", { willReadFrequently: true });
      if (!context) throw new Error("canvas_unavailable");
      return { canvas: target, context };
    }
    reset({ canvas: target }, width, height) {
      width = Math.ceil(width); height = Math.ceil(height);
      const pixels = width * height, total = [...canvases.values()].reduce((a, b) => a + b, 0) - (canvases.get(target) || 0) + pixels;
      if (disposed || width < 1 || height < 1 || !Number.isFinite(pixels) || pixels > PDF_LIMITS.canvasPixels || total > PDF_LIMITS.canvasPixels) throw new Error("pdf_canvas_limit");
      target.width = width; target.height = height; canvases.set(target, pixels);
    }
    destroy(value) { if (value.canvas) { canvases.delete(value.canvas); value.canvas.width = value.canvas.height = 0; value.canvas = null; value.context = null; } }
  }
  // PDF bytes never choose a fetch URL. Only package-owned, named standard-font
  // assets can load. CMaps/WASM/external resources fail closed to Download.
  class LocalBinaryDataFactory {
    async fetch({ kind, filename }) {
      if (disposed || kind !== "standardFontDataUrl" || !FONTS.has(filename)) throw new Error("unsupported_pdf_resource");
      const response = await fetch(new URL(`./vendor/standard_fonts/${filename}`, import.meta.url), { cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer", redirect: "error", signal: controller.signal });
      if (!response.ok) throw new Error("pdf_font_unavailable");
      const data = new Uint8Array(await response.arrayBuffer());
      if (disposed || data.byteLength > 1024 * 1024) throw new Error("pdf_font_limit");
      return data;
    }
  }
  async function render(target) {
    if (disposed || pending || !pdf || target < 1 || target > pdf.numPages) return;
    pending = true; controls(); label.textContent = `Preparing page ${target}…`;
    try {
      page?.cleanup(); page = null; canvas.width = canvas.height = 0; canvas.hidden = true;
      const current = await bounded(pdf.getPage(target), PDF_LIMITS.pageMs);
      if (disposed) return;
      page = current;
      const original = page.getViewport({ scale: 1 });
      const size = pageDimensions(original.width, original.height, container.clientWidth, window.devicePixelRatio || 1);
      const viewport = page.getViewport({ scale: size.scale });
      canvas.width = size.width; canvas.height = size.height;
      canvas.setAttribute("aria-label", `${name}, page ${target} of ${pdf.numPages}`);
      renderTask = page.render({ canvas, viewport, annotationMode: 1, background: "rgb(255,255,255)" });
      await bounded(renderTask.promise, PDF_LIMITS.pageMs);
      if (disposed) return;
      number = target; label.textContent = `Page ${number} of ${pdf.numPages}`; canvas.hidden = false;
      renderTask = null; page.cleanup();
      await pdf.cleanup();
    } catch { if (!disposed) fail(); }
    finally { pending = false; controls(); }
  }
  previous.addEventListener("click", () => render(number - 1)); next.addEventListener("click", () => render(number + 1));
  const ready = (async () => {
    try {
      const library = await bounded(loadLibrary(), PDF_LIMITS.loadMs);
      if (disposed) return;
      port = new Worker(new URL("./vendor/pdf.worker.min.mjs", import.meta.url), { type: "module" });
      worker = new library.PDFWorker({ port });
      loading = library.getDocument({
        data: bytes, worker, disableRange: true, disableStream: true, disableAutoFetch: true,
        enableXfa: false, useWasm: false, useWorkerFetch: false, disableFontFace: true, useSystemFonts: false,
        isOffscreenCanvasSupported: true, isImageDecoderSupported: false,
        maxImageSize: PDF_LIMITS.imagePixels, canvasMaxAreaInBytes: PDF_LIMITS.pagePixels * 4,
        stopAtErrors: true, verbosity: 0, CanvasFactory: BoundedCanvasFactory, BinaryDataFactory: LocalBinaryDataFactory,
      });
      bytes = null; // Typed data is transferred to the dedicated worker.
      pdf = await bounded(loading.promise, PDF_LIMITS.loadMs);
      if (disposed) return;
      if (!Number.isInteger(pdf.numPages) || pdf.numPages < 1 || pdf.numPages > PDF_LIMITS.pages) { fail(); return; }
      await render(1);
    } catch { if (!disposed) fail(); }
  })();
  return { ready, close: release };
}
