import { compressImage } from "./documentScanner";
import { MAX_TICKET_IMAGE_BYTES, TICKET_MIME_BY_EXT, dataUrlBytes } from "./ticketAttachments";

/**
 * One file on a ticket or a ticket reply.
 *
 * It used to take images only, which is how a physician reporting that a CME
 * certificate would not read ended up unable to attach the certificate: the
 * picker grayed out every PDF on his phone. A ticket is where someone shows
 * you the thing that is wrong, so the thing that is wrong has to fit.
 *
 * Hands back a data URL the edge functions will accept, or rejects with a
 * sentence the form can show as-is. Images are squeezed under the scanner's
 * size cap first, because a modern phone photo is 4 MB of screenshot nobody
 * needs at full size. Everything else goes as it is and is simply measured.
 */

/** The MIME type to trust for a file, falling back to its extension. */
function mimeOf(file) {
  const given = String(file?.type || "").toLowerCase();
  if (given) return given;
  const ext = (String(file?.name || "").match(/\.([a-z0-9]{1,5})$/i) || [])[1];
  return TICKET_MIME_BY_EXT[String(ext || "").toLowerCase()] || "";
}

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (ev) => resolve(ev.target.result);
    reader.onerror = () => reject(new Error(`Could not read "${file?.name || "that file"}".`));
    reader.readAsDataURL(file);
  });
}

export async function readTicketAttachment(file) {
  const mime = mimeOf(file);
  if (!mime || !Object.values(TICKET_MIME_BY_EXT).includes(mime)) {
    throw new Error("Attach an image, a PDF, or a document (Word, Excel, CSV, or text).");
  }

  const dataUrl = await readAsDataUrl(file);

  // A HEIC from an iPhone is an image no browser canvas will draw, so it is
  // carried through untouched rather than failing in the compressor.
  const drawable = mime.startsWith("image/") && !/heic|heif/.test(mime);
  if (drawable) {
    try {
      return await compressImage(dataUrl);
    } catch {
      // A picture we cannot redraw is still a picture. Send the original if it
      // fits rather than refusing a screenshot for a canvas failure.
      if (dataUrlBytes(dataUrl) <= MAX_TICKET_IMAGE_BYTES) return dataUrl;
      throw new Error(`Could not read "${file?.name || "that image"}".`);
    }
  }

  if (dataUrlBytes(dataUrl) > MAX_TICKET_IMAGE_BYTES) {
    throw new Error(`"${file?.name || "That file"}" is larger than 5 MB and was not attached.`);
  }
  return dataUrl;
}

/** The old name, kept so nothing that only ever sends images has to change. */
export const readImageAttachment = readTicketAttachment;
