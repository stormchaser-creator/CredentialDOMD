// The CME Passport reporting card: the details a CME provider needs before
// it can report a physician's credit into ACCME's PARS, and the birth month
// and day that is the one piece the app does not already hold.
// Run: node scripts/cme-passport.test.mjs
import {
  normalizeBirthday, formatBirthday, medicalLicenseFor, reportingCard,
} from "../src/utils/cmePassport.js";

let pass = 0, fail = 0;
const eq = (n, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) pass++; else { fail++; console.log(`FAIL ${n}\n   got  ${g}\n   want ${w}`); }
};

// ── normalizeBirthday ──────────────────────────────────────────────────────
eq("slashes", normalizeBirthday("7/25"), "07-25");
eq("already padded", normalizeBirthday("07-25"), "07-25");
eq("a month name", normalizeBirthday("July 25"), "07-25");
eq("an abbreviated month", normalizeBirthday("Jul 25"), "07-25");
eq("June and July are not confused", normalizeBirthday("Jun 25"), "06-25");
eq("day before the month name", normalizeBirthday("25 July"), "07-25");
eq("a leap day is a real birthday", normalizeBirthday("2/29"), "02-29");
eq("February 30 is not", normalizeBirthday("2/30"), "");
eq("a pasted full date drops the year", normalizeBirthday("07/25/1978"), "07-25");
eq("an ISO date drops the year", normalizeBirthday("1978-07-25"), "07-25");
eq("month 13 is refused", normalizeBirthday("13/01"), "");
eq("day 0 is refused", normalizeBirthday("7/0"), "");
eq("a month alone is refused", normalizeBirthday("July"), "");
eq("a bad month name is refused", normalizeBirthday("Smarch 3"), "");
eq("empty stays empty", normalizeBirthday(""), "");
eq("null stays empty", normalizeBirthday(null), "");
eq("whitespace is tolerated", normalizeBirthday("  7 / 25  "), "07-25");

eq("formatted for a human", formatBirthday("07-25"), "July 25");
eq("formatted from loose input", formatBirthday("7/25"), "July 25");
eq("nothing to format", formatBirthday(""), "");

// ── which license to hand over ─────────────────────────────────────────────
const licenses = [
  { id: "a", type: "Medical License", state: "AZ", licenseNumber: "AZ-1" },
  { id: "b", type: "Medical License", state: "CA", licenseNumber: "" },
  { id: "c", type: "Medical License", state: "CA", licenseNumber: "A98765" },
  { id: "d", type: "DEA Registration", state: "CA", licenseNumber: "BW000" },
];
eq("the primary state's numbered license wins",
  medicalLicenseFor({ licenses, settings: { primaryState: "CA" } })?.id, "c");
eq("a DEA registration is not a medical license",
  medicalLicenseFor({ licenses: [licenses[3]], settings: {} }), null);
eq("no licenses at all", medicalLicenseFor({ licenses: [], settings: {} }), null);
eq("a license with no state is skipped",
  medicalLicenseFor({ licenses: [{ type: "Medical License", state: "", licenseNumber: "X" }], settings: {} }), null);

// ── the card ───────────────────────────────────────────────────────────────
const full = reportingCard({
  licenses,
  settings: { name: "Dan Logsdon", degreeType: "MD", npi: "1234567890", primaryState: "CA", birthMonthDay: "07-25" },
});
eq("a complete card has nothing missing", full.missing.length, 0);
eq("complete says so", full.complete, true);
eq("the copied text", full.text, [
  "Name: Dan Logsdon, MD",
  "State of licensure: California (CA)",
  "State license number: A98765",
  "NPI: 1234567890",
  "Birth month and day: July 25",
  "I give permission to report this CME credit to the ACCME.",
].join("\n"));

const alreadyDegreed = reportingCard({
  licenses, settings: { name: "Dan Logsdon, MD", degreeType: "MD", npi: "1234567890", primaryState: "CA", birthMonthDay: "07-25" },
});
eq("the degree is not doubled", alreadyDegreed.text.split("\n")[0], "Name: Dan Logsdon, MD");

const npiOnly = reportingCard({
  licenses: [], settings: { name: "Dan Logsdon", npi: "1234567890", primaryState: "CA", birthMonthDay: "07-25" },
});
eq("the NPI alone satisfies the identifier", npiOnly.missing.map(m => m.key), []);
eq("and no empty license line is copied", npiOnly.text.includes("State license number"), false);

const licenseOnly = reportingCard({
  licenses: [licenses[2]], settings: { name: "Dan Logsdon", npi: "", primaryState: "CA", birthMonthDay: "07-25" },
});
eq("the license number alone satisfies it too", licenseOnly.missing.map(m => m.key), []);

const bare = reportingCard({ licenses: [], settings: {} });
eq("an empty account names every gap",
  bare.missing.map(m => m.key), ["name", "state", "licenseOrNpi", "birthday"]);
eq("and copies only the permission", bare.text, "I give permission to report this CME credit to the ACCME.");

const noBirthday = reportingCard({
  licenses, settings: { name: "Dan Logsdon", npi: "1234567890", primaryState: "CA" },
});
eq("the birthday is the usual gap", noBirthday.missing.map(m => m.key), ["birthday"]);
eq("every gap says how to close it", noBirthday.missing.every(m => m.fix && m.fix.length > 10), true);

const unknownState = reportingCard({
  licenses: [{ type: "Medical License", state: "ZZ", licenseNumber: "1" }],
  settings: { name: "A B", npi: "", birthMonthDay: "1/1" },
});
eq("an unmapped state code still prints", unknownState.fields.find(f => f.key === "state").value, "ZZ");

eq("no data at all does not throw", reportingCard(undefined).missing.length, 4);

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
