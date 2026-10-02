// Injected delay for the timing-race audit: every real setTimeout fires
// RACE_DELAY_MS later, and every Blob/File read resolves RACE_DELAY_MS later.
// A test that waits for its outcome still passes (slower); one that waits a
// fixed number of turns for a timer or a file read fails.
const DELAY = Number(process.env.RACE_DELAY_MS || 60);
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = function delayedSetTimeout(fn, ms, ...args) { return realSetTimeout(fn, (Number(ms) || 0) + DELAY, ...args); };
const later = () => new Promise((r) => realSetTimeout(r, DELAY));
for (const name of ['arrayBuffer', 'text', 'bytes']) {
  const orig = Blob.prototype[name];
  if (typeof orig !== 'function') continue;
  Blob.prototype[name] = async function delayedRead(...a) { await later(); return orig.apply(this, a); };
}
