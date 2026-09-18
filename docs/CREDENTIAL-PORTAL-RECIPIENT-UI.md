# Recipient document access UI

Updated 2026-09-18. Implemented for review; frontend and backend activation remain **off**. This work sent no production email and made no live recipient, database or storage request.

## Experience

The recipient opens an invitation, enters the exact invited email, requests a code and explicitly verifies it. A forwarded link alone is insufficient. The page displays only the returned document selection, with separate Preview and Download actions. Unsupported or changed files have a clear explanation and recovery path. Code delivery uses neutral wording; the UI never claims that a generic code-request response proves email delivery.

Invitation fragments are captured and removed before stylesheet/module loading, including a new invitation opened in the same tab. Tokens, codes and sessions are kept only in page memory. Reload, page navigation, expiry or End access clears the session and preview. A consumed invitation cannot recover a lost verification response; that case asks for a new invitation. Downloaded copies cannot be recalled, and the page says so.

The page has no analytics, external viewer, support widget, storage signed URLs, persistent browser storage or service-worker registration. Document requests use POST, no-store, no-referrer, omitted cookies, an in-memory bearer header and a redirect refusal. File reads are bounded to 10 MiB. Changing or ending a session prevents late responses from reopening a document.

## Preview implementation

Image/plain-text previews require both a permitted MIME and an inline Content-Disposition; they use a blob URL in an iframe with an empty sandbox. HTML/SVG/other attachment responses never enter a viewer. Object URLs are revoked on close, expiry or exit. Download is an explicit authenticated byte request and never reuses a storage URL.

Chrome blocks native PDF viewing in an empty sandbox. PDF viewing therefore uses the locally shipped **PDF.js 6.3.289 display layer**, a dedicated same-origin worker, and canvas output. Mozilla identified this as its current stable release when checked; the version and lockfile integrity are pinned. The generic viewer and scripting sandbox are not shipped. See [Mozilla’s release](https://github.com/mozilla/pdf.js/releases/tag/v6.3.289) and [display API source at that tag](https://github.com/mozilla/pdf.js/blob/v6.3.289/src/display/api.js).

Static annotation/form appearances may be painted as pixels so saved credential fields are visible. There is no annotation HTML, active link, form editor, JavaScript action handler, embedded-file UI or XFA renderer. WASM and worker resource fetching are disabled. Only an allowlist of package-owned standard fonts can be fetched, from this same site with no cookies, caching or referrer. PDF-controlled CMap, WASM and arbitrary resource locations are refused. The exact display/worker bundles are checked for eval/Function construction; the CSP also forbids unsafe-eval. The old isEvalSupported option is absent from this pinned version’s API, so it is not used as a fictitious protection.

Preview limits are 50 pages, one visible page at a time, 4 million output pixels, 16 million tracked intermediate canvas pixels, 16 million pixels per decoded image, 15 seconds for loading and 10 seconds per page operation. Close cancels rendering, aborts font requests, destroys the loading task and PDF worker, terminates its actual worker port, and zeros canvas backing stores. Malformed, protected, unsupported or over-limit documents keep the original Download option.

**These are best-effort browser resource controls, not a hard heap sandbox.** PDF parsing and multiple decoded images can allocate additional worker memory before a timeout. Canvas output can differ from the original, and is not a full accessible text viewer; the page offers the original download for complete content and the recipient’s preferred reader.

## Build and hosting

- `npm run build:portal` copies only the pinned display/worker bundles, standard fonts and required licenses into generated `public/credential-access/vendor/`, with a SHA-256 asset manifest. That generated directory is ignored by Git.
- `dev`, `build` and `build:site` run this preparation before Vite. The browser never fetches PDF code from a CDN.
- Serve `/credential-access/`, its HTML alias and assets with no-store, no-referrer, nosniff and noindex headers. The HTTP CSP is derived from the HTML meta policy, adding frame-ancestors none; worker-src and local fonts are restricted to self.
- Keep the route out of the sitemap. The root packager and service-worker changes belong to the integration work. A legacy root worker must bypass this route instead of serving an offline app shell. The current `/app/` worker scope does not control the root page.
- PDF.js declares Node >=22.13 or >=24 for its Node API. This project uses its browser bundles and copies their assets without executing that Node API. The asset generator, Vite production build and site packager passed under both Node24.15.0 and an isolated official Node20.20.2 binary, whose SHA-256 was checked against the [Node release page](https://nodejs.org/en/blog/release/v20.20.2). This validates the existing Node20 build path, not PDF.js’s Node API. No workflow or system runtime was changed.

## Evidence and remaining checks

Run `npm run build:portal` then `node --test tests/credential-portal/ui.test.mjs tests/credential-portal/pdf-preview.test.mjs`. All 12 tests/subtests pass. They cover fragment removal, CSP hash, disabled state, metadata limits, MIME/disposition, asset integrity, pixel bounds, page limits, resource refusal, cancellation and late resolution.

Local browser checks used synthetic email/code/documents and an injected fake transport, never real mail or storage: inactive default, URL clearing, wrong-code recovery, download, list refresh, text isolation, expiry, revoked/changed files, interrupted verification, late responses, 390px layout, PDF rendering/paging, inert PDF actions, malformed PDF and over-limit fallback. A canvas PDF rendered successfully under strict production-style headers. The synthetic PDF fixture generator is checked in for further canaries.

Real staging still needs actual gateway/CORS/mail/storage verification, Safari/iOS and accessibility review, password-protected/complex scanned PDFs, and sanitized logging checks. Synthetic tests do not establish live deployment behavior or guarantee arbitrary PDF fidelity. Keep activation off until those integration requirements are satisfied.
