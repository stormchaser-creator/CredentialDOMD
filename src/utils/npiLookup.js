// NPI Registry API (NPPES) - Free, no API key required
// Documentation: https://npiregistry.cms.hhs.gov/api-page
//
// CORS handling:
// In dev: Vite proxy at /npi-api → npiregistry.cms.hhs.gov/api
// In prod: Supabase Edge Function npi-proxy (deployed with --no-verify-jwt)

const NPPES_BASE = "https://npiregistry.cms.hhs.gov/api/?version=2.1";
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;
const isDev = import.meta.env.DEV;

/**
 * Fetch NPI data with CORS handling.
 * Dev: Vite proxy. Prod: Supabase npi-proxy edge function.
 */
async function fetchNPI(url) {
  if (isDev) {
    const proxyUrl = url.replace("https://npiregistry.cms.hhs.gov/api/", "/npi-api/");
    const res = await fetch(proxyUrl);
    if (!res.ok) throw new Error(`NPPES API error: ${res.status}`);
    return res.json();
  }

  // Production: NPPES itself sends no CORS headers, so query the NIH/NLM
  // Clinical Tables mirror of the same registry (CORS: *) and translate its
  // response into NPPES shape so the rest of this module stays unchanged.
  const q = new URL(url).searchParams;
  const nlm = new URL("https://clinicaltables.nlm.nih.gov/api/npi_idv/v3/search");
  const number = q.get("number");
  if (number) {
    nlm.searchParams.set("terms", number);
  } else {
    nlm.searchParams.set("terms", `${q.get("last_name") || ""} ${q.get("first_name") || ""}`.trim());
    if (q.get("state")) nlm.searchParams.set("q", `addr_practice.state:${q.get("state")}`);
  }
  nlm.searchParams.set("maxList", q.get("limit") || "20");
  nlm.searchParams.set("ef", [
    "NPI", "name.first", "name.last", "name.credential", "gender", "licenses",
    "addr_practice.line1", "addr_practice.line2", "addr_practice.city",
    "addr_practice.state", "addr_practice.zip", "addr_practice.phone",
  ].join(","));

  const res = await fetch(nlm.toString());
  if (!res.ok) throw new Error(`NPI lookup error: ${res.status}`);
  const [count, npis, extra] = await res.json();
  const f = (key, i) => extra?.[key]?.[i] ?? "";

  const results = (npis || []).map((npi, i) => ({
    number: f("NPI", i) || npi,
    enumeration_type: "NPI-1",
    basic: {
      first_name: f("name.first", i),
      last_name: f("name.last", i),
      credential: f("name.credential", i),
      gender: f("gender", i),
    },
    addresses: [{
      address_purpose: "LOCATION",
      address_1: f("addr_practice.line1", i),
      address_2: f("addr_practice.line2", i),
      city: f("addr_practice.city", i),
      state: f("addr_practice.state", i),
      postal_code: f("addr_practice.zip", i),
      telephone_number: f("addr_practice.phone", i),
    }],
    taxonomies: (extra?.licenses?.[i] || []).map((lic) => ({
      code: lic?.taxonomy?.code || "",
      desc: lic?.taxonomy?.classification || "",
      license: lic?.lic_number || "",
      state: lic?.lic_state || "",
      primary: lic?.is_primary_taxonomy === "Y",
    })),
  }));

  return { result_count: count ?? results.length, results };
}

/**
 * Look up a provider by NPI number.
 * Returns parsed provider data or null.
 */
export async function lookupNPI(npi) {
  if (!npi || !/^\d{10}$/.test(npi.trim())) {
    throw new Error("NPI must be a 10-digit number");
  }

  const url = `${NPPES_BASE}&number=${npi.trim()}`;
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

  const url = `${NPPES_BASE.replace("?version=2.1", "")}?${params}`;
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
