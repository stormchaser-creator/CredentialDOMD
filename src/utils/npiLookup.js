// NPI Registry API (NPPES) - Free, no API key required
// Documentation: https://npiregistry.cms.hhs.gov/api-page
//
// The NPPES API does NOT set CORS headers, so direct browser fetch is blocked.
// In dev: Vite proxy at /npi-api → npiregistry.cms.hhs.gov/api
// In prod: We use a public CORS proxy as fallback.

const PROD_DIRECT = "https://npiregistry.cms.hhs.gov/api/?version=2.1";

const isDev = import.meta.env.DEV;

/**
 * Fetch NPI data with CORS handling.
 * In dev mode: Vite proxy at /npi-api avoids CORS.
 * In production: Direct fetch (works in Capacitor/native contexts),
 *   or if CORS blocked, shows actionable error.
 *   NOTE: For web production deployment, deploy a serverless proxy
 *   (Cloudflare Worker / Vercel Edge Function) and update PROD_PROXY_URL.
 */
async function fetchNPI(url) {
  if (isDev) {
    // In dev, rewrite the URL to go through Vite proxy
    const proxyUrl = url.replace("https://npiregistry.cms.hhs.gov/api/", "/npi-api/");
    const res = await fetch(proxyUrl);
    if (!res.ok) throw new Error(`NPPES API error: ${res.status}`);
    return res.json();
  }

  // Production: try direct fetch (works in Capacitor native apps, no CORS)
  try {
    const res = await fetch(url);
    if (!res.ok) throw Object.assign(new Error(`NPPES API error: ${res.status}`), { isApiError: true });
    return res.json();
  } catch (err) {
    if (err.isApiError) throw err;
    // Network/CORS error — provide guidance
    throw new Error("NPI lookup is not available in this browser context. The NPPES registry blocks direct browser access. This feature works fully in the mobile app.");
  }
}

/**
 * Look up a provider by NPI number.
 * Returns parsed provider data or null.
 */
export async function lookupNPI(npi) {
  if (!npi || !/^\d{10}$/.test(npi.trim())) {
    throw new Error("NPI must be a 10-digit number");
  }

  const url = `${PROD_DIRECT}&number=${npi.trim()}`;
  const data = await fetchNPI(url);

  if (data.result_count === 0 || !data.results?.length) {
    return null;
  }

  const result = data.results[0];
  const basic = result.basic || {};
  const addresses = result.addresses || [];
  const taxonomies = result.taxonomies || [];

  // Find primary practice address
  const practiceAddr = addresses.find(a => a.address_purpose === "LOCATION") || addresses[0] || {};

  // Find primary taxonomy (specialty)
  const primaryTax = taxonomies.find(t => t.primary) || taxonomies[0] || {};

  return {
    npi: result.number,
    entityType: result.enumeration_type, // "NPI-1" = individual
    firstName: basic.first_name || "",
    lastName: basic.last_name || "",
    middleName: basic.middle_name || "",
    credential: basic.credential || "", // e.g., "MD", "DO"
    gender: basic.gender || "",
    enumerationDate: basic.enumeration_date || "",
    lastUpdated: basic.last_updated || "",
    status: basic.status || "",

    // Practice address
    address: {
      line1: practiceAddr.address_1 || "",
      line2: practiceAddr.address_2 || "",
      city: practiceAddr.city || "",
      state: practiceAddr.state || "",
      zip: practiceAddr.postal_code || "",
      phone: practiceAddr.telephone_number || "",
      fax: practiceAddr.fax_number || "",
    },

    // Primary specialty
    specialty: {
      code: primaryTax.code || "",
      description: primaryTax.desc || "",
      license: primaryTax.license || "",
      state: primaryTax.state || "",
      isPrimary: primaryTax.primary || false,
    },

    // All taxonomies
    allTaxonomies: taxonomies.map(t => ({
      code: t.code || "",
      description: t.desc || "",
      license: t.license || "",
      state: t.state || "",
      isPrimary: t.primary || false,
    })),
  };
}

/**
 * Search for providers by name.
 * Returns array of results (max 20).
 */
export async function searchNPI({ firstName, lastName, state, limit = 20 }) {
  const params = new URLSearchParams({ version: "2.1", limit: String(limit) });
  if (firstName) params.set("first_name", firstName.trim());
  if (lastName) params.set("last_name", lastName.trim());
  if (state) params.set("state", state);
  params.set("enumeration_type", "NPI-1"); // Individual only

  const url = `https://npiregistry.cms.hhs.gov/api/?${params}`;
  const data = await fetchNPI(url);
  if (!data.results?.length) return [];

  return data.results.map(r => {
    const basic = r.basic || {};
    const taxonomies = r.taxonomies || [];
    const primaryTax = taxonomies.find(t => t.primary) || taxonomies[0] || {};
    const addresses = r.addresses || [];
    const addr = addresses.find(a => a.address_purpose === "LOCATION") || addresses[0] || {};

    return {
      npi: r.number,
      firstName: basic.first_name || "",
      lastName: basic.last_name || "",
      name: `${basic.first_name || ""} ${basic.last_name || ""}`.trim(),
      credential: basic.credential || "",
      specialty: primaryTax.desc || "",
      state: addr.state || "",
      city: addr.city || "",
      phone: addr.telephone_number || "",
      address: {
        line1: addr.address_1 || "",
        line2: addr.address_2 || "",
        city: addr.city || "",
        state: addr.state || "",
        zip: addr.postal_code || "",
        phone: addr.telephone_number || "",
      },
      allTaxonomies: taxonomies.map(t => ({
        code: t.code || "",
        description: t.desc || "",
        license: t.license || "",
        state: t.state || "",
        isPrimary: t.primary || false,
      })),
    };
  });
}

/**
 * Extract license records from an NPI result's taxonomies.
 * Returns array of { licenseNumber, state, taxonomyCode, description }.
 * Only includes entries that have both a license number and state.
 */
export function extractLicensesFromNPI(result) {
  if (!result?.allTaxonomies) return [];
  return result.allTaxonomies
    .filter(t => t.license && t.state)
    .map(t => ({
      licenseNumber: t.license,
      state: t.state,
      taxonomyCode: t.code,
      description: t.description,
    }));
}
