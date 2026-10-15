// Resend receiving metadata GETs are idempotent. A transport failure before
// processing starts can be retried once without duplicating a request or send.
// HTTP refusals and malformed JSON remain failures for webhook redelivery.
const transient = error => ['TypeError', 'AbortError', 'TimeoutError', 'NetworkError', 'Http'].includes(error?.name)
  || ['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT'].includes(error?.cause?.code || error?.code);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function receivingMetadataJson(url, {
  headers, label = 'retrieve receiving metadata', fetchImpl = globalThis.fetch,
  timeoutMs = 5000, retryDelayMs = 100,
} = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 5000
    || !Number.isFinite(retryDelayMs) || retryDelayMs < 0 || retryDelayMs > 100) throw new Error('Invalid receiving metadata budget');
  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController();
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const error = new DOMException(`${label}: timed out`, 'TimeoutError');
        controller.abort(error);
        reject(error);
      }, timeoutMs);
    });
    try {
      return await Promise.race([
        (async () => {
          const response = await fetchImpl(url, { method: 'GET', headers, signal: controller.signal });
          if (!response.ok) {
            // Do not wait for an error body or retry a known HTTP refusal.
            response.body?.cancel().catch(() => {});
            throw new Error(`${label}: ${response.status}`);
          }
          // The same deadline includes the body, which can also disconnect.
          return await response.json();
        })(),
        timeout,
      ]);
    } catch (error) {
      if (attempt > 0 || !transient(error)) throw error;
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
    if (retryDelayMs) await pause(retryDelayMs);
  }
}
