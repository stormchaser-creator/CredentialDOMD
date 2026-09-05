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

// Every whitelisted type maps to its extension, and only those four are whitelisted.
for (const [mime, ext] of Object.entries(MIME_EXT)) {
  eq(`${mime} -> .${ext}`, parseAttachment({ data: dataUrl(mime, png) }).ext, ext);
}
eq("exactly four image types are accepted", Object.keys(MIME_EXT).length, 4);
eq("charset parameter is tolerated", parseAttachment({ data: `data:image/jpeg;charset=utf-8;base64,${b64(png)}` }).ext, "jpg");

// Anything else is refused with the sentence the form shows the person who attached it.
eq("pdf refused", parseAttachment({ data: dataUrl("application/pdf", png) }), { error: ATTACHMENT_TYPE_ERROR });
eq("svg refused (scriptable)", parseAttachment({ data: dataUrl("image/svg+xml", png) }), { error: ATTACHMENT_TYPE_ERROR });
eq("heic refused", parseAttachment({ data: dataUrl("image/heic", png) }), { error: ATTACHMENT_TYPE_ERROR });
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

// One bad image refuses the set. A physician who attached four and saw three
// arrive would have no way to know which one went missing.
eq("one image of the wrong type refuses the whole set",
  parseAttachments({ attachments: [shot(1), { data: "data:application/pdf;base64,AAAA" }] }).error,
  ATTACHMENT_TYPE_ERROR);
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
