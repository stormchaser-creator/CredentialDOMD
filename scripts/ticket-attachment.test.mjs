// Checks for supabase/functions/_shared/ticketAttachment.ts: the single
// validation path a screenshot takes through create-ticket and reply-ticket,
// so a ticket and a reply accept and refuse exactly the same images. Node
// 22.18+ strips the type annotations on import; no build step, no runner.
// Run: node scripts/ticket-attachment.test.mjs

const {
  parseAttachment, MAX_ATTACHMENT_BYTES, MIME_EXT,
  ATTACHMENT_TYPE_ERROR, ATTACHMENT_SIZE_ERROR,
  ticketScreenshotPath, replyScreenshotPath,
  parseAttachments, ticketScreenshotPathAt, replyScreenshotPathAt, attachmentPathsOf,
  MAX_ATTACHMENTS, ATTACHMENT_COUNT_ERROR, ATTACHMENT_TOTAL_ERROR, MAX_TOTAL_ATTACHMENT_BYTES,
  isTicketAttachmentPath, stripServerOnlyPayloadKeys, SERVER_ONLY_PAYLOAD_KEYS, ATTACHMENT_EXTS,
} = await import("../supabase/functions/_shared/ticketAttachment.ts");

let pass = 0, fail = 0;
const ok = (name, cond) => {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}`); }
};
const eq = (name, got, want) => {
  const same = JSON.stringify(got) === JSON.stringify(want);
  ok(same ? name : `${name}  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`, same);
};

const b64 = (bytes) => Buffer.from(bytes).toString("base64");
const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const dataUrl = (mime, bytes) => `data:${mime};base64,${b64(bytes)}`;

// No attachment field, or an empty one, means "no screenshot", never "bad request":
// every client that predates attachments sends nothing and must keep working.
eq("undefined input is no attachment", parseAttachment(undefined), null);
eq("null input is no attachment", parseAttachment(null), null);
eq("object without data is no attachment", parseAttachment({}), null);
eq("empty data string is no attachment", parseAttachment({ data: "" }), null);
eq("non-object input is no attachment", parseAttachment("data:image/png;base64,AAAA"), null);

// A well-formed image decodes to the exact bytes, its mime, and the extension to store under.
const good = parseAttachment({ data: dataUrl("image/png", png) });
ok("png accepted", good && !("error" in good));
eq("png mime", good.mime, "image/png");
eq("png ext", good.ext, "png");
eq("png bytes round-trip", Array.from(good.bytes), Array.from(png));
ok("bytes come back as a Uint8Array (what storage.upload takes)", good.bytes instanceof Uint8Array);

// Every whitelisted type maps to its extension.
for (const [mime, ext] of Object.entries(MIME_EXT)) {
  eq(`${mime} -> .${ext}`, parseAttachment({ data: dataUrl(mime, png) }).ext, ext);
}
eq("charset parameter is tolerated", parseAttachment({ data: `data:image/jpeg;charset=utf-8;base64,${b64(png)}` }).ext, "jpg");

// A PDF is the file a physician actually had in his hand when he was reporting
// a problem with a PDF, and the picker used to gray it out.
eq("pdf accepted", parseAttachment({ data: dataUrl("application/pdf", png) }).ext, "pdf");
eq("word accepted", parseAttachment({ data: dataUrl("application/msword", png) }).ext, "doc");
eq("excel accepted",
  parseAttachment({ data: dataUrl("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", png) }).ext, "xlsx");
eq("csv accepted", parseAttachment({ data: dataUrl("text/csv", png) }).ext, "csv");
eq("an iPhone heic accepted", parseAttachment({ data: dataUrl("image/heic", png) }).ext, "heic");

// Two are still refused, and not for tidiness: a browser executes both, and
// these come back to the reader under a signed link on a storage domain.
eq("svg refused (scriptable)", parseAttachment({ data: dataUrl("image/svg+xml", png) }), { error: ATTACHMENT_TYPE_ERROR });
eq("html refused (scriptable)", parseAttachment({ data: dataUrl("text/html", png) }), { error: ATTACHMENT_TYPE_ERROR });
eq("an executable refused", parseAttachment({ data: dataUrl("application/x-msdownload", png) }), { error: ATTACHMENT_TYPE_ERROR });

// Anything else is refused with the sentence the form shows the person who attached it.
eq("plain string refused", parseAttachment({ data: "hello" }), { error: ATTACHMENT_TYPE_ERROR });
eq("non-base64 data url refused", parseAttachment({ data: "data:image/png,rawbytes" }), { error: ATTACHMENT_TYPE_ERROR });
eq("data url with no payload refused", parseAttachment({ data: "data:image/png;base64," }), { error: ATTACHMENT_TYPE_ERROR });
eq("mime case is not normalized (IMAGE/PNG refused)", parseAttachment({ data: dataUrl("IMAGE/PNG", png) }), { error: ATTACHMENT_TYPE_ERROR });
eq("number for data is refused, not crashed on", parseAttachment({ data: 42 }), { error: ATTACHMENT_TYPE_ERROR });

// Size: exactly 5 MB passes, one byte over fails.
const atLimit = new Uint8Array(MAX_ATTACHMENT_BYTES); atLimit.set(png);
const limitResult = parseAttachment({ data: dataUrl("image/png", atLimit) });
ok("exactly 5 MB accepted", limitResult && !("error" in limitResult));
eq("exactly 5 MB keeps every byte", limitResult.bytes.byteLength, MAX_ATTACHMENT_BYTES);
const overLimit = new Uint8Array(MAX_ATTACHMENT_BYTES + 1); overLimit.set(png);
eq("5 MB + 1 byte refused", parseAttachment({ data: dataUrl("image/png", overLimit) }), { error: ATTACHMENT_SIZE_ERROR });

// A grossly oversize payload is refused from its base64 length alone: no decode
// of a multi-megabyte blob that was never going to be stored.
const realAtob = globalThis.atob;
let atobCalls = 0;
globalThis.atob = (s) => { atobCalls++; return realAtob(s); };
eq("20 MB payload refused as too large", parseAttachment({ data: `data:image/png;base64,${"A".repeat(4 * MAX_ATTACHMENT_BYTES)}` }), { error: ATTACHMENT_SIZE_ERROR });
eq("...without decoding it", atobCalls, 0);
parseAttachment({ data: dataUrl("image/png", png) });
eq("a normal image still decodes through atob", atobCalls, 1);
globalThis.atob = realAtob;

// Storage layout: the ticket's own screenshot and each reply's live under the
// ticket folder, so the reader (ticket-attachment-url) can sign either.
eq("ticket screenshot path", ticketScreenshotPath("t1", "png"), "tickets/t1/screenshot.png");
eq("reply screenshot path", replyScreenshotPath("t1", "m1", "jpg"), "tickets/t1/replies/m1.jpg");


// ── Several images on one ticket or reply ─────────────────────────────────
// A physician asked for this: one picture rarely shows a bug.
// Base64 only decodes in blocks of four, so the length is rounded to one:
// an odd length throws inside atob and every case comes back as a type error.
const shot = (kb) => ({
  data: "data:image/png;base64," + "A".repeat(Math.ceil((kb * 1024 * 4 / 3) / 4) * 4),
});

eq("no attachment field is an empty set, not an error", parseAttachments({}), []);
eq("the singular field still works", parseAttachments({ attachment: shot(1) }).length, 1);
eq("and so does the plural", parseAttachments({ attachments: [shot(1), shot(1), shot(1)] }).length, 3);
eq("the plural wins when both are sent",
  parseAttachments({ attachment: shot(1), attachments: [shot(1), shot(1)] }).length, 2);
eq("an empty array is an empty set", parseAttachments({ attachments: [] }), []);

eq(`more than ${MAX_ATTACHMENTS} is refused as a whole`,
  parseAttachments({ attachments: Array.from({ length: MAX_ATTACHMENTS + 1 }, () => shot(1)) }).error,
  ATTACHMENT_COUNT_ERROR);
eq(`exactly ${MAX_ATTACHMENTS} is allowed`,
  parseAttachments({ attachments: Array.from({ length: MAX_ATTACHMENTS }, () => shot(1)) }).length,
  MAX_ATTACHMENTS);

// One bad file refuses the set. A physician who attached four and saw three
// arrive would have no way to know which one went missing.
eq("one file of the wrong type refuses the whole set",
  parseAttachments({ attachments: [shot(1), { data: "data:image/svg+xml;base64,AAAA" }] }).error,
  ATTACHMENT_TYPE_ERROR);
eq("a PDF alongside a screenshot is a valid set now",
  parseAttachments({ attachments: [shot(1), { data: "data:application/pdf;base64,AAAA" }] }).map((a) => a.ext),
  ["png", "pdf"]);
eq("one oversized image refuses the whole set",
  parseAttachments({ attachments: [shot(1), shot(6 * 1024)] }).error,
  ATTACHMENT_SIZE_ERROR);
ok("and a set too heavy together is refused as well",
  parseAttachments({ attachments: [shot(4500), shot(4500), shot(4500)] }).error === ATTACHMENT_TOTAL_ERROR);
ok("the total cap is under what five maximum images would weigh",
  MAX_TOTAL_ATTACHMENT_BYTES < MAX_ATTACHMENT_BYTES * MAX_ATTACHMENTS);

// ── Keys: the first one never moves ───────────────────────────────────────
eq("the first ticket key is the one that already exists",
  ticketScreenshotPathAt("t1", "png", 0), ticketScreenshotPath("t1", "png"));
eq("the second is indexed from 2", ticketScreenshotPathAt("t1", "png", 1), "tickets/t1/screenshot-2.png");
eq("and the fifth", ticketScreenshotPathAt("t1", "jpg", 4), "tickets/t1/screenshot-5.jpg");
eq("the first reply key is unchanged too",
  replyScreenshotPathAt("t1", "m1", "png", 0), replyScreenshotPath("t1", "m1", "png"));
eq("and the second is indexed", replyScreenshotPathAt("t1", "m1", "png", 1), "tickets/t1/replies/m1-2.png");
ok("every key stays inside the ticket's own folder",
  [ticketScreenshotPathAt("t1", "png", 3), replyScreenshotPathAt("t1", "m1", "png", 3)]
    .every((k) => k.startsWith("tickets/t1/") && !k.includes("..")));

// ── Reading rows written before and after the array ───────────────────────
eq("an old row with one path", attachmentPathsOf({ attachment_path: "a.png" }), ["a.png"]);
eq("a new row with several", attachmentPathsOf({ attachment_paths: ["a.png", "b.png"] }), ["a.png", "b.png"]);
eq("a row with both does not list the first twice",
  attachmentPathsOf({ attachment_path: "a.png", attachment_paths: ["a.png", "b.png"] }), ["a.png", "b.png"]);
eq("a row with neither", attachmentPathsOf({}), []);
eq("null does not throw", attachmentPathsOf(null), []);
eq("a null inside the array is dropped",
  attachmentPathsOf({ attachment_paths: ["a.png", null, ""] }), ["a.png"]);

// ── Signing a path: it has to be THIS ticket's ────────────────────────────
// ticket-attachment-url owns the ticket check and used to stop there: it
// signed whatever key the row carried, with the service-role client, into
// the private "documents" bucket that also holds every physician's own
// uploads at "<clerk sub>/<uuid>". The path column has a second writer,
// because RLS lets any signed-in caller insert a ticket row and update their
// own straight through PostgREST, and Clerk sign-up is open. So a caller
// could point their own ticket at another account's document and be handed a
// signed link to it. These are the cases that have to fail.
const T = "9f3c1b2a-77aa-4f5e-9d31-0c4b6e5a1234";   // a ticket the caller owns
const OTHER = "1a2b3c4d-5566-4777-8899-aabbccddeeff"; // somebody else's ticket
const M = "5e4d3c2b-1a09-4876-b543-210fedcba987";     // a reply on T
const M2 = "77778888-9999-4aaa-8bbb-ccccddddeeee";    // a different reply on T
const yes = (name, path, tid, mid) => ok(name, isTicketAttachmentPath(path, tid, mid) === true);
const no  = (name, path, tid, mid) => ok(name, isTicketAttachmentPath(path, tid, mid) === false);

// The four shapes this system writes, checked through the writers themselves
// so the validator cannot drift from the keys actually in the bucket.
yes("the ticket's first screenshot", ticketScreenshotPathAt(T, "png", 0), T);
yes("the ticket's second", ticketScreenshotPathAt(T, "jpg", 1), T);
yes("the ticket's fifth", ticketScreenshotPathAt(T, "pdf", 4), T);
yes("a reply's first", replyScreenshotPathAt(T, M, "png", 0), T, M);
yes("a reply's second", replyScreenshotPathAt(T, M, "heic", 1), T, M);
yes("the legacy single-screenshot key", ticketScreenshotPath(T, "png"), T);
yes("the legacy single-reply key", replyScreenshotPath(T, M, "jpg"), T, M);

// The same four keys, offered up on somebody else's ticket. This is the
// attack: own a ticket, name a file that is not yours.
no("first screenshot, wrong ticket", ticketScreenshotPathAt(T, "png", 0), OTHER);
no("second screenshot, wrong ticket", ticketScreenshotPathAt(T, "jpg", 1), OTHER);
no("fifth screenshot, wrong ticket", ticketScreenshotPathAt(T, "pdf", 4), OTHER);
no("reply's first, wrong ticket", replyScreenshotPathAt(T, M, "png", 0), OTHER, M);
no("reply's second, wrong ticket", replyScreenshotPathAt(T, M, "heic", 1), OTHER, M);

// A reply key has to name the row it came off, not a sibling on the thread.
no("a reply key signed for the wrong message", replyScreenshotPathAt(T, M, "png", 0), T, M2);
no("...including its indexed sibling", replyScreenshotPathAt(T, M, "png", 1), T, M2);
no("a reply key with no message id given", replyScreenshotPathAt(T, M, "png", 0), T);
no("a ticket key offered for a message row", ticketScreenshotPathAt(T, "png", 0), T, M);
no("an empty message id is not 'no message id'", replyScreenshotPathAt(T, M, "png", 0), T, "");

// Path tricks. WHATWG URL parsing collapses dot segments, so a key that reads
// as one thing resolves as another once the service role fetches it; this is
// the same failure _shared/storagePath.ts was written for.
no("traversal out of the ticket folder", `tickets/${T}/../${OTHER}/screenshot.png`, T);
no("traversal inside the replies folder", `tickets/${T}/replies/../../${OTHER}/screenshot.png`, T, M);
no("a double slash", `tickets/${T}//screenshot.png`, T);
no("a leading slash", `/tickets/${T}/screenshot.png`, T);
no("an absolute url", `https://example.com/tickets/${T}/screenshot.png`, T);
no("a storage api url", `https://x.supabase.co/storage/v1/object/documents/tickets/${T}/screenshot.png`, T);
no("a percent-encoded dot segment", `tickets/${T}/%2e%2e/${OTHER}/screenshot.png`, T);
no("backslashes instead of slashes", `tickets\\${T}\\screenshot.png`, T);
no("a trailing newline", `tickets/${T}/screenshot.png\n`, T);
no("a leading space", ` tickets/${T}/screenshot.png`, T);
no("a ticket id that is itself a traversal", `tickets/../${OTHER}/screenshot.png`, "..");

// A physician's own document lives at "<clerk sub>/<uuid>" in this same
// bucket. That is the file the hole was reaching.
no("a bare document key", "user_2abcDEF123/44444444-4444-4444-8444-444444444444.pdf", T);
no("a document key under the ticket folder name", `tickets/user_2abcDEF123/44444444-4444-4444-8444-444444444444.pdf`, T);
no("another account's whole prefix", "user_2abcDEF123/", T);

// Nothing and nonsense.
no("an empty string", "", T);
no("null", null, T);
no("undefined", undefined, T);
no("a number", 42, T);
no("an object", { path: `tickets/${T}/screenshot.png` }, T);
no("a good path with no ticket id", ticketScreenshotPathAt(T, "png", 0), null);
no("a good path with an empty ticket id", ticketScreenshotPathAt(T, "png", 0), "");

// The leaf itself: only what the writer produces.
no("a ticket id that is only a prefix of the real one", `tickets/${T}9/screenshot.png`, T);
no("a stem that only starts with screenshot", `tickets/${T}/screenshotx.png`, T);
no("an extension the uploader refuses", `tickets/${T}/screenshot.svg`, T);
no("an html extension", `tickets/${T}/screenshot.html`, T);
no("no extension at all", `tickets/${T}/screenshot`, T);
no("an uppercase extension", `tickets/${T}/screenshot.PNG`, T);
no("a double extension", `tickets/${T}/screenshot.png.svg`, T);
no("index 0", `tickets/${T}/screenshot-0.png`, T);
no("index 1, which the writer never emits", `tickets/${T}/screenshot-1.png`, T);
no("a zero-padded index", `tickets/${T}/screenshot-02.png`, T);
no("a three-digit index", `tickets/${T}/screenshot-100.png`, T);
no("a folder below the ticket", `tickets/${T}/deep/screenshot.png`, T);
no("a folder below replies", `tickets/${T}/replies/deep/${M}.png`, T, M);
no("a reply key missing the replies folder", `tickets/${T}/${M}.png`, T, M);
no("the wrong top-level folder", `documents/${T}/screenshot.png`, T);

// Every type the uploader accepts produces a key this validator accepts:
// MIME_EXT is the one list, so the writer and the reader cannot drift.
for (const ext of ATTACHMENT_EXTS) {
  yes(`.${ext} is signable on a ticket`, ticketScreenshotPathAt(T, ext, 0), T);
  yes(`.${ext} is signable on a reply`, replyScreenshotPathAt(T, M, ext, 1), T, M);
}
ok("the signable extensions are exactly MIME_EXT's values",
  [...ATTACHMENT_EXTS].sort().join(",") === [...new Set(Object.values(MIME_EXT))].sort().join(","));

// ── create-ticket no longer copies caller-supplied attachment keys ─────────
// The insert used to be `{ ...(body.context_payload || {}) }`, which let the
// caller name the file the reader would later sign. The server sets both
// keys itself once it has uploaded an object.
const sent = {
  attachment_path: "user_2abcDEF123/44444444-4444-4444-8444-444444444444.pdf",
  attachment_paths: [`tickets/${OTHER}/screenshot.png`],
  page: "/app/licenses",
  browser: "Safari 18",
  nested: { a: 1 },
};
const kept = stripServerOnlyPayloadKeys(sent);
ok("attachment_path is stripped", !("attachment_path" in kept));
ok("attachment_paths is stripped", !("attachment_paths" in kept));
eq("both keys are the whole strip list", SERVER_ONLY_PAYLOAD_KEYS.slice().sort(), ["attachment_path", "attachment_paths"]);
eq("the rest of the context survives", kept, { page: "/app/licenses", browser: "Safari 18", nested: { a: 1 } });
ok("a nested object is kept by reference, not flattened", kept.nested === sent.nested);
ok("the caller's object is not mutated", sent.attachment_path !== undefined && sent.attachment_paths.length === 1);
eq("no context payload is an empty object", stripServerOnlyPayloadKeys(undefined), {});
eq("null is an empty object", stripServerOnlyPayloadKeys(null), {});
eq("a string does not spread into indexed keys", stripServerOnlyPayloadKeys("tickets/x"), {});
eq("an array is an empty object", stripServerOnlyPayloadKeys(["a", "b"]), {});
eq("a number is an empty object", stripServerOnlyPayloadKeys(7), {});
eq("a payload of only those two keys comes back empty",
  stripServerOnlyPayloadKeys({ attachment_path: "x", attachment_paths: ["y"] }), {});
ok("what create-ticket then writes is signable",
  isTicketAttachmentPath(ticketScreenshotPathAt(T, "png", 0), T) === true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
