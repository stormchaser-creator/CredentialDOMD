// NPI Registry API (NPPES) - Free, no API key required
// Documentation: https://npiregistry.cms.hhs.gov/api-page
//
// CORS handling:
// In dev: Vite proxy at /npi-api → npiregistry.cms.hhs.gov/api
// In prod: the NIH/NLM Clinical Tables mirror of the registry (CORS: *),
// translated into NPPES shape below; it carries the same taxonomy/license rows.

import { nameSearchParams, extractLicensesFromNPI } from "./npiImport.js";

// The pure half (name splitting, query rules, license extraction and merge)
// lives in npiImport.js so it can be tested in plain node; re-exported here
// so existing imports keep working.
export { extractLicensesFromNPI };

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
    // The mirror prefix-matches every word on its own, so an NPPES trailing
    // wildcard is redundant there and is stripped.
    const word = (k) => (q.get(k) || "").replace(/\*/g, "").trim();
    nlm.searchParams.set("terms", `${word("last_name")} ${word("first_name")}`.trim());
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
 * Search for individual providers by name, optionally within a state.
 * `wildcard` turns the first name into a prefix match ("Eri*"), which NPPES
 * allows after two characters. Returns an array of results (default max 20).
 */
export async function searchNPI({ firstName, lastName, state, limit = 20, wildcard = false }) {
  const query = nameSearchParams({ firstName, lastName, state, limit, wildcard });
  if (!query) return [];
  const params = new URLSearchParams(query);

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
 * The "I do not know my NPI" path: find the physician by the name they
 * already typed, widening only when a stricter search comes back empty.
 * 1. exact name within the chosen state
 * 2. exact name in every state
 * 3. first-name prefix (NPPES wildcard; the production mirror already
 *    prefix-matches, so this step only runs against NPPES itself)
 * Returns { results, note } where note says how the search was widened.
 */
export async function findProvidersByName({ firstName, lastName, state, limit = 50 }) {
  const st = (state || "").trim().toUpperCase();
  if (st) {
    const inState = await searchNPI({ firstName, lastName, state: st, limit });
    if (inState.length) return { results: inState, note: "" };
  }
  const anywhere = await searchNPI({ firstName, lastName, limit });
  if (anywhere.length) return { results: anywhere, note: st ? `No match in ${st}; showing every state.` : "" };
  if (isDev && (firstName || "").trim().length >= 2) {
    const prefix = await searchNPI({ firstName, lastName, limit, wildcard: true });
    if (prefix.length) return { results: prefix, note: "No exact first-name match; showing similar first names." };
  }
  return { results: [], note: "" };
}
