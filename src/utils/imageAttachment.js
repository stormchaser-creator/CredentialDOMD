import { compressImage } from "./documentScanner";

/**
 * One screenshot for a ticket or a ticket reply.
 *
 * Reads the picked file and hands back a data URL already squeezed under
 * the document scanner's size cap, so create-ticket and reply-ticket
 * receive the same shape from every form. Rejects with a sentence the form
 * can show as-is.
 */
export async function readImageAttachment(file) {
  if (!file?.type?.startsWith("image/")) throw new Error("Attach an image (screenshot).");
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (ev) => resolve(ev.target.result);
    reader.onerror = () => reject(new Error("Could not read that image."));
    reader.readAsDataURL(file);
  });
  try {
    return await compressImage(dataUrl);
  } catch {
    throw new Error("Could not read that image.");
  }
}
