/**
 * ACCME CME Passport (cmepassport.org).
 *
 * There is no API to connect to, and the reason is written down here so it
 * does not have to be rediscovered:
 *
 *  - CME Passport publishes no public API. A physician's transcript sits
 *    behind their own login (/profile/transcripts is a 404 to anyone signed
 *    out). The activity search at /activity/search is public.
 *  - PARS, the system behind it, does have web services
 *    (parsii.accme.org/services/ACCMELearnerService.svc/...), but every call
 *    carries a ProviderId plus a user and password ACCME issues to an
 *    ACCREDITED CME PROVIDER, and the operations are SaveActivity,
 *    GetActivity, SaveLearnerActivity, GetLearnerMatch and the
 *    GetLearnerStatus calls. The status calls answer "did the credit I
 *    submitted match a learner" for the submitting provider's own
 *    ActivityId. None of them reads a physician's transcript.
 *    (ACCME PARS Provider Web Services Resources, 715_20250610, read
 *    2026-09-03.)
 *  - ACCME's terms forbid doing it the other way: "Use of any automated
 *    system or software, whether operated by a third party or otherwise, to
 *    extract data from the Websites (such as screen scraping, crawling,
 *    reproducing, duplicating, copying, selling, trading or reselling) is
 *    prohibited."
 *
 * So the connection runs through the two ends the physician controls. Coming
 * back, the transcript they export is already read directly by cmeImport.js
 * (source "cmepassport-pdf"). Going out is the half this module builds: the
 * identifiers a CME provider needs before it can report their credit into
 * PARS at all, which is why most transcripts are emptier than they should be.
 *
 * ACCME tells providers what to collect: the learner's "name, state of
 * licensure, state license number or national provider identifier (NPI) and
 * the month and day of their birth, as well as their permission to report
 * their credit." The birth YEAR is not asked for, so it is not stored.
 */

import { STATE_NAMES } from "../constants/states.js";

export const CME_PASSPORT_HOME = "https://www.cmepassport.org/";
export const CME_PASSPORT_LOGIN = "https://www.cmepassport.org/login";
export const CME_PASSPORT_SEARCH = "https://www.cmepassport.org/activity/search";

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

// No year is stored, so February has 29 days: a physician born on a leap day
// still has a birth month and day, and refusing it would be the bug.
const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/**
 * Read a birth month and day in any of the shapes a person types it, and
 * return "MM-DD", or "" when it cannot be read. A four-digit group is treated
 * as a year and dropped: the field never holds one, and someone pasting a
 * full date of birth should not silently get a wrong answer.
 */
export function normalizeBirthday(input) {
  const raw = String(input ?? "").trim();
  if (!raw) return "";

  let month = 0;
  let day = 0;

  const word = raw.match(/[A-Za-z]{3,}/);
  if (word) {
    const key = word[0].toLowerCase().slice(0, 3);
    const idx = MONTHS.findIndex(m => m.toLowerCase().slice(0, 3) === key);
    if (idx < 0) return "";
    month = idx + 1;
    const days = raw.match(/\d{1,2}(?!\d)/);
    if (!days) return "";
    day = Number(days[0]);
  } else {
    const groups = raw.match(/\d+/g) || [];
    const parts = groups.filter(g => g.length !== 4).map(Number);
    if (parts.length < 2) return "";
    [month, day] = parts;
  }

  if (!(month >= 1 && month <= 12)) return "";
  if (!(day >= 1 && day <= DAYS_IN_MONTH[month - 1])) return "";
  return `${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** "07-25" to "July 25". Anything unreadable comes back as "". */
export function formatBirthday(mmdd) {
  const norm = normalizeBirthday(mmdd);
  if (!norm) return "";
  const [m, d] = norm.split("-").map(Number);
  return `${MONTHS[m - 1]} ${d}`;
}

/**
 * The state medical license a CME coordinator should be given. Prefers the
 * physician's primary state, then any license that actually carries a
 * number, because a state without a number is half an answer.
 */
export function medicalLicenseFor(data) {
  const licenses = (data?.licenses || []).filter(
    l => l && l.state && /medical license/i.test(l.type || ""),
  );
  if (!licenses.length) return null;
  const primary = data?.settings?.primaryState;
  const rank = (l) => (l.state === primary ? 0 : 2) + (l.licenseNumber ? 0 : 1);
  return [...licenses].sort((a, b) => rank(a) - rank(b))[0];
}

function nameWithDegree(settings) {
  const name = String(settings?.name || "").trim();
  if (!name) return "";
  const deg = settings?.degreeType;
  if (!deg) return name;
  return new RegExp(`,?\\s*${deg}\\b`, "i").test(name) ? name : `${name}, ${deg}`;
}

/**
 * Everything a CME provider needs in order to report a credit into PARS, in
 * the order ACCME lists it, with the fields that are not on file named
 * rather than left blank. `text` is what gets copied; it carries only the
 * lines that have a value, and always the permission sentence, because the
 * permission is part of what ACCME requires and is the physician's to give.
 */
export function reportingCard(data) {
  const s = data?.settings || {};
  const lic = medicalLicenseFor(data);
  const state = lic?.state || s.primaryState || "";
  const licenseNumber = lic?.licenseNumber || "";
  const npi = String(s.npi || "").replace(/\D/g, "");
  const birthday = formatBirthday(s.birthMonthDay);

  const fields = [
    { key: "name", label: "Name", value: nameWithDegree(s), fix: "Add your name in Settings." },
    {
      key: "state",
      label: "State of licensure",
      value: state ? (STATE_NAMES[state] ? `${STATE_NAMES[state]} (${state})` : state) : "",
      fix: "Add a state medical license, or set your primary state in Settings.",
    },
    {
      key: "licenseNumber",
      label: "State license number",
      value: licenseNumber,
      fix: "Add the number to your state medical license.",
    },
    { key: "npi", label: "NPI", value: npi, fix: "Find your NPI in Settings." },
    {
      key: "birthday",
      label: "Birth month and day",
      value: birthday,
      fix: "Add your birth month and day in Settings. The year is never asked for.",
    },
  ];

  const have = (key) => fields.find(f => f.key === key)?.value;
  const missing = [];
  if (!have("name")) missing.push(fields[0]);
  if (!have("state")) missing.push(fields[1]);
  // ACCME accepts the state license number OR the NPI, so only the absence of
  // both is a gap.
  if (!have("licenseNumber") && !have("npi")) {
    missing.push({
      key: "licenseOrNpi",
      label: "State license number or NPI",
      value: "",
      fix: "Add your NPI in Settings, or the number on your state medical license. Either one works.",
    });
  }
  if (!have("birthday")) missing.push(fields[4]);

  const text = [
    ...fields.filter(f => f.value).map(f => `${f.label}: ${f.value}`),
    "I give permission to report this CME credit to the ACCME.",
  ].join("\n");

  return { fields, missing, text, complete: missing.length === 0 };
}
