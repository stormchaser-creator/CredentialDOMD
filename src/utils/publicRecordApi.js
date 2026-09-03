/**
 * The one call to supabase/functions/public-record.
 *
 * Separate from publicRecord.js so that module stays pure and node can run
 * its tests: importing the Supabase client pulls in import.meta.env, which a
 * plain node test has no answer for.
 *
 * The function reads public registers and returns proposals. It never writes,
 * and nothing here writes either.
 */

import { supabase } from "../lib/supabase";
import { invokeFn } from "./edgeError";

/**
 * @param {object} opts
 * @param {string} opts.npi     10 digits
 * @param {string} [opts.name]  the name on file, so PubMed can be searched
 *                              even when NPPES is the register that is down
 * @param {string[]} [opts.sources]  a subset to ask again after a failure;
 *                              omitted asks all four
 * @returns {Promise<{ok: boolean, envelope: object|null, message: string}>}
 */
export async function fetchPublicRecord({ npi, name, sources } = {}) {
  const digits = String(npi || "").replace(/\D/g, "");
  if (digits.length !== 10) {
    return { ok: false, envelope: null, message: "That NPI is not 10 digits." };
  }
  if (!supabase) {
    return { ok: false, envelope: null, message: "The app is not connected to the server on this build." };
  }
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    return { ok: false, envelope: null, message: "The registers need a connection. Try again once you are back online." };
  }
  const body = { npi: digits };
  if (name) body.name = name;
  if (Array.isArray(sources) && sources.length) body.sources = sources;

  const res = await invokeFn(supabase, "public-record", { body });
  if (!res.ok) {
    return {
      ok: false,
      envelope: null,
      message: res.message || "The registers did not answer. Try again in a minute.",
    };
  }
  return { ok: true, envelope: res.data || null, message: res.data?.message || "" };
}
