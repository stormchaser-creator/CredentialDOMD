/**
 * The one place an edge function talks to the NPPES NPI Registry.
 *
 * npi-proxy (the browser's CORS relay) and public-record both call the same
 * registry, so the base URL, the User-Agent NPPES wants, and the timeout live
 * here rather than being written twice and drifting.
 *
 * NPPES sends no CORS headers, which is why every browser call comes through
 * a function in the first place.
 */

export const NPPES_BASE = "https://npiregistry.cms.hhs.gov/api/?version=2.1";
export const UPSTREAM_UA = "CredentialDOMD/1.0 (+https://credentialdomd.com)";

/** Registry URL for a query string already shaped for NPPES (may be empty). */
export function nppesUrl(params: string): string {
  const p = String(params || "").replace(/^[?&]+/, "");
  return p ? `${NPPES_BASE}&${p}` : NPPES_BASE;
}

export interface NppesResponse {
  ok: boolean;
  status: number;
  data: unknown;
}

/**
 * Fetch the registry with a timeout. A non-2xx upstream comes back as
 * ok:false with its status and no data; a timeout or network failure throws,
 * so the caller decides whether that is a 500 or a degraded source.
 */
export async function fetchNppes(params: string, timeoutMs = 10000): Promise<NppesResponse> {
  const upstream = await fetch(nppesUrl(params), {
    headers: { "User-Agent": UPSTREAM_UA, "Accept": "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!upstream.ok) return { ok: false, status: upstream.status, data: null };
  return { ok: true, status: upstream.status, data: await upstream.json() };
}
