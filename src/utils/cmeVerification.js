import { CME_PROVIDERS } from "../constants/cmeProviders";

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8000;

export function shouldRunVerification(settings) {
  if (!settings.lastCmeVerification) return true;
  const elapsed = Date.now() - new Date(settings.lastCmeVerification).getTime();
  return elapsed >= THIRTY_DAYS_MS;
}

export async function verifyCMEProviders(existingResults = {}) {
  const results = { ...existingResults };
  const now = new Date().toISOString();

  const checks = CME_PROVIDERS.map(async (provider) => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      await fetch(provider.url, {
        method: "HEAD",
        mode: "no-cors",
        signal: controller.signal,
        cache: "no-store",
      });
      results[provider.id] = { status: "ok", checkedAt: now };
    } catch (err) {
      results[provider.id] = {
        status: err.name === "AbortError" ? "timeout" : "unreachable",
        checkedAt: now,
      };
    } finally {
      clearTimeout(timeoutId);
    }
  });

  await Promise.allSettled(checks);
  return results;
}

export function getVerificationSummary(results) {
  const entries = Object.entries(results);
  const ok = entries.filter(([, r]) => r.status === "ok").length;
  const failing = entries.filter(([, r]) => r.status === "unreachable" || r.status === "timeout");
  return {
    ok,
    failing: failing.length,
    failingIds: failing.map(([id]) => id),
  };
}

export function getProviderVerificationStatus(results, providerId) {
  return results[providerId]?.status || "unchecked";
}
