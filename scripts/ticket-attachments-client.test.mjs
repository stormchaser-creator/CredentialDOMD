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
  dataUrlBytes, totalBytes, addImages, attachmentsPayload, linksFor,
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

// ── House rules ───────────────────────────────────────────────────────────
{
  const messages = [
    addImages([], Array.from({ length: 9 }, (_, i) => img(`i${i}`, 10))).error,
    addImages([], [img("huge", 6 * 1024)]).error,
    addImages([], [img("a", 4500), img("b", 4500), img("c", 4500)]).error,
  ];
  ok("no em dash in anything the physician reads", messages.every((m) => !m.includes("—")));
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
