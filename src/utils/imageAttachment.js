import { compressImage } from "./documentScanner";
import { MAX_TICKET_IMAGE_BYTES, dataUrlBytes, resolveTicketMime, withDataUrlMime } from "./ticketAttachments";
import { spreadsheetGuard } from "./spreadsheetGuard";

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

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (ev) => resolve(ev.target.result);
    reader.onerror = () => reject(new Error(`Could not read "${file?.name || "that file"}".`));
    reader.readAsDataURL(file);
  });
}

export async function readTicketAttachment(file) {
  // The browser's type when the server stores it, otherwise the extension's
  // (resolveTicketMime). It used to be the browser's type whenever there was
  // one, so an .rtf that macOS calls text/rtf was refused here although the
  // server stores it, and a Windows .csv went up as an Excel file.
  const mime = resolveTicketMime(file);
  if (!mime) {
    throw new Error("Attach an image, a PDF, or a document (Word, Excel, CSV, or text).");
  }
  // A spreadsheet whose header names a patient identifier never leaves the
  // device, here as on every other upload path.
  const refusal = await spreadsheetGuard(file);
  if (refusal) throw new Error(refusal);

  // FileReader labels the data with the browser's guess (or with nothing);
  // the server stores the file under whatever type the data URL declares.
  const dataUrl = withDataUrlMime(await readAsDataUrl(file), mime);

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
