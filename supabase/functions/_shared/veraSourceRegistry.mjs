// Reviewed fixed official pages. No caller-supplied URL, query or redirects.
export const VERA_SOURCE_VERSION = '2026-09-19-v1';
export const VERA_SOURCE_ORIGIN = 'https://credentialdomd.com';
export const VERA_SOURCES = Object.freeze({
  'oh-cme-general': Object.freeze({ title: 'Ohio physician CME rule', jurisdiction: 'OH', degrees: ['MD', 'DO'], topic: 'general_cme', url: 'https://codes.ohio.gov/ohio-administrative-code/rule-4731-10-02', marker: 'Requisite hours of continuing medical education', reviewedOn: '2026-09-19' }),
  'oh-pain-clinic': Object.freeze({ title: 'Ohio pain-clinic rule', jurisdiction: 'OH', degrees: ['MD', 'DO'], topic: 'pain_clinic', url: 'https://codes.ohio.gov/ohio-administrative-code/rule-4731-29-01', marker: 'Standards and procedures for the operation of a pain management clinic', reviewedOn: '2026-09-19' }),
  'dea-mate': Object.freeze({ title: 'DEA MATE training questions', jurisdiction: 'US', degrees: ['MD', 'DO'], topic: 'mate_training', url: 'https://www.deadiversion.usdoj.gov/faq/MATE_Act_faq.html', marker: 'MATE', reviewedOn: '2026-09-19' }),
});
export const VERA_FETCH_LIMITS = Object.freeze({ bytes: 262144, timeoutMs: 6500, excerptChars: 2400, cacheMs: 3600000, failureCacheMs: 60000, maxRedirects: 0 });
export function veraSource(id) { return typeof id === 'string' && Object.hasOwn(VERA_SOURCES, id) ? VERA_SOURCES[id] : null; }
