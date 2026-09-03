/**
 * POST /functions/v1/public-record
 *
 * Body: { npi: string, name?: string | { firstName, lastName }, state?: string,
 *         sources?: string[] }   sources defaults to all four
 * Auth: Required (any authenticated user).
 * Writes: none. This function only reads public registers and proposes.
 *
 * What the physician would otherwise type by hand already sits in public
 * registers. This fans out to them concurrently and returns a normalized
 * envelope of proposals:
 *
 *   nppes         NPPES NPI Registry: identity, credential, state licenses,
 *                 practice address (via _shared/nppes.ts, same call npi-proxy
 *                 makes for the browser)
 *   cms           Medicare "Doctors and Clinicians" mj5m-pzi6: graduation
 *                 year, specialty, practice organizations
 *   affiliations  Medicare facility affiliations 27ea-46a8, then Hospital
 *                 General Information xubh-q36u to turn each CCN into a name
 *   pubmed        E-utilities esearch + esummary, matched on author name
 *
 * data.cms.gov sends no CORS headers and PubMed rejects the preflight, so the
 * browser cannot call either of them directly; that is why they are here.
 *
 * Every upstream call has a timeout and its own try/catch. One dead register
 * degrades to an entry in `errors` and a source marked "error"; the request
 * still returns 200 with whatever the other registers gave.
 *
 * Nothing is saved here. Normalizing lives in normalize.ts (pure, tested by
 * scripts/public-record.test.mjs against captured fixtures).
 *
 * Deploy: supabase functions deploy public-record --no-verify-jwt --use-api
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { clerkProfile } from "../_shared/clerkAuth.ts";
import { fetchNppes } from "../_shared/nppes.ts";
import {
  buildEnvelope, pubmedAuthorTerm, clean,
  type Finding, type SourceReport,
} from "./normalize.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status, headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

const CMS_BASE = "https://data.cms.gov/provider-data/api/1/datastore/query";
const EUTILS = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils";
const UA = "CredentialDOMD/1.0 (+https://credentialdomd.com)";

const ALL_SOURCES = ["nppes", "cms", "affiliations", "pubmed"];
const TIMEOUT_MS = 12000;
/** PubMed matches on a name, so a common surname returns a long tail. */
const PUBMED_MAX = 25;

async function getJson(url: string, timeoutMs = TIMEOUT_MS): Promise<any> {
  const res = await fetch(url, {
    headers: { "User-Agent": UA, "Accept": "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`${new URL(url).hostname} returned ${res.status}`);
  return await res.json();
}

/** A data.cms.gov datastore query for one exact column value. */
function cmsQueryUrl(dataset: string, property: string, value: string, limit = 50): string {
  const p = new URLSearchParams();
  p.set("conditions[0][property]", property);
  p.set("conditions[0][value]", value);
  p.set("conditions[0][operator]", "=");
  p.set("limit", String(limit));
  return `${CMS_BASE}/${dataset}/0?${p.toString()}`;
}

/** Free-typed name to the first/last the registers search on. */
function splitName(full: string): { firstName: string; lastName: string } {
  const tails = /^(jr|sr|ii|iii|iv|md|do|phd|dds|dmd|mph|mba|facs|faans|rn|pa|np)\.?,?$/i;
  const raw = String(full || "").replace(/\s+/g, " ").trim();
  if (!raw) return { firstName: "", lastName: "" };
  const segs = raw.split(",").map((s) => s.trim()).filter(Boolean);
  const words = (s: string) => s.split(" ").map((t) => t.replace(/^[.,]+|[.,]+$/g, "").trim()).filter(Boolean);
  let tokens: string[];
  if (segs.length >= 2 && words(segs[0]).length === 1 && !words(segs[1]).every((t) => tails.test(t))) {
    tokens = [...words(segs[1]).filter((t) => !tails.test(t)), ...words(segs[0])];
  } else {
    tokens = words(segs[0]);
    while (tokens.length > 2 && tails.test(tokens[tokens.length - 1])) tokens.pop();
  }
  if (!tokens.length) return { firstName: "", lastName: "" };
  if (tokens.length === 1) return { firstName: "", lastName: tokens[0] };
  return { firstName: tokens[0], lastName: tokens[tokens.length - 1] };
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const user = await clerkProfile(req);
  if (!user) return json({ error: "Unauthorized" }, 401);

  let body: any = {};
  try {
    body = await req.json();
  } catch {
    return json({ error: "Body must be JSON" }, 400);
  }

  const npi = String(body?.npi || "").replace(/\D/g, "");
  if (npi.length !== 10) return json({ error: "npi must be 10 digits" }, 400);

  const wanted = new Set(
    Array.isArray(body?.sources) && body.sources.length
      ? body.sources.map((s: unknown) => String(s))
      : ALL_SOURCES,
  );
  const typedName = typeof body?.name === "string"
    ? splitName(body.name)
    : {
      firstName: clean(body?.name?.firstName),
      lastName: clean(body?.name?.lastName),
    };

  const fetchedAt = new Date().toISOString();
  const sources: SourceReport[] = [];
  const errors: Array<{ source: string; message: string }> = [];

  const report = (id: string, name: string, url: string, status: string, count: number, note?: string) => {
    sources.push({ id, name, url, fetchedAt, status, count, ...(note ? { note } : {}) });
  };
  const failed = (id: string, name: string, url: string, e: unknown) => {
    const message = e instanceof Error ? e.message : String(e);
    errors.push({ source: id, message });
    report(id, name, url, "error", 0, message);
  };

  // ── NPPES ────────────────────────────────────────────────────────────────
  const nppesTask = (async () => {
    if (!wanted.has("nppes")) return null;
    try {
      const res = await fetchNppes(`number=${npi}`, TIMEOUT_MS);
      if (!res.ok) throw new Error(`NPPES returned ${res.status}`);
      const data: any = res.data;
      report("nppes", "NPPES NPI Registry", `https://npiregistry.cms.hhs.gov/provider-view/${npi}`,
        "ok", Number(data?.result_count || 0));
      return data;
    } catch (e) {
      failed("nppes", "NPPES NPI Registry", `https://npiregistry.cms.hhs.gov/provider-view/${npi}`, e);
      return null;
    }
  })();

  // ── CMS Doctors and Clinicians ───────────────────────────────────────────
  const cmsTask = (async () => {
    if (!wanted.has("cms")) return null;
    const url = cmsQueryUrl("mj5m-pzi6", "NPI", npi);
    try {
      const data = await getJson(url);
      report("cmsClinician", "Medicare Care Compare (Doctors and Clinicians)",
        `https://www.medicare.gov/care-compare/details/physician/${npi}`, "ok", Number(data?.count || 0));
      return data;
    } catch (e) {
      failed("cmsClinician", "Medicare Care Compare (Doctors and Clinicians)",
        `https://www.medicare.gov/care-compare/details/physician/${npi}`, e);
      return null;
    }
  })();

  // ── Facility affiliations, then each CCN resolved to a hospital ──────────
  const affiliationTask = (async () => {
    if (!wanted.has("affiliations")) return { affiliations: null, hospitals: {} as Record<string, any> };
    const url = cmsQueryUrl("27ea-46a8", "npi", npi);
    let affiliations: any = null;
    try {
      affiliations = await getJson(url);
      report("cmsAffiliation", "Medicare Care Compare (facility affiliations)",
        `https://www.medicare.gov/care-compare/details/physician/${npi}`, "ok", Number(affiliations?.count || 0));
    } catch (e) {
      failed("cmsAffiliation", "Medicare Care Compare (facility affiliations)",
        `https://www.medicare.gov/care-compare/details/physician/${npi}`, e);
      return { affiliations: null, hospitals: {} as Record<string, any> };
    }

    const ccns = [...new Set(
      (Array.isArray(affiliations?.results) ? affiliations.results : [])
        .map((r: any) => clean(r?.facility_affiliations_certification_number))
        .filter(Boolean),
    )].slice(0, 25) as string[];

    const hospitals: Record<string, any> = {};
    const looked = await Promise.allSettled(
      ccns.map((ccn) => getJson(cmsQueryUrl("xubh-q36u", "facility_id", ccn, 1)).then((d) => [ccn, d] as const)),
    );
    let missed = 0;
    for (const r of looked) {
      if (r.status === "fulfilled") hospitals[r.value[0]] = r.value[1];
      else missed++;
    }
    // A CCN we could not name is still a real affiliation, so it is a note on
    // the source rather than a failure of the whole lookup.
    if (missed) {
      report("cmsHospital", "Medicare Hospital General Information",
        "https://data.cms.gov/provider-data/dataset/xubh-q36u", "partial", ccns.length - missed,
        `${missed} of ${ccns.length} facility numbers could not be named`);
    } else if (ccns.length) {
      report("cmsHospital", "Medicare Hospital General Information",
        "https://data.cms.gov/provider-data/dataset/xubh-q36u", "ok", ccns.length);
    }
    return { affiliations, hospitals };
  })();

  // ── PubMed ───────────────────────────────────────────────────────────────
  const pubmedTask = (async () => {
    if (!wanted.has("pubmed")) return { summary: null, term: "" };
    let name = typedName;
    if (!name.lastName) {
      // No name typed: take it from the registry rather than asking twice.
      const nppes: any = await nppesTask;
      const basic = nppes?.results?.[0]?.basic;
      name = { firstName: clean(basic?.first_name), lastName: clean(basic?.last_name) };
    }
    const term = pubmedAuthorTerm(name);
    if (!term) {
      report("pubmed", "PubMed", "https://pubmed.ncbi.nlm.nih.gov/", "skipped", 0,
        "No name to search on, so PubMed was not queried");
      return { summary: null, term: "" };
    }
    const searchUrl = `${EUTILS}/esearch.fcgi?db=pubmed&term=${encodeURIComponent(term)}`
      + `&retmode=json&retmax=${PUBMED_MAX}&sort=pub_date`;
    try {
      const search = await getJson(searchUrl);
      const ids: string[] = Array.isArray(search?.esearchresult?.idlist) ? search.esearchresult.idlist : [];
      const total = Number(search?.esearchresult?.count || 0);
      if (!ids.length) {
        report("pubmed", "PubMed", `https://pubmed.ncbi.nlm.nih.gov/?term=${encodeURIComponent(term)}`,
          "ok", 0, `No papers for ${term}`);
        return { summary: null, term };
      }
      const summary = await getJson(
        `${EUTILS}/esummary.fcgi?db=pubmed&id=${ids.join(",")}&retmode=json`,
      );
      report("pubmed", "PubMed", `https://pubmed.ncbi.nlm.nih.gov/?term=${encodeURIComponent(term)}`,
        "ok", ids.length,
        total > ids.length
          ? `${total} papers match ${term}; the ${ids.length} most recent are shown. Every match is by name only.`
          : `Matched on ${term}. Every match is by name only.`);
      return { summary, term };
    } catch (e) {
      failed("pubmed", "PubMed", `https://pubmed.ncbi.nlm.nih.gov/?term=${encodeURIComponent(term)}`, e);
      return { summary: null, term };
    }
  })();

  const [nppes, cmsClinician, affiliation, pubmed] = await Promise.all([
    nppesTask, cmsTask, affiliationTask, pubmedTask,
  ]);

  const envelope = buildEnvelope({
    nppes,
    cmsClinician,
    cmsAffiliation: affiliation.affiliations,
    hospitals: affiliation.hospitals,
    pubmedSummary: pubmed.summary,
    pubmedTerm: pubmed.term,
    sources,
    errors,
  }, { npi, fetchedAt });

  // An empty result after a register failed is not the same as an empty
  // result, and must never read like "there is nothing about you out there".
  const findings: Finding[] = envelope.findings;
  if (!findings.length && errors.length) {
    return json({
      ...envelope,
      message: `${errors.length} of ${sources.length} registers did not answer, so nothing came back. Try again in a minute.`,
    });
  }
  return json(envelope);
});
