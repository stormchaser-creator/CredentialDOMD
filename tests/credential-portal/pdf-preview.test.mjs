import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createPdfPreview, pageDimensions, PDF_LIMITS } from "../../public/credential-access/pdf-preview.mjs";

test("page geometry bounds rendered pixels and rejects unsupported dimensions", () => {
  for (const [width, height] of [[612, 792], [14400, 14400], [14400, 10], [10, 14400]]) {
    const size = pageDimensions(width, height, 1200, 8);
    assert.ok(size.width * size.height <= PDF_LIMITS.pagePixels);
    assert.ok(size.width > 0 && size.height > 0 && size.scale > 0);
  }
  for (const dimensions of [[0, 200], [200, -1], [Infinity, 100], [NaN, 100], [200, 14401]]) assert.throws(() => pageDimensions(...dimensions, 500));
});

test("build assets match the exact dependency, retain licenses and omit executable PDF scripting", async () => {
  const pkg = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));
  const manifest = JSON.parse(await readFile(new URL("../../public/credential-access/vendor/manifest.json", import.meta.url), "utf8"));
  assert.equal(manifest.version, pkg.dependencies["pdfjs-dist"]);
  assert.ok(manifest.files.LICENSE && manifest.files["standard_fonts/LICENSE_FOXIT"] && manifest.files["standard_fonts/LICENSE_LIBERATION"]);
  for (const [name, expected] of Object.entries(manifest.files)) {
    assert.ok(!/sandbox|viewer|\.map$/.test(name));
    const bytes = await readFile(new URL("../../public/credential-access/vendor/" + name, import.meta.url));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), expected);
    if (name.endsWith(".mjs")) assert.doesNotMatch(bytes.toString(), /\beval\s*\(|new\s+Function\s*\(/);
  }
});

class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.attrs = {}; this.events = {}; this.clientWidth = 600; this.width = 0; this.height = 0; }
  setAttribute(name, value) { this.attrs[name] = value; }
  append(...items) { this.children.push(...items); }
  replaceChildren(...items) { this.children = [...items]; }
  addEventListener(name, handler) { this.events[name] = handler; }
  getContext() { return {}; }
}

test("PDF preview limits, resource restrictions, paging and cancellation", async t => {
  const original = { document: globalThis.document, window: globalThis.window, Worker: globalThis.Worker, fetch: globalThis.fetch };
  let terminated = 0, destroyed = 0, captured, renders = 0, fetched = 0;
  globalThis.document = { createElement: tag => new Element(tag) };
  globalThis.window = { devicePixelRatio: 2 };
  globalThis.Worker = class { constructor(url, options) { assert.ok(url.pathname.endsWith("/vendor/pdf.worker.min.mjs")); assert.equal(options.type, "module"); } terminate() { terminated++; } };
  globalThis.fetch = async () => { fetched++; throw new Error("unexpected external resource"); };
  t.after(() => { for (const [key, value] of Object.entries(original)) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; } });
  const library = promise => ({ PDFWorker: class { destroy() {} }, getDocument(options) { captured = options; return { promise, async destroy() { destroyed++; } }; } });
  const doc = { numPages: 2, async cleanup() {}, async getPage() { return { cleanup() {}, getViewport: ({ scale }) => ({ width: 612 * scale, height: 792 * scale }), render(options) { assert.equal(options.annotationMode, 1); renders++; return { promise: Promise.resolve(), cancel() {} }; } }; } };

  await t.test("one bounded canvas page at a time with static appearances and no remote resource lookup", async () => {
    const host = new Element("div");
    const preview = createPdfPreview(host, new Uint8Array([1]), "Synthetic.pdf", async () => library(Promise.resolve(doc)));
    await preview.ready;
    assert.equal(renders, 1);
    assert.equal(host.children[0].children[1].textContent, "Page 1 of 2");
    assert.ok(host.children[2].width * host.children[2].height <= PDF_LIMITS.pagePixels);
    for (const flag of ["enableXfa", "useWasm", "useWorkerFetch", "useSystemFonts"]) assert.equal(captured[flag], false);
    assert.equal(captured.disableFontFace, true);
    assert.equal(captured.stopAtErrors, true);
    assert.equal(captured.url, undefined);
    const fonts = new captured.BinaryDataFactory();
    for (const request of [{ kind: "wasmUrl", filename: "a.wasm" }, { kind: "cMapUrl", filename: "a.bcmap" }, { kind: "standardFontDataUrl", filename: "../../external" }]) await assert.rejects(fonts.fetch(request));
    assert.equal(fetched, 0);
    const factory = new captured.CanvasFactory();
    const intermediate = factory.create(1000, 1000);
    assert.throws(() => factory.create(5000, 5000));
    factory.destroy(intermediate);
    await host.children[0].children[2].events.click();
    assert.equal(renders, 2);
    assert.equal(host.children[0].children[1].textContent, "Page 2 of 2");
    preview.close();
    assert.equal(host.children[2].width, 0);
    assert.equal(host.children[2].height, 0);
  });

  await t.test("over-limit documents fall back before rendering any page", async () => {
    const before = renders, host = new Element("div");
    const preview = createPdfPreview(host, new Uint8Array([1]), "Large.pdf", async () => library(Promise.resolve({ ...doc, numPages: 51 })));
    await preview.ready;
    assert.equal(renders, before);
    assert.equal(host.children[0].children[1].textContent, "Preview unavailable");
    assert.match(host.children[1].textContent, /choose Download/);
  });

  await t.test("closing during unresolved parsing settles promptly and prevents a late render", async () => {
    const before = renders, host = new Element("div");
    let resolve;
    const parse = new Promise(done => { resolve = done; });
    const preview = createPdfPreview(host, new Uint8Array([1]), "Pending.pdf", async () => library(parse));
    await new Promise(done => setImmediate(done));
    preview.close();
    await preview.ready;
    resolve(doc);
    await new Promise(done => setImmediate(done));
    assert.equal(renders, before);
    assert.equal(host.children[2].width, 0);
  });
  assert.equal(terminated, 3);
  assert.equal(destroyed, 3);
});
