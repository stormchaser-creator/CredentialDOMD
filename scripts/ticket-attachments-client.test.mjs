// The client half of "let me attach several screenshots": how many fit, how
// big they may be, and what the physician is told when one does not fit.
//
// These numbers must match the server's (MAX_ATTACHMENTS and
// MAX_TOTAL_ATTACHMENT_BYTES in supabase/functions/_shared/ticketAttachment.ts).
// A control that accepts six images and a function that refuses the sixth is
// a failure the physician only discovers after writing the message, so the
// last block here holds the two files to the same numbers.
// Run: node scripts/ticket-attachments-client.test.mjs
import {
  MAX_TICKET_IMAGES, MAX_TICKET_IMAGE_BYTES, MAX_TICKET_TOTAL_BYTES,
  TICKET_ATTACH_ACCEPT, TICKET_MIME_BY_EXT,
  dataUrlBytes, totalBytes, addImages, attachmentsPayload, linksFor,
  attachmentKind, attachmentLabel, mimeOfDataUrl,
} from "../src/utils/ticketAttachments.js";

const server = await import("../supabase/functions/_shared/ticketAttachment.ts");

let pass = 0, fail = 0;
const eq = (n, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) pass++; else { fail++; console.log(`FAIL ${n}\n   got  ${g}\n   want ${w}`); }
};
const ok = (n, cond, extra = "") => { if (cond) pass++; else { fail++; console.log(`FAIL ${n} ${extra}`); } };

const img = (name, kb) => ({
  name,
  data: "data:image/png;base64," + "A".repeat(Math.ceil((kb * 1024 * 4 / 3) / 4) * 4),
});

// ── Sizing ────────────────────────────────────────────────────────────────
ok("a data URL's decoded size is read within a few bytes",
  Math.abs(dataUrlBytes(img("a", 100).data) - 100 * 1024) < 8);
eq("something that is not a data URL weighs nothing", dataUrlBytes("nonsense"), 0);
eq("null weighs nothing", dataUrlBytes(null), 0);
ok("a set is the sum of its images",
  Math.abs(totalBytes([img("a", 100), img("b", 100)]) - 200 * 1024) < 16);
eq("an empty set weighs nothing", totalBytes([]), 0);
eq("a non-array weighs nothing", totalBytes(null), 0);

// ── Adding ────────────────────────────────────────────────────────────────
{
  const one = addImages([], [img("a", 100)]);
  eq("one image is kept", one.images.length, 1);
  eq("and nothing is said about it", one.error, "");

  const added = addImages([img("a", 10)], [img("b", 10)]);
  eq("a second is added rather than replacing the first", added.images.map((i) => i.name), ["a", "b"]);
}
{
  const many = addImages([], Array.from({ length: MAX_TICKET_IMAGES + 2 }, (_, i) => img(`i${i}`, 10)));
  eq(`only ${MAX_TICKET_IMAGES} are kept`, many.images.length, MAX_TICKET_IMAGES);
  ok("and the physician is told the rest did not go", /not attached/.test(many.error), many.error);
}
{
  const big = addImages([], [img("huge", 6 * 1024)]);
  eq("an image over 5 MB is not attached", big.images.length, 0);
  ok("and it is named, so they know which one", /huge/.test(big.error), big.error);

  const mixed = addImages([], [img("fine", 100), img("huge", 6 * 1024), img("alsofine", 100)]);
  eq("the ones that fit still go", mixed.images.map((i) => i.name), ["fine", "alsofine"]);
}
{
  const heavy = addImages([], [img("a", 4500), img("b", 4500), img("c", 4500)]);
  ok("a set too heavy together stops before the last one", heavy.images.length < 3);
  ok("and says to send the rest separately", /second message/.test(heavy.error), heavy.error);
}
eq("nothing to add changes nothing", addImages([img("a", 1)], []).images.length, 1);
eq("an image with no data is skipped rather than stored",
  addImages([], [{ name: "empty" }]).images.length, 0);

// ── The wire ──────────────────────────────────────────────────────────────
{
  const payload = attachmentsPayload([img("a", 1), img("b", 1)]);
  eq("both fields are sent", Object.keys(payload).sort(), ["attachment", "attachments"]);
  eq("the plural carries every image", payload.attachments.length, 2);
  eq("and the singular carries the first, for a function not yet redeployed",
    payload.attachment.data, payload.attachments[0].data);
  eq("nothing attached sends no fields", attachmentsPayload([]), {});
  eq("null sends no fields", attachmentsPayload(null), {});
}

// ── Reading links back ────────────────────────────────────────────────────
eq("an array of links", linksFor(["a", "b"]), ["a", "b"]);
eq("a single link, which is what the API used to return", linksFor("a"), ["a"]);
eq("no link", linksFor(null), []);
eq("a blank is dropped", linksFor(["a", "", null]), ["a"]);

// ── The client and the server agree ───────────────────────────────────────
eq("the same maximum count", MAX_TICKET_IMAGES, server.MAX_ATTACHMENTS);
eq("the same per-image cap", MAX_TICKET_IMAGE_BYTES, server.MAX_ATTACHMENT_BYTES);
eq("the same total cap", MAX_TICKET_TOTAL_BYTES, server.MAX_TOTAL_ATTACHMENT_BYTES);

// ── What the picker offers, and what the server will store ────────────────
// The bug: the picker said image/* and a physician reporting a problem with a
// PDF found every PDF on his phone grayed out. The one file that showed what
// was wrong was the one file he could not send.
{
  ok("the picker offers PDFs", /application\/pdf/.test(TICKET_ATTACH_ACCEPT));
  ok("and the extension too, because iOS grays out what it cannot match by MIME",
    TICKET_ATTACH_ACCEPT.split(",").includes(".pdf"));
  ok("images still go", /image\/\*/.test(TICKET_ATTACH_ACCEPT));

  // Every MIME the client offers is one the server stores, and the other way
  // round. A picker that accepts a type the function refuses is a failure the
  // physician meets after writing the message.
  const serverMimes = new Set(Object.keys(server.MIME_EXT));
  const clientMimes = new Set(Object.values(TICKET_MIME_BY_EXT));
  const unstorable = [...clientMimes].filter((m) => !serverMimes.has(m));
  eq("nothing offered that the server would refuse", unstorable, []);
  const unofferable = [...serverMimes].filter((m) => !clientMimes.has(m) && m !== "text/rtf");
  eq("nothing stored that the picker never offers", unofferable, []);

  ok("neither side takes SVG or HTML, which a browser executes",
    !serverMimes.has("image/svg+xml") && !serverMimes.has("text/html")
    && !/svg|text\/html/.test(TICKET_ATTACH_ACCEPT));
}

// ── Telling a picture from a file ─────────────────────────────────────────
// The reader of a thread has the signed link and nothing else: the filename
// stayed on the sender's phone. Putting a PDF in an <img> drew a broken icon.
{
  const signed = (name) => `https://x.supabase.co/storage/v1/object/sign/documents/tickets/t1/${name}?token=ey.j`;
  eq("a signed png is a picture", attachmentKind(signed("screenshot.png")), "image");
  eq("a signed pdf is not", attachmentKind(signed("screenshot.pdf")), "pdf");
  eq("a signed xlsx is a file", attachmentKind(signed("screenshot-2.xlsx")), "file");
  eq("an uppercase extension still reads", attachmentKind("SHOT.JPG"), "image");
  eq("a heic is a file, because no browser draws one", attachmentKind("IMG_0041.HEIC"), "file");
  eq("the MIME wins when there is one", attachmentKind("whatever", "image/webp"), "image");
  eq("a pdf MIME wins too", attachmentKind("whatever", "application/pdf"), "pdf");
  eq("nothing at all is treated as a file, never drawn", attachmentKind("", ""), "file");

  eq("a data URL says its type", mimeOfDataUrl("data:application/pdf;base64,AAAA"), "application/pdf");
  eq("and rubbish says nothing", mimeOfDataUrl("hello"), "");

  eq("a link names itself for the reader", attachmentLabel(signed("screenshot.pdf"), 0), "PDF attachment 1");
  eq("and counts from one", attachmentLabel(signed("screenshot-2.pdf"), 1), "PDF attachment 2");
  eq("an unknown extension still gets a name", attachmentLabel("https://x/a/file.bin", 0), "BIN attachment 1");
  eq("and no extension at all", attachmentLabel("https://x/a/file", 0), "Attachment 1");
}

// ── House rules ───────────────────────────────────────────────────────────
{
  const messages = [
    addImages([], Array.from({ length: 9 }, (_, i) => img(`i${i}`, 10))).error,
    addImages([], [img("huge", 6 * 1024)]).error,
    addImages([], [img("a", 4500), img("b", 4500), img("c", 4500)]).error,
  ];
  ok("no em dash in anything the physician reads", messages.every((m) => !m.includes("\u2014")));
  ok("and nothing a physician reads still says screenshots only",
    messages.every((m) => !/screenshot/i.test(m)), messages.join(" | "));
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
