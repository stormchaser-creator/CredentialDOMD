/**
 * Public-record normalizer: raw register JSON in, proposed findings out.
 *
 * Pure. No fetch, no Deno, no imports, so scripts/public-record.test.mjs can
 * load this file in plain node (type stripping) against the fixtures in
 * scripts/fixtures/public-record/ captured from the live registers.
 *
 * Two honesty rules are enforced here rather than left to the UI:
 *
 *   confidence "record"  the register states this as fact (a license number
 *                        NPPES carries, the graduation year Medicare carries)
 *   confidence "lead"    an inference the physician has to confirm (a hospital
 *                        Medicare derived from claims activity, a paper matched
 *                        only by author name)
 *
 * A CMS facility affiliation is claims activity. It is evidence the physician
 * worked there. It is NOT proof of current privileges and NOT a credentialing
 * verification, so it never carries a status or an expiration date; the form
 * fields it cannot fill are listed in `needs` for the physician to supply.
 *
 * Nothing here writes anything. Findings are proposals; the client saves only
 * what the physician accepts, one item at a time.
 */

export type Confidence = "record" | "lead";

export interface FindingSource {
  /** Register name as it should read in the UI. */
  name: string;
  /** Public page for this item, "" when the register has no per-item page. */
  url: string;
  /** ISO timestamp of the fetch that produced it. */
  fetchedAt: string;
}

export interface Finding {
  id: string;
  /** A key of TABLE_MAP in src/lib/supabase.js, or "settings" for the profile. */
  section: string;
  kind: string;
  label: string;
  detail: string;
  /** Shaped for the section's CrudSection fields. Absent values stay absent. */
  fields: Record<string, string>;
  /** Required form fields the register cannot supply. */
  needs: string[];
  source: FindingSource;
  confidence: Confidence;
}

export interface SourceReport {
  id: string;
  name: string;
  url: string;
  fetchedAt: string;
  status: string;
  count: number;
  note?: string;
}

export interface NormalizeContext {
  npi: string;
  fetchedAt: string;
}

export const SOURCE_NAMES: Record<string, string> = {
  nppes: "NPPES NPI Registry",
  cmsClinician: "Medicare Care Compare (Doctors and Clinicians)",
  cmsAffiliation: "Medicare Care Compare (facility affiliations)",
  pubmed: "PubMed",
};

/** Values these registers use to mean "nothing here". */
const BLANKS = new Set(["", "--", "N/A", "NA", "NONE", "UNKNOWN", "NOT AVAILABLE"]);

/** Medicare's placeholders in med_sch. "OTHER" is a bucket, not a school. */
const MED_SCH_BLANKS = new Set(["OTHER", "OTHER SCHOOL", "UNKNOWN"]);

export function clean(v: unknown): string {
  const s = String(v == null ? "" : v).replace(/\s+/g, " ").trim();
  return BLANKS.has(s.toUpperCase()) ? "" : s;
}

const LOWER_WORDS = new Set(["and", "of", "the", "at", "for", "in", "on", "to", "a", "an"]);
const KEEP_UPPER = new Set(["LLC", "LLP", "PC", "PA", "MD", "DO", "II", "III", "IV", "USA", "US"]);

/**
 * Registers shout. "EISENHOWER MEDICAL CENTER" is the same fact as
 * "Eisenhower Medical Center"; only the casing changes, never a word.
 * Anything already mixed case is left exactly as the register wrote it.
 */
export function titleCase(v: unknown): string {
  const s = clean(v);
  if (!s || s !== s.toUpperCase()) return s;
  const word = (w: string, i: number): string => {
    if (!w) return w;
    const bare = w.replace(/[^A-Za-z]/g, "");
    if (KEEP_UPPER.has(bare)) return w;
    const lower = w.toLowerCase();
    if (i > 0 && LOWER_WORDS.has(lower)) return lower;
    return lower.replace(/(^|[^A-Za-z'])([a-z])/g, (_m, p, c) => p + c.toUpperCase());
  };
  return s.split(" ").map(word).join(" ");
}

/** Ten digits read as a phone number: "9095803353" and "(909) 580-1000"
 * both come back as 909-580-3353 style. Anything else is left as written. */
export function formatPhone(v: unknown): string {
  const s = clean(v);
  const d = s.replace(/\D/g, "");
  if (d.length === 10) return `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`;
  return s;
}

/** ZIP+4 arrives unpunctuated: "922703221" is 92270-3221. */
export function formatZip(v: unknown): string {
  const d = clean(v).replace(/\D/g, "");
  if (d.length === 9) return `${d.slice(0, 5)}-${d.slice(5)}`;
  return d.slice(0, 5);
}

export function oneLineAddress(parts: {
  line1?: unknown; line2?: unknown; city?: unknown; state?: unknown; zip?: unknown;
}): string {
  const street = [titleCase(parts.line1), titleCase(parts.line2)].filter(Boolean).join(" ");
  const city = titleCase(parts.city);
  const state = clean(parts.state).toUpperCase();
  const zip = formatZip(parts.zip);
  const tail = [state, zip].filter(Boolean).join(" ");
  return [street, city, tail].filter(Boolean).join(", ");
}

/** MD or DO from a registry credential string. Whole tokens only. */
export function degreeFromCredential(credential: unknown): string {
  const cred = clean(credential).toUpperCase().replace(/\./g, "");
  if (/\bDO\b/.test(cred)) return "DO";
  if (/\bMD\b/.test(cred)) return "MD";
  return "";
}

/** The license type the app files a state medical license under, by degree. */
export function licenseTypeFor(degree: string): string {
  return String(degree || "").toUpperCase() === "DO"
    ? "State Medical License (DO)"
    : "State Medical License";
}

/** Same license however the number was typed: "35.123456" = "35123456". */
export function licenseKey(state: unknown, number: unknown): string {
  const st = clean(state).toUpperCase();
  const num = clean(number).toUpperCase().replace(/[^A-Z0-9]/g, "");
  return `${st}|${num}`;
}

const npiProfileUrl = (npi: string) => `https://npiregistry.cms.hhs.gov/provider-view/${npi}`;
const careCompareDoctorUrl = (npi: string) => `https://www.medicare.gov/care-compare/details/physician/${npi}`;
const careCompareHospitalUrl = (ccn: string) => `https://www.medicare.gov/care-compare/details/hospital/${ccn}`;
const pubmedUrl = (pmid: string) => `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`;

function src(id: string, url: string, ctx: NormalizeContext): FindingSource {
  return { name: SOURCE_NAMES[id] || id, url, fetchedAt: ctx.fetchedAt };
}

const arr = (v: unknown): any[] => (Array.isArray(v) ? v : []);

// ── NPPES ───────────────────────────────────────────────────────────────────

/**
 * Identity, degree, practice address and every state license the registry
 * lists. Two taxonomy rows often share one license, so rows are deduped by
 * state + normalized number with the primary taxonomy's description winning.
 */
export function normalizeNppes(raw: any, ctx: NormalizeContext): Finding[] {
  const result = arr(raw?.results)[0];
  if (!result) return [];
  const out: Finding[] = [];
  const source = src("nppes", npiProfileUrl(clean(result.number) || ctx.npi), ctx);
  const basic = result.basic || {};
  const degree = degreeFromCredential(basic.credential);

  const first = titleCase(basic.first_name);
  const last = titleCase(basic.last_name);
  const fullName = [first, last].filter(Boolean).join(" ");
  if (fullName) {
    out.push({
      id: "nppes:profile:name",
      section: "settings",
      kind: "profileName",
      label: fullName + (degree ? `, ${degree}` : ""),
      detail: "The name the NPI registry has on file for this NPI.",
      fields: { name: fullName },
      needs: [],
      source,
      confidence: "record",
    });
  }

  if (degree) {
    out.push({
      id: "nppes:profile:degree",
      section: "settings",
      kind: "profileDegree",
      label: `Degree: ${degree}`,
      detail: `The registry lists the credential "${clean(basic.credential)}". Your degree sets which license and CME categories the app offers.`,
      fields: { degreeType: degree },
      needs: [],
      source,
      confidence: "record",
    });
  }

  const location = arr(result.addresses).find((a) => clean(a?.address_purpose).toUpperCase() === "LOCATION")
    || arr(result.practiceLocations)[0]
    || arr(result.addresses)[0];
  if (location) {
    const address = oneLineAddress({
      line1: location.address_1, line2: location.address_2,
      city: location.city, state: location.state, zip: location.postal_code,
    });
    const phone = formatPhone(location.telephone_number);
    const state = clean(location.state).toUpperCase();
    const fields: Record<string, string> = {};
    if (address) fields.address = address;
    if (phone) fields.phone = phone;
    if (state) fields.primaryState = state;
    if (Object.keys(fields).length) {
      out.push({
        id: "nppes:profile:practiceAddress",
        section: "settings",
        kind: "profileContact",
        label: address || phone,
        detail: "The practice location the NPI registry lists. It fills the address on your CV header and the state your renewal rules follow.",
        fields,
        needs: [],
        source,
        confidence: "record",
      });
    }
  }

  const rows = arr(result.taxonomies);
  const ordered = [...rows.filter((t) => t?.primary), ...rows.filter((t) => !t?.primary)];
  const seen = new Map<string, Finding>();
  for (const t of ordered) {
    const licenseNumber = clean(t?.license);
    const state = clean(t?.state).toUpperCase();
    if (!licenseNumber || !state) continue;
    const key = licenseKey(state, licenseNumber);
    if (seen.has(key)) continue;
    const desc = clean(t?.desc);
    // With no MD or DO in the credential there is no license type this app
    // offers for certain: the DO list has no plain "State Medical License",
    // so the type is left for the physician to pick rather than guessed.
    const type = degree ? licenseTypeFor(degree) : "";
    seen.set(key, {
      id: `nppes:license:${key}`,
      section: "licenses",
      kind: "stateLicense",
      label: `${state} medical license ${licenseNumber}`,
      detail: "The NPI registry carries this license number under your taxonomy record. It does not carry the issue or expiration date, so add the expiration date from your license before you save it.",
      fields: {
        ...(type ? { type } : {}),
        name: `${state} Medical License`,
        licenseNumber,
        state,
        notes: `Imported from NPPES NPI Registry${desc ? ` (${desc})` : ""}`,
      },
      needs: type ? ["expirationDate"] : ["type", "expirationDate"],
      source,
      confidence: "record",
    });
  }
  out.push(...seen.values());
  return out;
}

// ── CMS Doctors and Clinicians (mj5m-pzi6) ──────────────────────────────────

/**
 * One row per practice location. Graduation year is stated fact; the practice
 * organizations are Medicare enrollment records, so they are work-history
 * leads. med_sch is very often the literal "OTHER", which is a bucket and not
 * a school: it is dropped rather than guessed at.
 */
export function normalizeCmsClinician(raw: any, ctx: NormalizeContext): Finding[] {
  const rows = arr(raw?.results);
  if (!rows.length) return [];
  const out: Finding[] = [];
  const source = src("cmsClinician", careCompareDoctorUrl(ctx.npi), ctx);
  const first = rows[0];

  const gradYear = clean(first.grd_yr).replace(/\D/g, "");
  const medSchRaw = clean(first.med_sch);
  const medSch = MED_SCH_BLANKS.has(medSchRaw.toUpperCase()) ? "" : titleCase(medSchRaw);
  const degree = degreeFromCredential(first.cred);
  if (gradYear || medSch) {
    const fields: Record<string, string> = {};
    if (degree === "DO") fields.type = "Doctor of Osteopathic Medicine (DO)";
    else if (degree === "MD") fields.type = "Doctor of Medicine (MD)";
    if (medSch) {
      fields.institution = medSch;
      fields.name = `${degree || "Medical"} Diploma, ${medSch}`;
    }
    const needs: string[] = [];
    if (!medSch) needs.push("institution");
    needs.push("graduationDate");
    out.push({
      id: "cms:education:medicalSchool",
      section: "education",
      kind: "medicalSchool",
      label: medSch
        ? `${medSch}${gradYear ? `, class of ${gradYear}` : ""}`
        : `Medical school, class of ${gradYear}`,
      detail: [
        gradYear ? `Medicare lists your graduation year as ${gradYear}.` : "",
        medSch ? "" : "Medicare files the school as \"OTHER\", which is a bucket and not a school name, so it is left blank here. Add the school yourself.",
        "Medicare carries the year only, so set the graduation date before you save it.",
      ].filter(Boolean).join(" "),
      fields,
      needs,
      source,
      confidence: "record",
    });
  }

  // One work-history lead per organization, not per address: Medicare lists a
  // row for every practice location, and a group with three offices is still
  // one employer.
  const byOrg = new Map<string, any>();
  for (const r of rows) {
    const name = clean(r.facility_name);
    if (!name) continue;
    const key = clean(r.org_pac_id) || name.toUpperCase();
    if (!byOrg.has(key)) byOrg.set(key, r);
  }
  for (const [key, r] of byOrg) {
    const employer = titleCase(r.facility_name);
    const city = titleCase(r.citytown);
    const state = clean(r.state).toUpperCase();
    const where = [city, state].filter(Boolean).join(", ");
    out.push({
      id: `cms:workHistory:${key}`,
      section: "workHistory",
      kind: "practiceOrganization",
      label: employer + (where ? ` (${where})` : ""),
      detail: "Medicare lists this organization as a practice location enrolled under your NPI. That is evidence you practised there, not a start or end date, so fill in your title and dates before you save it.",
      fields: {
        employer,
        ...(city ? { city } : {}),
        ...(state ? { state } : {}),
        description: `Practice location listed by Medicare Care Compare${clean(r.adr_ln_1) ? `: ${oneLineAddress({ line1: r.adr_ln_1, line2: r.adr_ln_2, city: r.citytown, state: r.state, zip: r.zip_code })}` : ""}`,
      },
      needs: [],
      source,
      confidence: "lead",
    });
  }
  return out;
}

// ── CMS facility affiliations (27ea-46a8) + hospital names (xubh-q36u) ──────

/**
 * Claims-derived hospital affiliations. Evidence the physician worked there.
 * Never a privilege status, never an expiration date, never a verification.
 * A CCN that Hospital General Information cannot name still yields a finding,
 * because the affiliation itself is what the register states.
 */
export function normalizeAffiliations(
  raw: any,
  hospitalsByCcn: Record<string, any>,
  ctx: NormalizeContext,
): Finding[] {
  const rows = arr(raw?.results);
  const out: Finding[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    const ccn = clean(r.facility_affiliations_certification_number);
    if (!ccn || seen.has(ccn)) continue;
    seen.add(ccn);
    const type = clean(r.facility_type) || "Facility";
    const h = arr(hospitalsByCcn?.[ccn]?.results)[0] || null;
    const facility = h ? titleCase(h.facility_name) : "";
    const city = h ? titleCase(h.citytown || h.city) : "";
    const state = h ? clean(h.state).toUpperCase() : "";
    const where = [city, state].filter(Boolean).join(", ");
    const fields: Record<string, string> = {};
    if (facility) {
      fields.facility = facility;
      fields.name = facility;
    }
    if (city) fields.city = city;
    if (state) fields.state = state;
    fields.notes = `Medicare facility affiliation, CCN ${ccn}. Derived from claims activity, not a credentialing verification.`;
    out.push({
      id: `cms:privilege:${ccn}`,
      section: "privileges",
      kind: "facilityAffiliation",
      label: facility ? `${facility}${where ? ` (${where})` : ""}` : `${type}, CCN ${ccn}`,
      detail: "Medicare lists this affiliation from claims you filed there. It is evidence you worked at the facility. It is not proof of current privileges and no hospital or board has confirmed anything here. Confirm it with the medical staff office, then add the privilege type and your reappointment date.",
      fields,
      needs: ["expirationDate"],
      source: src("cmsAffiliation", h ? careCompareHospitalUrl(ccn) : careCompareDoctorUrl(ctx.npi), ctx),
      confidence: "lead",
    });
  }
  return out;
}

// ── PubMed ──────────────────────────────────────────────────────────────────

/** The author term for a PubMed search. Last name plus first initial. */
export function pubmedAuthorTerm(name: { firstName?: string; lastName?: string }): string {
  // Registers shout, and this term is shown to the physician as the search
  // that was run, so it is cased the way a person writes a name.
  const last = titleCase(clean(name?.lastName).replace(/[^A-Za-z' -]/g, ""));
  const initial = clean(name?.firstName).replace(/[^A-Za-z]/g, "").slice(0, 1).toUpperCase();
  if (!last) return "";
  return `"${last}${initial ? ` ${initial}` : ""}"[Author]`;
}

function authorList(authors: any[]): string {
  const names = authors.map((a) => clean(a?.name)).filter(Boolean);
  if (!names.length) return "";
  if (names.length <= 3) return names.join(", ");
  return `${names.slice(0, 3).join(", ")}, et al.`;
}

function idOf(item: any, type: string): string {
  const hit = arr(item?.articleids).find((a) => clean(a?.idtype) === type);
  return hit ? clean(hit.value) : "";
}

/**
 * Every hit is a lead. PubMed matches on the author string alone and cannot
 * tell two people with the same surname and initial apart, so each paper is
 * proposed on its own with enough of the record to judge it by.
 */
export function normalizePubmed(esummary: any, ctx: NormalizeContext, term = ""): Finding[] {
  const result = esummary?.result;
  if (!result) return [];
  const uids = arr(result.uids);
  const out: Finding[] = [];
  for (const uid of uids) {
    const item = result[String(uid)];
    if (!item || clean(item.error)) continue;
    const pmid = clean(item.uid) || String(uid);
    const title = clean(item.title).replace(/\.$/, "");
    const journal = clean(item.source);
    const journalFull = clean(item.fulljournalname);
    // Book chapters (StatPearls and the like) carry no journal at all: the
    // venue lives in booktitle, and a citation without it is an unusable CV line.
    const book = clean(item.booktitle);
    const venue = journal || book;
    const year = (clean(item.pubdate).match(/\d{4}/) || [""])[0];
    const authors = authorList(arr(item.authors));
    const volume = clean(item.volume);
    const issue = clean(item.issue);
    const pages = clean(item.pages);
    const doi = idOf(item, "doi") || (clean(item.elocationid).match(/10\.\S+/) || [""])[0];

    let cite = "";
    if (authors) cite += `${authors.replace(/\.$/, "")}. `;
    if (title) cite += `${title}. `;
    if (venue) cite += `${venue}. `;
    if (year) {
      cite += year;
      if (volume) cite += `;${volume}`;
      if (issue) cite += `(${issue})`;
      if (pages) cite += `:${pages}`;
      cite += ". ";
    }
    if (doi) cite += `doi:${doi}`;
    cite = cite.trim();

    const shortTitle = title.length > 60 ? `${title.slice(0, 57)}...` : title;
    const fields: Record<string, string> = { pmid, url: pubmedUrl(pmid) };
    if (cite) fields.citation = cite;
    if (year) fields.year = year;
    if (doi) fields.doi = doi;
    const stem = [venue, year].filter(Boolean).join(" ");
    fields.name = stem
      ? stem + (shortTitle ? `: ${shortTitle}` : "")
      : (shortTitle || `PMID ${pmid}`);
    fields.notes = `Found on PubMed by author name${term ? ` (${term})` : ""}. Confirm this is your paper.`;

    out.push({
      id: `pubmed:publication:${pmid}`,
      section: "publications",
      kind: "publication",
      label: shortTitle || `PMID ${pmid}`,
      detail: [
        [journalFull || journal || book, year].filter(Boolean).join(", "),
        authors ? `Authors: ${authors}` : "",
        "Matched by author name only. PubMed cannot tell two authors with the same name apart, so check the title, journal and co-authors before you accept it.",
      ].filter(Boolean).join(". ").replace(/\.\./g, "."),
      fields,
      needs: [],
      source: src("pubmed", pubmedUrl(pmid), ctx),
      confidence: "lead",
    });
  }
  return out;
}

// ── Matching against what is already on file ────────────────────────────────
//
// It is not here. This function is never given the physician's records and
// must not be: matching a finding against what is already on file is the
// client's job, and lives in src/utils/publicRecord.js (dedupeKey,
// markAlreadyOnFile), tested by scripts/public-record-review.test.mjs.

// ── Envelope ────────────────────────────────────────────────────────────────

export interface RawBundle {
  nppes?: any;
  cmsClinician?: any;
  cmsAffiliation?: any;
  hospitals?: Record<string, any>;
  pubmedSummary?: any;
  pubmedTerm?: string;
  sources?: SourceReport[];
  errors?: Array<{ source: string; message: string }>;
}

/** Findings ordered the way the UI reads them: facts first, then leads. */
const SECTION_ORDER = ["settings", "licenses", "education", "workHistory", "privileges", "publications", "memberships"];

export function buildEnvelope(bundle: RawBundle, ctx: NormalizeContext) {
  const findings: Finding[] = [
    ...normalizeNppes(bundle.nppes, ctx),
    ...normalizeCmsClinician(bundle.cmsClinician, ctx),
    ...normalizeAffiliations(bundle.cmsAffiliation, bundle.hospitals || {}, ctx),
    ...normalizePubmed(bundle.pubmedSummary, ctx, bundle.pubmedTerm || ""),
  ];
  findings.sort((a, b) => {
    const s = SECTION_ORDER.indexOf(a.section) - SECTION_ORDER.indexOf(b.section);
    if (s !== 0) return s;
    if (a.confidence !== b.confidence) return a.confidence === "record" ? -1 : 1;
    return a.id.localeCompare(b.id);
  });
  return {
    npi: ctx.npi,
    fetchedAt: ctx.fetchedAt,
    findings,
    sources: bundle.sources || [],
    errors: bundle.errors || [],
  };
}
