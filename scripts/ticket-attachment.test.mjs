// Checks for supabase/functions/_shared/ticketAttachment.ts: the single
// validation path a screenshot takes through create-ticket and reply-ticket,
// so a ticket and a reply accept and refuse exactly the same images. Node
// 22.18+ strips the type annotations on import; no build step, no runner.
// Run: node scripts/ticket-attachment.test.mjs

const {
  parseAttachment, MAX_ATTACHMENT_BYTES, MIME_EXT,
  ATTACHMENT_TYPE_ERROR, ATTACHMENT_SIZE_ERROR,
  ticketScreenshotPath, replyScreenshotPath,
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
