// QA-only transforms of served fixture bytes. Production files and their
// endpoint/offer validation stay unchanged. Native Safari uses a real
// cross-origin loopback proxy instead of Playwright's request interception.
export const NATIVE_PUBLIC_PLACEHOLDER = 'https://qalabnotarealproject.supabase.co';
export function loopbackOrigin(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port
      || url.username || url.password || url.pathname !== '/' || url.search || url.hash
      || url.origin !== value) throw Error('Native public fixture requires a plain loopback origin');
  return value;
}

export function nativePublicOfferScript(source, apiOrigin) {
  loopbackOrigin(apiOrigin);
  const original = 'fetchImpl = globalThis.fetch';
  if (source.split(original).length !== 2) throw Error('Public offer fetch default changed; review the native fixture');
  const path = '/functions/v1/public-membership-offer';
  const adapter = `function qaNativePublicOfferFetch(url, options) {
    if (url !== ${JSON.stringify(NATIVE_PUBLIC_PLACEHOLDER + path)}) throw Error('Unexpected QA public endpoint');
    return globalThis.fetch(${JSON.stringify(apiOrigin + path)}, options);
  }\n`;
  return adapter + source.replace(original, 'fetchImpl = qaNativePublicOfferFetch');
}

export function nativePublicHtml(source, siteOrigin) {
  loopbackOrigin(siteOrigin);
  // Limit substitutions to exact first-party link targets. No DNS change,
  // global fetch override, or production endpoint validation exception.
  return source.replace(/\b(href|action)=(['"])https:\/\/credentialdomd\.com(?=[/"'])([^"']*)\2/g,
    (_match, attr, quote, rest) => `${attr}=${quote}${siteOrigin}${rest}${quote}`)
    .replace(/<link\b[^>]*\bhref=['"]https:\/\/fonts\.(?:googleapis|gstatic)\.com\/[^>]*>/gi, '');
}

export function nativePublicHeaders(apiOrigin) {
  loopbackOrigin(apiOrigin);
  return {
    'Cache-Control': 'no-store',
    'Content-Security-Policy': `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self' ${apiOrigin}; object-src 'none'; base-uri 'self'; form-action 'self'`,
  };
}
