import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import vm from "node:vm";
import { packageSite } from "../scripts/package-site.mjs";
import { renderHelp } from "../scripts/build-help.mjs";
import { renderCme } from "../scripts/build-cme.mjs";
import { renderLegalPages } from "../scripts/generate-legal-pages.mjs";
import { loadVideoCatalog, WATCH_PAGES } from "../scripts/help-videos.mjs";

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Baseline fixtures test byte-preserving packaging, independent of live launch mode.
const BASELINE_LAUNCH_MODE = Object.freeze({ enabled: false, signupHref: null });
const pages = ["index", "locums", "security", "privacy", "terms", "help", "cme", "credential-access"];
const read = path => readFile(path, "utf8");
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
// Include default images and responsive candidates advertised by the real
// homepage, independently of the packager's asset allowlist.
const homepageImagePaths = html => [...new Set(html.match(/\/images\/[a-zA-Z0-9._-]+\.webp/g) || [])];

async function siteFixture(t) {
  const root = await mkdtemp(resolve(tmpdir(), "credentialdo-packaging-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const path of ["dist/assets", "landing/states", "public", "scripts"]) await mkdir(resolve(root, path), { recursive: true });
  await writeFile(resolve(root, "dist/index.html"), '<!doctype html><script type="module" src="/app/assets/synthetic.js"></script>');
  await writeFile(resolve(root, "dist/assets/synthetic.js"), "// synthetic app asset\n");
  await writeFile(resolve(root, "dist/sw.js"), "// synthetic stamped /app/ worker\n");
  await writeFile(resolve(root, "dist/version.json"), '{"build":"synthetic"}\n');
  await writeFile(resolve(root, "public/unreviewed.js"), "// must not become a root asset\n");
  await writeFile(resolve(root, "landing/states/example.html"), "<!doctype html><title>Synthetic state guide</title>");
  await Promise.all([
    ...pages.map(page => cp(resolve(sourceRoot, `landing/${page}.html`), resolve(root, `landing/${page}.html`))),
    ...["robots.txt", "sitemap.xml", "organization-logo.svg", "support-nav.css", "support-nav.js", "waitlist-signup.js", "credential-access", "knowledge", "cme-assets"].map(path => cp(resolve(sourceRoot, "public", path), resolve(root, "public", path), { recursive: true })),
    ...["root-sw-retirement.js", "build-credential-portal.mjs"].map(path => cp(resolve(sourceRoot, "scripts", path), resolve(root, "scripts", path))),
    cp(resolve(sourceRoot, "package.json"), resolve(root, "package.json")),
    cp(resolve(sourceRoot, "landing/states/states-data.json"), resolve(root, "landing/states/states-data.json")),
    cp(resolve(sourceRoot, "landing/images"), resolve(root, "landing/images"), { recursive: true }),
  ]);
  await writeFile(resolve(root, "landing/images/unreviewed.webp"), "not a reviewed runtime image");
  await writeFile(resolve(root, "landing/images/source-original.png"), "source originals must not ship");
  // Keep this route/worker fixture independent of optional release videos.
  // Video hash/copy/review behavior has its own synthetic fixture suite.
  const help = JSON.parse(await read(resolve(root, "public/knowledge/credentialdo-help.json")));
  await writeFile(resolve(root, "landing/help.html"), renderHelp(help));
  const cme = JSON.parse(await read(resolve(root, "public/knowledge/credentialdo-cme.json")));
  const states = JSON.parse(await read(resolve(root, "landing/states/states-data.json")));
  await writeFile(resolve(root, "landing/cme.html"), renderCme(cme, states));
  await writeFile(resolve(root, "public/cme-assets/unreviewed.js"), "// not a declared CME asset\n");
  // Generate vendor bytes only in the isolated fixture, including on a fresh
  // checkout where ignored vendor output has not been generated yet.
  await symlink(resolve(sourceRoot, "node_modules"), resolve(root, "node_modules"), "dir");
  execFileSync(process.execPath, [resolve(root, "scripts/build-credential-portal.mjs")], { stdio: "pipe" });
  return root;
}

function headerRules(text) {
  const rules = new Map();
  let headers;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    if (line.startsWith("/")) { headers = new Map(); rules.set(line, headers); }
    else {
      const match = line.match(/^\s+([^:]+):\s*(.*)$/);
      assert.ok(match, `invalid header line: ${line}`);
      assert.ok(!headers.has(match[1]), `duplicate header: ${match[1]}`);
      headers.set(match[1], match[2]);
    }
  }
  return rules;
}

test("site package keeps public help/CME, private routes, declared assets and distinct workers intact", async t => {
  const root = await siteFixture(t);
  const output = await packageSite(root, undefined, BASELINE_LAUNCH_MODE);
  // Legal pages are generated for the requested mode; committed source may
  // describe the active paid release even in this baseline fixture.
  const baselineLegal = renderLegalPages(BASELINE_LAUNCH_MODE);
  for (const page of pages) {
    const expected = baselineLegal[`${page}.html`] || await read(resolve(root, `landing/${page}.html`));
    assert.equal(await read(resolve(output, `${page}.html`)), expected);
    if (page !== "index") assert.equal(await read(resolve(output, page, "index.html")), expected);
  }
  for (const page of ['privacy', 'terms']) assert.equal(await read(resolve(output, `app/${page}.html`)), await read(resolve(output, `${page}.html`)));
  assert.equal(await read(resolve(output, "app/assets/synthetic.js")), "// synthetic app asset\n");
  assert.equal(await read(resolve(output, "app/sw.js")), "// synthetic stamped /app/ worker\n");
  assert.equal(await read(resolve(output, "sw.js")), await read(resolve(sourceRoot, "scripts/root-sw-retirement.js")));
  await assert.rejects(read(resolve(output, "unreviewed.js")), { code: "ENOENT" });
  assert.equal(await read(resolve(output, ".nojekyll")), "");
  assert.equal(await read(resolve(output, "CNAME")), "credentialdomd.com\n");
  assert.match(await read(resolve(output, "404.html")), /Page not found/);
  assert.equal(await read(resolve(output, "_redirects")), "/app/privacy /privacy 302\n/app/terms /terms 302\n");
  assert.doesNotMatch(await read(resolve(output, "sitemap.xml")), /credential-access/);
  assert.match(await read(resolve(output, "sitemap.xml")), /<loc>https:\/\/credentialdomd\.com\/cme\/<\/loc>/);
  assert.match(await read(resolve(output, "sitemap.xml")), /<loc>https:\/\/credentialdomd\.com\/help<\/loc>/);
  assert.equal(await read(resolve(output, "organization-logo.svg")), await read(resolve(root, "public/organization-logo.svg")));
  for (const file of ["support-nav.css", "support-nav.js", "waitlist-signup.js"]) {
    assert.equal(await read(resolve(output, file)), await read(resolve(root, "public", file)));
  }
  for (const page of ["index.html", "locums.html"]) {
    const html = await read(resolve(output, page));
    assert.equal((html.match(/<script type="module" src="\/waitlist-signup\.js"><\/script>/g) || []).length, 1);
    assert.doesNotMatch(html, /var postSignup =|postSignup\('\/api\/waitlist'/);
  }
  const imagePaths = homepageImagePaths(await read(resolve(output, "index.html")));
  assert.equal(imagePaths.length, 7, "all reviewed responsive homepage images must be advertised");
  assert.deepEqual((await readdir(resolve(output, "images"))).sort(), imagePaths.map(path => path.slice("/images/".length)).sort(),
    "package only referenced runtime images, excluding unreviewed files and source originals");
  for (const path of imagePaths) {
    const source = await readFile(resolve(root, "landing", path.slice(1)));
    assert.equal(source.subarray(0, 4).toString(), "RIFF");
    assert.equal(source.subarray(8, 12).toString(), "WEBP");
    assert.deepEqual(await readFile(resolve(output, path.slice(1))), source, `preserve exact reviewed image bytes: ${path}`);
  }
  for (const { id } of WATCH_PAGES) {
    await assert.rejects(read(resolve(output, 'help', id, 'index.html')), { code: 'ENOENT' });
    assert.ok(!(await read(resolve(output, 'sitemap.xml'))).includes(`https://credentialdomd.com/help/${id}/`));
  }
  assert.equal(await read(resolve(output, "knowledge/credentialdo-help.json")), await read(resolve(root, "public/knowledge/credentialdo-help.json")));
  assert.equal(await read(resolve(output, "knowledge/credentialdo-cme.json")), await read(resolve(root, "public/knowledge/credentialdo-cme.json")));
  for (const file of ["cme.css", "cme.mjs"]) assert.equal(await read(resolve(output, "cme-assets", file)), await read(resolve(root, "public/cme-assets", file)));
  await assert.rejects(read(resolve(output, "cme-assets/unreviewed.js")), { code: "ENOENT" });

  const config = await import(pathToFileURL(resolve(output, "credential-access/portal.mjs")).href);
  assert.equal(config.PORTAL_CONFIG.enabled, false, "this release must keep private access disabled");
  const manifest = JSON.parse(await read(resolve(output, "credential-access/vendor/manifest.json")));
  const packageJson = JSON.parse(await read(resolve(root, "package.json")));
  assert.equal(manifest.version, packageJson.dependencies["pdfjs-dist"]);
  for (const file of ["pdf.min.mjs", "pdf.worker.min.mjs", "LICENSE", "standard_fonts/LICENSE_FOXIT", "standard_fonts/LICENSE_LIBERATION"]) assert.ok(manifest.files[file]);
  for (const [file, hash] of Object.entries(manifest.files)) {
    assert.equal(sha256(await readFile(resolve(output, "credential-access/vendor", file))), hash, file);
  }
  for (const file of ["portal.css", "portal.mjs", "pdf-preview.mjs"]) {
    assert.equal(await read(resolve(output, "credential-access", file)), await read(resolve(root, "public/credential-access", file)));
  }

  const html = await read(resolve(output, "credential-access/index.html"));
  assert.match(html, /name="robots" content="noindex, nofollow, noarchive"/);
  assert.match(html, /name="referrer" content="no-referrer"/);
  const csp = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)[1];
  const bootstrap = html.match(/<script id="portal-bootstrap">([\s\S]*?)<\/script>/)[1];
  const hash = createHash("sha256").update(bootstrap).digest("base64");
  assert.ok(csp.includes(`'sha256-${hash}'`));
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval|https:\/\/(?!hkpnnsjcwprrwobmpqyy\.supabase\.co)/);
  const headerText = await read(resolve(output, "_headers"));
  for (const line of headerText.split("\n")) assert.ok(line.length <= 2000, "Cloudflare header line limit");
  const rules = headerRules(headerText);
  for (const route of ["/credential-access", "/credential-access.html", "/credential-access/*"]) {
    assert.equal(rules.get(route).get("Cache-Control"), "no-store");
    assert.equal(rules.get(route).get("Referrer-Policy"), "no-referrer");
    assert.equal(rules.get(route).get("X-Robots-Tag"), "noindex, nofollow, noarchive");
    assert.equal(rules.get(route).get("X-Content-Type-Options"), "nosniff");
    assert.equal(rules.get(route).get("Content-Security-Policy"), `${csp}; frame-ancestors 'none'`);
  }
  for (const route of ["/sw.js", "/app/sw.js"]) assert.equal(rules.get(route).get("Cache-Control"), "no-cache");
});

test('packaged watch pages resolve their media, canonical, related guides and sitemap entries', async t => {
  const root = await siteFixture(t);
  // These existing reviewed assets are hash-checked by the real packaging path;
  // no synthetic media or unreviewed file is published to the site.
  await cp(resolve(sourceRoot, 'landing/help-videos'), resolve(root, 'landing/help-videos'), { recursive: true });
  const catalog = await loadVideoCatalog(root);
  const help = JSON.parse(await read(resolve(root, 'public/knowledge/credentialdo-help.json')));
  await writeFile(resolve(root, 'landing/help.html'), renderHelp(help, catalog));
  const output = await packageSite(root, undefined, BASELINE_LAUNCH_MODE);
  const sitemap = await read(resolve(output, 'sitemap.xml'));
  for (const { id } of WATCH_PAGES) {
    const html = await read(resolve(output, 'help', id, 'index.html'));
    const canonical = `https://credentialdomd.com/help/${id}/`;
    assert.ok(html.includes(`<link rel="canonical" href="${canonical}">`));
    assert.equal(sitemap.split(`<loc>${canonical}</loc>`).length - 1, 1);
    for (const [, path] of html.matchAll(/(?:src|poster|href)="(\/help\/videos\/[^"#]+)"/g)) {
      await readFile(resolve(output, path.slice(1)));
    }
    for (const [, path] of html.matchAll(/href="(\/help\/[a-z-]+\/)"/g)) {
      await read(resolve(output, path.slice(1), 'index.html'));
    }
    assert.ok((await read(resolve(output, 'help/index.html'))).includes(`href="/help/${id}/"`));
    assert.match(html, /id="main"/);
  }
  const home = await read(resolve(output, 'index.html'));
  const organization = [...home.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
    .map(match => JSON.parse(match[1])).find(item => item['@type'] === 'Organization');
  const logo = new URL(organization.logo);
  assert.equal(logo.origin, 'https://credentialdomd.com');
  assert.equal(logo.pathname, '/organization-logo.svg');
  assert.match(await read(resolve(output, logo.pathname.slice(1))), /width="192" height="192"/);
});

test("invalid app base or missing retirement script preserves the previous package", async t => {
  const root = await siteFixture(t);
  await mkdir(resolve(root, "site-dist"));
  await writeFile(resolve(root, "site-dist/sentinel.txt"), "previous reviewed artifact");
  await writeFile(resolve(root, "dist/index.html"), '<script src="/assets/wrong.js"></script>');
  await assert.rejects(packageSite(root, undefined, BASELINE_LAUNCH_MODE), /--base=\/app\//);
  assert.equal(await read(resolve(root, "site-dist/sentinel.txt")), "previous reviewed artifact");
  await writeFile(resolve(root, "dist/index.html"), '<script src="/app/assets/synthetic.js"></script>');
  await rm(resolve(root, "scripts/root-sw-retirement.js"));
  await assert.rejects(packageSite(root, undefined, BASELINE_LAUNCH_MODE), { code: "ENOENT" });
  assert.equal(await read(resolve(root, "site-dist/sentinel.txt")), "previous reviewed artifact");
});

test('paid mode packages all public signup surfaces while retaining guide-only requests and synchronized legal copies', async t => {
  const root = await siteFixture(t);
  await rm(resolve(root, 'landing/states/example.html'));
  for (const name of (await readdir(resolve(sourceRoot, 'landing/states'))).filter(name => name.endsWith('.html'))) {
    await cp(resolve(sourceRoot, 'landing/states', name), resolve(root, 'landing/states', name));
  }
  // Synthetic route for offline rendering only; no provider/auth/checkout is enabled.
  const before = new Map(await Promise.all(pages.map(async page => [page, await read(resolve(root, `landing/${page}.html`))])));
  const output = await packageSite(root, undefined, { enabled: true, signupHref: '/signup/' });
  for (const page of ['index', 'locums', 'help', 'cme', 'privacy', 'terms', 'security']) {
    const html = await read(resolve(output, `${page}.html`));
    assert.match(html, /data-public-launch="founding-signup"/);
    assert.match(html, /href="\/signup\/"/);
    assert.doesNotMatch(html, /<form\b[^>]*\bclass="[^"]*wl-form/);
    assert.equal(await read(resolve(root, `landing/${page}.html`)), before.get(page), 'paid rendering does not mutate source');
  }
  const statePages = (await readdir(resolve(output, 'states'))).filter(name => name.endsWith('.html'));
  assert.equal(statePages.length, 52);
  for (const name of statePages) {
    const html = await read(resolve(output, 'states', name));
    assert.match(html, /href="\/signup\/"/);
    assert.doesNotMatch(html, /<input\b[^>]*name="waitlist"/);
  }
  for (const page of ['privacy', 'terms']) {
    const html = await read(resolve(output, `${page}.html`));
    assert.equal(await read(resolve(output, page, 'index.html')), html);
    assert.equal(await read(resolve(output, `app/${page}.html`)), html);
  }
  assert.match(await read(resolve(output, 'terms.html')), /Membership, early release and pricing/);
  const knowledge = JSON.parse(await read(resolve(output, 'knowledge/credentialdo-help.json')));
  assert.equal(await read(resolve(output, 'app/knowledge/credentialdo-help.json')), await read(resolve(output, 'knowledge/credentialdo-help.json')));
  assert.match(knowledge.articles.find(article => article.id === 'first-license').availability, /signed-in account with active Credential access/);
  assert.doesNotMatch(JSON.stringify(knowledge), /An invited, signed-in account|new invited physicians|billing is off/i);
  assert.match(knowledge.articles.find(article => article.id === 'locum-contract').availability, /separate 30-day Practice trial/);
  assert.equal(await read(resolve(output, 'knowledge/credentialdo-cme.json')), await read(resolve(root, 'public/knowledge/credentialdo-cme.json')));
});

test('paid launch refuses incomplete URL, stale legal content, missing widgets or missing whole guide before replacing a package', async t => {
  const root = await siteFixture(t);
  await rm(resolve(root, 'landing/states/example.html'));
  for (const name of (await readdir(resolve(sourceRoot, 'landing/states'))).filter(name => name.endsWith('.html'))) {
    await cp(resolve(sourceRoot, 'landing/states', name), resolve(root, 'landing/states', name));
  }
  await mkdir(resolve(root, 'site-dist'));
  await writeFile(resolve(root, 'site-dist/sentinel.txt'), 'previous reviewed artifact');
  const paid = { enabled: true, signupHref: '/signup/' };
  const preserved = async () => assert.equal(await read(resolve(root, 'site-dist/sentinel.txt')), 'previous reviewed artifact');
  await assert.rejects(packageSite(root, undefined, { enabled: true, signupHref: null }), /reviewed signup destination/);
  await preserved();
  const termsPath = resolve(root, 'landing/terms.html');
  const terms = await read(termsPath);
  await writeFile(termsPath, terms + '<p>Stale legal policy</p>');
  await assert.rejects(packageSite(root, undefined, paid), /Legal page is stale/);
  await preserved();
  await writeFile(termsPath, terms);
  const guidePath = resolve(root, 'landing/states/ohio.html');
  const guide = await read(guidePath);
  await writeFile(guidePath, guide.replace(/<!-- public-launch:guide-consent -->[\s\S]*?<!-- \/public-launch:guide-consent -->/, ''));
  await assert.rejects(packageSite(root, undefined, paid), /Incomplete state-guides migration: guide-consent/);
  await preserved();
  await rm(guidePath);
  await assert.rejects(packageSite(root, undefined, paid), /all 51 state guides/);
  await preserved();
});

test("stale CME page or missing required CME asset preserves the previous package", async t => {
  const root = await siteFixture(t);
  await mkdir(resolve(root, "site-dist"));
  await writeFile(resolve(root, "site-dist/sentinel.txt"), "previous reviewed artifact");
  const cmePage = await read(resolve(root, "landing/cme.html"));
  await writeFile(resolve(root, "landing/cme.html"), cmePage + "\n<!-- stale manual change -->\n");
  await assert.rejects(packageSite(root, undefined, BASELINE_LAUNCH_MODE), /CME page is stale/);
  assert.equal(await read(resolve(root, "site-dist/sentinel.txt")), "previous reviewed artifact");
  await writeFile(resolve(root, "landing/cme.html"), cmePage);
  await rm(resolve(root, "public/cme-assets/cme.mjs"));
  await assert.rejects(packageSite(root, undefined, BASELINE_LAUNCH_MODE), { code: "ENOENT" });
  assert.equal(await read(resolve(root, "site-dist/sentinel.txt")), "previous reviewed artifact");
});

test("missing invitation controller preserves the previous package", async t => {
  const root = await siteFixture(t);
  const output = await packageSite(root, undefined, BASELINE_LAUNCH_MODE);
  const previous = await read(resolve(output, "waitlist-signup.js"));
  await writeFile(resolve(output, "previous-artifact-sentinel.txt"), "previous reviewed artifact");
  const missingPath = resolve(root, "public/waitlist-signup.js");
  await rm(missingPath);
  await assert.rejects(packageSite(root, undefined, BASELINE_LAUNCH_MODE), { code: "ENOENT", path: missingPath });
  assert.equal(await read(resolve(output, "waitlist-signup.js")), previous);
  assert.equal(await read(resolve(output, "previous-artifact-sentinel.txt")), "previous reviewed artifact");
});

test("each missing homepage image fails before replacing the previous package", async t => {
  const root = await siteFixture(t);
  const output = await packageSite(root, undefined, BASELINE_LAUNCH_MODE);
  const imagePaths = homepageImagePaths(await read(resolve(output, "index.html")));
  const previousFiles = ["index.html", "app/index.html", "app/sw.js", "sw.js", "_headers", ...imagePaths.map(path => path.slice(1))];
  const previousHashes = await Promise.all(previousFiles.map(async path => sha256(await readFile(resolve(output, path)))));
  await writeFile(resolve(output, "previous-artifact-sentinel.txt"), "previous reviewed artifact");
  for (const path of imagePaths) {
    const sourcePath = resolve(root, "landing", path.slice(1));
    const bytes = await readFile(sourcePath);
    await rm(sourcePath);
    await assert.rejects(packageSite(root, undefined, BASELINE_LAUNCH_MODE), { code: "ENOENT", path: sourcePath });
    assert.equal(await read(resolve(output, "previous-artifact-sentinel.txt")), "previous reviewed artifact", path);
    assert.deepEqual(await Promise.all(previousFiles.map(async file => sha256(await readFile(resolve(output, file))))), previousHashes,
      `missing ${path} must preserve the prior pages, workers, headers and every image`);
    await writeFile(sourcePath, bytes);
  }
});

function loadWorker(source, { pathname = "/sw.js", scope = "/", offline = false } = {}) {
  const origin = "https://credentialdomd.com";
  const handlers = new Map();
  const calls = { fetch: [], cache: [], skipWaiting: 0, unregister: 0 };
  const forbidden = operation => () => { throw new Error(`unexpected worker operation: ${operation}`); };
  const self = {
    location: new URL(pathname, origin),
    registration: { scope: new URL(scope, origin).href, unregister: async () => { calls.unregister++; return true; } },
    skipWaiting: async () => { calls.skipWaiting++; },
    clients: { claim: forbidden("claim"), matchAll: forbidden("matchAll") },
    addEventListener: (event, handler) => { handlers.set(event, handler); },
  };
  vm.runInNewContext(source, {
    self, URL, Request, Response,
    fetch: async (request, options) => {
      calls.fetch.push({ url: request.url, options });
      if (offline) throw new Error("synthetic offline");
      return new Response("network bytes");
    },
    caches: {
      match: async request => { calls.cache.push(request); return new Response("cached app shell"); },
      open: forbidden("cache open"), delete: forbidden("cache delete"), keys: forbidden("cache enumeration"),
    },
  });
  return {
    handlers, calls,
    async lifecycle(event) {
      const waits = [];
      handlers.get(event)?.({ waitUntil: promise => waits.push(promise) });
      await Promise.all(waits);
    },
    async request(path, options = {}) {
      let response;
      handlers.get("fetch")?.({
        request: { url: new URL(path, origin).href, method: "GET", mode: "navigate", ...options },
        respondWith: promise => { response = promise; },
      });
      return response;
    },
  };
}

test("root retirement unregisters only its own root registration without cache or client changes", async () => {
  const source = await read(resolve(sourceRoot, "scripts/root-sw-retirement.js"));
  const root = loadWorker(source);
  assert.deepEqual([...root.handlers.keys()], ["install", "activate"]);
  await root.lifecycle("install");
  await root.lifecycle("activate");
  assert.equal(root.calls.skipWaiting, 1);
  assert.equal(root.calls.unregister, 1);
  assert.deepEqual(root.calls.cache, []);
  assert.deepEqual(root.calls.fetch, []);
  for (const config of [{ pathname: "/app/sw.js", scope: "/app/" }, { scope: "/app/" }, { pathname: "/other-sw.js" }]) {
    const other = loadWorker(source, config);
    assert.equal(other.handlers.size, 0, "a misplaced retirement file must not touch the app registration");
    assert.equal(other.calls.unregister, 0);
    assert.equal(other.calls.skipWaiting, 0);
  }
});

test("updated workers bypass caching and app-shell fallback for every private route", async () => {
  const source = await read(resolve(sourceRoot, "public/sw.js"));
  for (const pathname of ["/sw.js", "/app/sw.js"]) {
    for (const offline of [false, true]) {
      const worker = loadWorker(source, { pathname, offline });
      for (const route of ["/credential-access", "/credential-access/", "/credential-access.html?test=1", "/credential-access/portal.mjs", "/credential-access/vendor/pdf.worker.min.mjs"]) {
        const response = await worker.request(route);
        assert.equal(worker.calls.fetch.at(-1).options.cache, "no-store");
        if (offline) {
          assert.equal(response.status, 503);
          assert.equal(response.headers.get("Cache-Control"), "no-store");
          assert.equal(response.headers.get("Referrer-Policy"), "no-referrer");
          assert.match(await response.text(), /requires an internet connection/);
        } else assert.equal(await response.text(), "network bytes");
      }
      assert.deepEqual(worker.calls.cache, []);
      const count = worker.calls.fetch.length;
      assert.equal(await worker.request("/credential-access", { method: "POST" }), undefined);
      assert.equal(await worker.request("https://other.test/credential-access", { mode: "cors" }), undefined);
      assert.equal(await worker.request("/credential-access-other", { mode: "cors" }), undefined);
      assert.equal(worker.calls.fetch.length, count);
    }
  }
});

test("normal app offline navigation still receives its cached shell", async () => {
  const source = await read(resolve(sourceRoot, "public/sw.js"));
  const worker = loadWorker(source, { pathname: "/app/sw.js", scope: "/app/", offline: true });
  const response = await worker.request("/app/");
  assert.equal(await response.text(), "cached app shell");
  assert.equal(worker.calls.fetch[0].options.cache, "no-cache");
  assert.deepEqual(worker.calls.cache, ["./index.html"]);
});
