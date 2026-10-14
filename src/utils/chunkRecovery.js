// A script chunk that did not arrive. On 2026-10-10 an iPhone on the sign-in
// screen reported "Loading chunk 1192 failed" for Clerk's own
// vendors_clerk.browser chunk (clerk-js 5.128.0, pinned in main.jsx). The file
// was there (200, a year's cache), so the connection dropped it: the sign-in
// form never mounted and the page gave no way out but a manual reload.
//
// Clerk's loader (webpack) forgets a failed chunk, so mounting the form again
// fetches it again. Vite's own dynamic imports say it differently per browser.
const CHUNK_FAILURE = /Loading (?:CSS )?chunk [\w-]+ failed|ChunkLoadError|Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|Unable to preload CSS/i;

const text = reason => {
  if (typeof reason === "string") return reason;
  if (!reason || typeof reason !== "object") return "";
  return [reason.name, reason.message].filter(v => typeof v === "string").join(": ");
};

/** Whether an error or rejection reason is a chunk that failed to load. */
export function isChunkLoadFailure(reason) {
  return CHUNK_FAILURE.test(text(reason));
}

/**
 * Calls onFailure for each chunk load failure the page sees (an unhandled
 * rejection, as Clerk's was, or a script error event). Returns the cleanup.
 * Nothing is prevented: the error reporter still records it.
 */
export function watchChunkFailures(onFailure, target = globalThis.window) {
  if (!target || typeof target.addEventListener !== "function") return () => {};
  const onRejection = event => { if (isChunkLoadFailure(event?.reason)) onFailure(); };
  const onError = event => { if (isChunkLoadFailure(event?.error) || isChunkLoadFailure(event?.message)) onFailure(); };
  target.addEventListener("unhandledrejection", onRejection);
  target.addEventListener("error", onError);
  return () => {
    target.removeEventListener("unhandledrejection", onRejection);
    target.removeEventListener("error", onError);
  };
}

/**
 * What the sign-in screen does about a failure: while the form shows no field
 * yet (nothing typed can be lost) the first one remounts it by itself after a
 * moment; any other shows a notice with Try again and Reload page, and never
 * reloads by itself.
 */
export const CHUNK_RETRY_DELAY_MS = 1200;
export function chunkRecoveryStep(failures, formShown) {
  if (!Number.isInteger(failures) || failures <= 0) return "none";
  return failures === 1 && !formShown ? "remount" : "notice";
}
