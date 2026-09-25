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
  TICKET_ATTACH_ACCEPT, TICKET_MIME_BY_EXT, TICKET_MIMES,
  dataUrlBytes, totalBytes, addImages, attachmentsPayload, linksFor,
  attachmentKind, attachmentLabel, mimeOfDataUrl,
  resolveTicketMime, withDataUrlMime, ticketAttachmentShortfall,
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
  const clientMimes = TICKET_MIMES;
  const unstorable = [...clientMimes].filter((m) => !serverMimes.has(m));
  eq("nothing offered that the server would refuse", unstorable, []);
  // No exemptions: text/rtf used to be waved through here, and that is the
  // gap that refused a Mac .rtf on the phone while the server would store it.
  const unofferable = [...serverMimes].filter((m) => !clientMimes.has(m));
  eq("nothing stored that the picker never offers", unofferable, []);
  ok("every extension the client maps is one the server stores",
    Object.values(TICKET_MIME_BY_EXT).every((m) => serverMimes.has(m)));

  ok("neither side takes SVG or HTML, which a browser executes",
    !serverMimes.has("image/svg+xml") && !serverMimes.has("text/html")
    && !/svg|text\/html/.test(TICKET_ATTACH_ACCEPT));
}

// ── Which type a picked file is sent as ───────────────────────────────────
// The browser's word is taken only when the server stores that type. A Mac
// reports an .rtf as text/rtf (refused here while the server accepted it),
// and Windows with Excel installed reports a .csv as application/vnd.ms-excel
// (stored as .xls). The extension is the better witness in both cases.
{
  const f = (name, type) => ({ name, type });
  eq("an .rtf the Mac calls text/rtf is accepted as text/rtf", resolveTicketMime(f("notes.rtf", "text/rtf")), "text/rtf");
  eq("and the server stores that type", server.MIME_EXT["text/rtf"], "rtf");
  eq("an .rtf with an unfamiliar rtf type falls back to the extension", resolveTicketMime(f("notes.rtf", "application/x-rtf")), "application/rtf");
  eq("a .csv that Windows calls an Excel file is sent as CSV", resolveTicketMime(f("hours.csv", "application/vnd.ms-excel")), "text/csv");
  eq("and stored as .csv, not .xls", server.MIME_EXT[resolveTicketMime(f("hours.csv", "application/vnd.ms-excel"))], "csv");
  eq("a .csv called application/csv is sent as CSV", resolveTicketMime(f("hours.csv", "application/csv")), "text/csv");
  eq("a .csv called text/x-csv is sent as CSV", resolveTicketMime(f("HOURS.CSV", "text/x-csv")), "text/csv");
  eq("a real Excel file keeps its type", resolveTicketMime(f("hours.xls", "application/vnd.ms-excel")), "application/vnd.ms-excel");
  eq("a file with no type is read by its extension", resolveTicketMime(f("note.txt", "")), "text/plain");
  eq("octet-stream is read by its extension", resolveTicketMime(f("letter.docx", "application/octet-stream")),
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  eq("a known type is taken as given", resolveTicketMime(f("scan", "application/pdf")), "application/pdf");
  eq("an unknown type with no known extension is refused", resolveTicketMime(f("clip.mov", "video/quicktime")), "");
  eq("no type and no extension is refused", resolveTicketMime(f("README", "")), "");
  eq("an SVG is refused even when its name says png", resolveTicketMime(f("shot.png", "image/svg+xml")), "");
  eq("HTML is refused even when its name says csv", resolveTicketMime(f("table.csv", "text/html")), "");
  eq("an SVG by name alone is refused", resolveTicketMime(f("logo.svg", "")), "");

  eq("the data URL is relabelled with the resolved type",
    withDataUrlMime("data:application/vnd.ms-excel;base64,QUJD", "text/csv"), "data:text/csv;base64,QUJD");
  eq("a data URL the browser left untyped gets the type",
    withDataUrlMime("data:application/octet-stream;base64,QUJD", "text/plain"), "data:text/plain;base64,QUJD");
  eq("a charset parameter is dropped, as the server's parser expects",
    withDataUrlMime("data:text/plain;charset=utf-8;base64,QUJD", "text/plain"), "data:text/plain;base64,QUJD");
  eq("Safari's empty type is filled", withDataUrlMime("data:;base64,QUJD", "application/rtf"), "data:application/rtf;base64,QUJD");
  eq("nothing to relabel is left alone", withDataUrlMime("not a data url", "text/plain"), "not a data url");
  {
    const relabelled = withDataUrlMime("data:application/csv;base64,QUJD", resolveTicketMime(f("a.csv", "application/csv")));
    const parsed = server.parseAttachment({ data: relabelled });
    eq("the server stores the relabelled CSV under .csv", parsed.ext, "csv");
    eq("with its bytes intact", new TextDecoder().decode(parsed.bytes), "ABC");
  }
}

// ── A ticket saved without all of its files ───────────────────────────────
{
  eq("one lost file is named in the singular", ticketAttachmentShortfall({ ok: true, attachments_failed: 1 }),
    "Your ticket was sent, but 1 file did not attach. Add it as a reply.");
  eq("two are counted", ticketAttachmentShortfall({ ok: true, attachments_failed: 2 }),
    "Your ticket was sent, but 2 files did not attach. Add them as a reply.");
  eq("nothing lost says nothing", ticketAttachmentShortfall({ ok: true, attachments_failed: 0 }), "");
  eq("a function that does not report it claims nothing", ticketAttachmentShortfall({ ok: true, id: "x" }), "");
  eq("no response claims nothing", ticketAttachmentShortfall(null), "");
  ok("no em dash in the shortfall", !ticketAttachmentShortfall({ attachments_failed: 3 }).includes("\u{2014}"));
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
