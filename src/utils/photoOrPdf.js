/**
 * The setup capture flows (CaptureRun, DateFixList) read a card or a
 * certificate, so they take a photo or a PDF and nothing else.
 *
 * Their picker's accept="image/*,application/pdf" is only a hint: a desktop
 * file dialog's "All files" hands over anything. A spreadsheet picked that
 * way used to be read, sent to the scanner and stored as the record's proof
 * without ever passing the spreadsheet guard. It is refused here, before
 * anything is read, the same way Expenses.stageFiles skips it.
 */

// A file with no type from the browser is judged by its extension.
const PHOTO_OR_PDF_EXT = /\.(jpe?g|png|gif|webp|heic|heif|bmp|tiff?|pdf)$/i;

export function isPhotoOrPdf(file) {
  const type = String(file?.type || "").toLowerCase().split(";")[0].trim();
  if (type) return type.startsWith("image/") || type === "application/pdf";
  return PHOTO_OR_PDF_EXT.test(String(file?.name || ""));
}

export function notPhotoOrPdf(file) {
  return `"${file?.name || "That file"}" is not a photo or a PDF. Photograph the document or choose its PDF.`;
}
