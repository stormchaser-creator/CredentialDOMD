// State controlled substance registrations a physician holds apart from the
// medical license (and apart from the federal DEA registration).
//
// Only what an official state page or statute, read on 2026-11-18, states:
// every entry carries the page (`sourceUrl`) and a short quote from it.
// A fixed expiration rule is encoded (`expires`) only where the page names
// the day and the years; anything else is the registration's own date, which
// the physician types from the certificate.
//
// Shapes:
//   expires: { month, day, everyYears, years?: "odd" }
//     the next expiration is that month and day in the next year that fits
//     (every year, or every second year in odd years). A rule whose years the
//     page does not name (Wyoming: June 30, biennial) has no `expires`, only
//     `expiryRule` text: the app cannot tell 2027 from 2028.
//   hardStop: text for a date after which the registration cannot be renewed.
//   prerequisites: steps the page requires before issue or renewal (the
//     state PDMP), shown on the prompt and beside the record.
//   renewsWithLicense: true where the page says the registration is renewed
//     as part of the practitioner license renewal.
//
// Researched and NOT encoded (no official page could be read in the session,
// or the page did not state the rule): Massachusetts (MCSR; mass.gov returned
// 403), Michigan (LARA controlled substance license; michigan.gov returned
// 403), New Jersey (CDS registration; no Drug Control Unit page stating it),
// Rhode Island (no health.ri.gov page found), New Mexico, District of
// Columbia. They stay out until their own page is read.

export const STATE_CSR_CHECKED = "2026-11-18";

/** The record type the app files a state registration under (credentialTypes.js). */
export const STATE_CSR_TYPE = "State Controlled Substance";

export const STATE_CSR = {
  AL: {
    name: "Alabama Controlled Substances Certificate (ACSC)", short: "ACSC",
    agency: "Alabama Board of Medical Examiners",
    who: "Physicians who prescribe, dispense or distribute controlled substances in Alabama",
    cadence: "Every year",
    expires: { month: 12, day: 31, everyYears: 1 },
    expiryRule: "Renewed every year on or before December 31",
    prerequisites: ["Register to query the Alabama Prescription Drug Monitoring Program before you renew"],
    renewalUrl: "https://dashboard.albme.gov",
    sourceUrl: "https://www.albme.gov/licensing/md-do/registrations/acsc/",
    // "ACSCs are renewed annually on or before Dec. 31 through the Licensee Gateway."
    // Renewal requires being "registered to query the Prescription Drug Monitoring Databank".
    quote: "ACSCs are renewed annually on or before Dec. 31",
  },
  CT: {
    name: "Connecticut Controlled Substance Registration for Practitioners", short: "CT CSR",
    agency: "Connecticut Department of Consumer Protection, Drug Control Division",
    who: "Practitioners who prescribe controlled substances in Connecticut",
    cadence: "Every two years",
    expires: { month: 2, day: 28, everyYears: 2, years: "odd" },
    expiryRule: "Expires February 28 of odd-numbered years",
    prerequisites: [],
    renewalUrl: "https://www.elicense.ct.gov",
    sourceUrl: "https://portal.ct.gov/dcp/knowledge-base/articles/drug-control/licenses/csp-faqs/when-does-it-expire",
    quote: "expires every two years on February 28th of odd numbered years",
  },
  DE: {
    name: "Delaware Controlled Substance Registration (CSR)", short: "DE CSR",
    agency: "Delaware Division of Professional Regulation, Office of Controlled Substances",
    who: "Practitioners who prescribe or dispense controlled substances in Delaware",
    cadence: "Every two years",
    expires: { month: 6, day: 30, everyYears: 2, years: "odd" },
    expiryRule: "Expires June 30 of odd-numbered years",
    // The renewal asks for an attestation of two hours of CE (renewal page;
    // 24 Del. Admin. Code Uniform Controlled Substances Act Regs. 3.1.3).
    renewalNote: "At each renewal you attest to 2 hours of continuing education in controlled substance prescribing, chronic pain or related topics.",
    prerequisites: [],
    renewalUrl: "https://delpros.delaware.gov",
    sourceUrl: "https://dpr.delaware.gov/boards/controlledsubstances/renewal",
    quote: "Controlled Substance registrations expire on June 30 of odd years.",
  },
  HI: {
    name: "Hawaii Controlled Substance Registration", short: "HI CS registration",
    agency: "Hawaii Department of Law Enforcement, Narcotics Enforcement Division",
    who: "Practitioners who prescribe, distribute or dispense controlled substances in Hawaii",
    cadence: null,
    expiryRule: "Its own expiration date; a renewal received after that date owes a late fee",
    prerequisites: [],
    renewalUrl: null,
    sourceUrl: "https://law.hawaii.gov/wp-content/uploads/2025/09/CS-reg-app_eff-01-01-24-1.pdf",
    quote: "MUST BE RECEIVED IN OUR OFFICE BY EXPIRATION DATE OR A LATE FEE WILL BE CHARGED",
  },
  IA: {
    name: "Iowa Controlled Substances Act (CSA) Registration", short: "IA CSA",
    agency: "Iowa Board of Pharmacy",
    who: "Practitioners who prescribe controlled substances to Iowa patients",
    cadence: "Every two years",
    expiryRule: "Its own expiration date, renewed every two years",
    prerequisites: ["Register with the Iowa Prescription Monitoring Program where your practice requires it; until then a new registration shows Pending PMP"],
    renewalUrl: "https://ibop.igovsolution.net/online/User_login.aspx",
    sourceUrl: "https://dial.iowa.gov/licenses/medical/pharmacy/controlled-substances-act-registrations-csa",
    quote: "$90 (Initial and biennial renewal fee)",
  },
  ID: {
    name: "Idaho Controlled Substance Registration (CSR)", short: "ID CSR",
    agency: "Idaho Board of Pharmacy (DOPL)",
    who: "Practitioners who prescribe, administer, order or store controlled substances in Idaho",
    cadence: null,
    expiryRule: "Its own expiration date",
    prerequisites: ["Create an Idaho PDMP (AWARxE) account, unless you already have an active one"],
    renewalUrl: "https://edopl.idaho.gov/OnlineServices/",
    sourceUrl: "https://dopl.idaho.gov/bop/bop-practitioner-controlled-substance-registration",
    quote: "required for practitioners who will prescribe, administer, order or store controlled substances",
  },
  IL: {
    name: "Illinois Physician Controlled Substance License", short: "IL CS license",
    agency: "Illinois Department of Financial and Professional Regulation",
    who: "Physicians who prescribe controlled substances in Illinois",
    cadence: null,
    expiryRule: "Its own expiration date. IDFPR lists it beside the physician license for renewal (the 2026 deadline for both was extended to August 31, 2026)",
    prerequisites: [],
    renewalUrl: "https://idfpr.illinois.gov/profs/physicians.html",
    sourceUrl: "https://idfpr.illinois.gov/profs/physicians.html",
    quote: "Physician and Surgeon and Licensed Physician Controlled Substance",
  },
  IN: {
    name: "Indiana Controlled Substance Registration (CSR)", short: "IN CSR",
    agency: "Indiana Professional Licensing Agency",
    who: "Physicians who handle controlled substances in Indiana",
    cadence: null,
    expiryRule: "Its own expiration date; renewal needs an active Indiana practitioner license",
    prerequisites: [],
    renewalUrl: "https://mylicense.in.gov/eGov/ML1PLA.html",
    sourceUrl: "https://secure.in.gov/pla/professions/controlled-substance-registration",
    quote: "In order to renew your CSR, your Primary Indiana Practitioner License must be Active.",
  },
  LA: {
    name: "Louisiana CDS License", short: "LA CDS",
    agency: "Louisiana Board of Pharmacy",
    who: "Practitioners who procure, possess or prescribe controlled dangerous substances in Louisiana",
    cadence: null,
    expiryRule: "Its own expiration date; a late fee applies more than 30 days after it",
    prerequisites: [],
    renewalUrl: null,
    sourceUrl: "https://www.pharmacy.la.gov/assets/docs/Forms/102---Appl-for-Renewal-of-CDS-License---Practitioners--2024-0301.pdf",
    quote: "more than 30 days after expiration date of CDS license",
  },
  MD: {
    name: "Maryland CDS Registration", short: "MD CDS",
    agency: "Maryland Department of Health, Office of Controlled Substances Administration",
    who: "Practitioners who prescribe controlled dangerous substances in Maryland",
    cadence: "Every three years",
    expiryRule: "Its own expiration date, a 3-year registration",
    prerequisites: ["Register with the Maryland PDMP through CRISP before a new or renewed CDS registration"],
    renewalUrl: null,
    sourceUrl: "https://health.maryland.gov/ocsa/Documents/3%20Year%20Practitioner%20Fill-Able%20Application%206-4-2026.pdf",
    quote: "must register with the Prescription Drug Monitoring Program (PDMP) prior to obtaining a new or renewal CDS Registration",
  },
  MO: {
    name: "Missouri BNDD Controlled Substance Registration", short: "MO BNDD",
    agency: "Missouri Bureau of Narcotics and Dangerous Drugs",
    who: "Practitioners who prescribe or dispense controlled substances in Missouri",
    cadence: "Every year",
    expiryRule: "Valid 12 months; expires on the last day of the month assigned to it",
    prerequisites: [],
    renewalUrl: null,
    sourceUrl: "https://www.sos.mo.gov/cmsimages/adrules/csr/current/19csr/19c30-1.pdf",
    // 19 CSR 30-1.017(2)(A)-(B).
    quote: "current and effective for twelve (12) months from the date issued",
  },
  NV: {
    name: "Nevada Controlled Substance Registration", short: "NV CS registration",
    agency: "Nevada State Board of Pharmacy",
    who: "Practitioners who dispense or prescribe controlled substances in Nevada",
    cadence: "Every two years",
    expiryRule: "Its own expiration date, renewed every two years",
    prerequisites: ["Show proof of access to the Nevada Prescription Monitoring Program before the registration is issued or renewed"],
    // NRS 453.164(7): no starting day is stated, so the app keeps it as text.
    recurringNote: "If you prescribe Schedule II to V controlled substances, review your PMP information and verify your continued access at least once every 6 months.",
    renewalUrl: null,
    sourceUrl: "https://www.leg.state.nv.us/NRS/NRS-453.html",
    // NRS 453.226(1); NRS 453.164(7).
    quote: "shall obtain biennially a registration issued by the Board",
  },
  OK: {
    name: "Oklahoma OBN Registration", short: "OBN",
    agency: "Oklahoma Bureau of Narcotics and Dangerous Drugs Control",
    who: "Registrants who prescribe or handle controlled substances in Oklahoma",
    cadence: "Every year",
    expires: { month: 10, day: 31, everyYears: 1 },
    expiryRule: "Renewals open July 1 and expire October 31",
    hardStop: "Not renewed by December 31, the registration becomes permanently inactive and a new application is needed.",
    prerequisites: [],
    renewalUrl: null,
    sourceUrl: "https://content.govdelivery.com/accounts/OKBNDD/bulletins/3d08952",
    quote: "OBN Registration renewals shall open July 1st annually.",
  },
  SC: {
    name: "South Carolina Controlled Substances Registration", short: "SC CSR",
    agency: "South Carolina Department of Public Health, Bureau of Drug Control",
    who: "MDs and DOs who prescribe controlled substances in South Carolina",
    cadence: null,
    expiryRule: "MDs and DOs renew by October 1; there is no grace period",
    prerequisites: [],
    renewalUrl: "https://dph.sc.gov/professionals/healthcare-quality/drug-control-register-verify/drug-control-renewals",
    sourceUrl: "https://dph.sc.gov/professionals/healthcare-quality/drug-control-register-verify/drug-control-renewals",
    quote: "October 1: MDs, DOs and EMS Units",
  },
  SD: {
    name: "South Dakota Controlled Substance Registration", short: "SD CSR",
    agency: "South Dakota Department of Health",
    who: "Practitioners who dispense, administer or prescribe controlled substances in South Dakota",
    cadence: null,
    expiryRule: "Its own expiration date",
    prerequisites: ["Register with the South Dakota Prescription Drug Monitoring Program (MD and DO prescribers)"],
    renewalUrl: "https://apps.sd.gov/PH04ControlledSubstance/",
    sourceUrl: "https://doh.sd.gov/healthcare-professionals/health-facility-licensure/controlled-substance-registration/",
    quote: "must have a South Dakota Controlled Substance Registration and federal Drug Enforcement Administration registration",
  },
  UT: {
    name: "Utah Controlled Substance License", short: "UT CS license",
    agency: "Utah Division of Professional Licensing (DOPL)",
    who: "Practitioners who prescribe controlled substances in Utah",
    cadence: null,
    renewsWithLicense: true,
    expiryRule: "Renewed as part of your Utah practitioner license renewal",
    prerequisites: [],
    renewalUrl: "https://commerce.utah.gov/dopl/controlled-substance/renew-a-license/",
    sourceUrl: "https://commerce.utah.gov/dopl/controlled-substance/renew-a-license/",
    quote: "renewed as part of the associated practitioner license renewal",
  },
  WY: {
    name: "Wyoming Controlled Substance Registration", short: "WY CSR",
    agency: "Wyoming Board of Pharmacy",
    who: "All practitioners who prescribe controlled substances in Wyoming",
    cadence: "Every two years",
    // The page names June 30 and a two-year cycle but not which years.
    expiryRule: "Expires June 30, renewed every two years",
    prerequisites: [],
    renewalUrl: "https://pharmacyboard.wyo.gov/licensing/controlled-substance-reg",
    sourceUrl: "https://pharmacyboard.wyo.gov/licensing/controlled-substance-reg",
    quote: "expires on June 30 and is renewed biennially (every two years)",
  },
};
