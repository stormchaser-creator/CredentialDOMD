/**
 * How many screenshots one ticket or one reply may carry, and what happens
 * when somebody picks more.
 *
 * The limits live here rather than in the control so a node test can hold
 * them to the same numbers the edge function enforces
 * (MAX_ATTACHMENTS and MAX_TOTAL_ATTACHMENT_BYTES in
 * supabase/functions/_shared/ticketAttachment.ts). A client that lets a
 * physician attach six images and a server that refuses the sixth is a bug
 * they discover only after writing the message.
 */

export const MAX_TICKET_IMAGES = 5;
export const MAX_TICKET_IMAGE_BYTES = 5 * 1024 * 1024;   // per image, decoded
export const MAX_TICKET_TOTAL_BYTES = 12 * 1024 * 1024;  // all of them together

/** Roughly what a data URL weighs once decoded. */
export function dataUrlBytes(dataUrl) {
  const i = String(dataUrl || "").indexOf(",");
  if (i < 0) return 0;
  const b64 = String(dataUrl).slice(i + 1);
  const pad = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((b64.length * 3) / 4) - pad);
}

export function totalBytes(images) {
  return (Array.isArray(images) ? images : []).reduce((n, im) => n + dataUrlBytes(im?.data), 0);
}

/**
 * Add newly picked images to the ones already attached.
 *
 * Returns { images, error }. Whatever fits is kept, and `error` says what did
 * not and why, because silently dropping the fourth screenshot is how a
 * physician sends three and believes they sent four.
 */
export function addImages(existing, picked) {
  const have = Array.isArray(existing) ? [...existing] : [];
  const list = Array.isArray(picked) ? picked : [picked].filter(Boolean);
  let error = "";

  for (const img of list) {
    if (!img?.data) continue;
    if (have.length >= MAX_TICKET_IMAGES) {
      error = `Only ${MAX_TICKET_IMAGES} screenshots fit on one message. The rest were not attached.`;
      break;
    }
    const size = dataUrlBytes(img.data);
    if (size > MAX_TICKET_IMAGE_BYTES) {
      error = `"${img.name || "That image"}" is larger than 5 MB and was not attached.`;
      continue;
    }
    if (totalBytes(have) + size > MAX_TICKET_TOTAL_BYTES) {
      error = "Those images are too large together (12 MB max). Send the rest in a second message.";
      break;
    }
    have.push(img);
  }
  return { images: have, error };
}

/** The wire field both edge functions read. */
export function attachmentsPayload(images) {
  const list = (Array.isArray(images) ? images : [images]).filter((im) => im?.data);
  if (!list.length) return {};
  // The singular is still sent so a function that has not been redeployed
  // yet still receives the first image rather than none.
  return { attachment: { data: list[0].data }, attachments: list.map((im) => ({ data: im.data })) };
}

/** Every signed link for one message, from either shape the API returns. */
export function linksFor(value) {
  if (!value) return [];
  return Array.isArray(value) ? value.filter(Boolean) : [value];
}
