// AOA / AMA credit equivalence: the single source of truth for what a logged
// credit type actually counts as.
//
// Why this file exists: a DO logs "AMA PRA Category 1" from an ACCME-accredited
// provider (OpenEvidence, UpToDate, Medscape) and the app gave no way to see
// that the credit lands in AOA Category 2 and can never satisfy California's
// 20-hour AOA Category 1-A/1-B minimum. A physician could log 50 hours of it
// and still fail a California audit. Every equivalence claim in the app now
// reads from this table instead of a string check written at the call site.
//
// TWO LEDGERS, NEVER SUMMED:
//   1. AOA board certification and AOA membership accounting.
//   2. State licensure.
// The AOA's own requirements-by-board table carries the disclaimer that its
// requirements are "for the purpose of AOA Board Certification only. It is the
// responsibility of the individual physician to stay informed of their CME
// requirements for state licensure." [aoaByBoard]
//
// THE ONE RULE THAT DECIDES EVERYTHING: modality decides the letter, not the
// accreditor. An ACCME-accredited AMA PRA Category 1 activity is AOA Category
// 2-A when it is live or real-time interactive, and 2-B when it is journal-type,
// home study, or non-interactive on-demand internet CME. It is never 1-A on its
// own. [aoaCat1BForm, aoaActivityDescriptions]
//
// Researched 2026-08 against primary AOA and OMBC sources. Every row cites the
// SOURCES ids it came from.

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------
export const SOURCES = {
  aoaActivityDescriptions: {
    label: "AOA, 2025-2027 Certification CME Cycle: CME Category & Activity Descriptions",
    url: "https://osteopathic.org/wp-content/uploads/CME-Activity-Descriptions.pdf",
    kind: "primary",
  },
  aoaCat1BForm: {
    label: "AOA, Formal Request for AOA Category 1-B Credit for Non-Osteopathic Programs",
    url: "https://osteopathic.org/wp-content/uploads/Request-for-AOA-Category-1-B-Credit.pdf",
    kind: "primary",
    quote: "The AOA awards AOA Category 2A for all ACCME accredited provider AMA PRA Category 1 Credit and AAFP CME programs. No form is needed to claim credit for those CME Courses.",
  },
  aoaReporting: {
    label: "AOA, CME Reporting Instructions",
    url: "https://osteopathic.org/wp-content/uploads/CME-Reporting-Instructions.pdf",
    kind: "primary",
  },
  aoaFaqs: {
    label: "AOA, CME FAQs",
    url: "https://osteopathic.org/cme/cme-faqs/",
    kind: "primary",
  },
  aoaByBoard: {
    label: "AOA, 2025-27 CME Requirements by Specialty Board",
    url: "https://osteopathic.org/wp-content/uploads/CME-Requirements-by-Specialty-Board.pdf",
    kind: "primary",
  },
  aoaPolicies: {
    label: "AOA, CME Policies (current cycle Jan 1 2025 through Dec 31 2027)",
    url: "https://osteopathic.org/cme/cme-policies/",
    kind: "primary",
  },
  aoaGuide1618: {
    label: "AOA, CME Guide for Osteopathic Physicians 2016-2018",
    url: "https://dcomcme.lmunet.edu/sites/default/files/cme-guide-2016-2018.pdf",
    kind: "primary",
    note: "Most recent verbatim text of the fewer-than-300 small-specialty policy that could be retrieved. The 2025-2027 guide did not resolve.",
  },
  aoaGuide1921: {
    label: "AOA, CME Guide for Osteopathic Physicians 2019-2021",
    url: "https://cdn.ymaws.com/www.opsc.org/resource/resmgr/cme_files/cme-guide-2019-2021.pdf",
    kind: "primary",
    note: "Broader than the current table: residency as well as fellowship, AOA-accredited as well as ACGME. Treat those extras as unconfirmed for 2025-2027.",
  },
  ombcCme: {
    label: "Osteopathic Medical Board of California, Continuing Medical Education, effective October 1 2025",
    url: "https://www.ombc.ca.gov/licensees/cme.pdf",
    kind: "primary",
    quote: "The Board must accept CME as it is reported on the certificate. If it is listed as AMA, it will count as AOA category 2.",
  },
  ombcProposed: {
    label: "OMBC, proposed regulatory language for 16 CCR 1635 et seq., dated August 15 2024",
    url: "https://www.ombc.ca.gov/laws_regulations/cme_cite_proposed_text.pdf",
    kind: "primary",
  },
  bpc2454_5: {
    label: "Cal. Bus. & Prof. Code section 2454.5 (50 hours per two years, 20 in AOA Category 1)",
    url: "https://law.justia.com/codes/california/2021/code-bpc/division-2/chapter-5/article-21/section-2454-5/",
    kind: "primary",
  },
  aobsNeuro: {
    label: "American Osteopathic Board of Surgery, Primary Certification in Neurological Surgery",
    url: "https://certification.osteopathic.org/surgery/certification-process-overview/neurological-surgery/",
    kind: "primary",
    note: "There is no American Osteopathic Board of Neurological Surgery. Osteopathic neurological surgery is a primary certification issued by AOBS.",
  },
  boardVitals: {
    label: "BoardVitals, How to Find AOA Category 1-A Credits for Osteopathic Specialties",
    url: "https://www.boardvitals.com/blog/how-to-find-aoa-category-1-a-credits/",
    kind: "secondary",
    note: "CME vendor reproducing the AOA qualifying-specialty list. Sole source naming Neurological Surgery. The AOA's own current list could not be retrieved.",
  },
  akh: {
    label: "AKH Inc., Advancing Knowledge in Healthcare, Accreditations",
    url: "https://akhcme.com/content/accreditations",
    kind: "primary",
    note: "Jointly accredited by ACCME, ACPE and ANCC. No AOA accreditation listed.",
  },
  openEvidence: {
    label: "OpenEvidence, Education Platform launch announcement, July 28 2026",
    url: "https://www.openevidence.com/announcements/openevidence-launches-new-education-platform-offering-continuing-education-ce-and-maintenance-of-certification-moc-credit",
    kind: "primary",
  },
};

export const CREDIT_EQUIVALENCE_META = {
  researched: "2026-08",
  cycle: "AOA 2025-2027 certification CME cycle (Jan 1 2025 through Dec 31 2027)",
  method: "primary-source read of the AOA activity descriptions, the AOA Category 1-B request form, AOA reporting instructions, the AOA by-board table, and the OMBC CME document effective Oct 1 2025",
};

// ---------------------------------------------------------------------------
// The four AOA categories and the test that decides each one
// ---------------------------------------------------------------------------
export const AOA_CATEGORIES = [
  {
    code: "1-A",
    label: "AOA Category 1-A",
    definingTest: "Sponsored by an AOA-accredited Category 1 CME sponsor AND delivered face to face, or as interactive internet CME where asynchronous instructor responses arrive within 48 hours. Plus an enumerated list of osteopathic professional activities that are 1-A regardless of sponsor type.",
    grantedHourForHour: true,
    sources: ["aoaActivityDescriptions"],
  },
  {
    code: "1-B",
    label: "AOA Category 1-B",
    definingTest: "Osteopathic sponsorship or osteopathic professional activity, but not a live interactive program. Also the landing category for non-osteopathic specialty programs converted by the Council on Continuing Medical Education on written request.",
    grantedHourForHour: true,
    sources: ["aoaActivityDescriptions"],
  },
  {
    code: "2-A",
    label: "AOA Category 2-A",
    definingTest: "Formal non-osteopathic CME that is live or real-time interactive: an ACCME-accredited provider's AMA PRA Category 1 program, an AAFP-approved program, or an AOA-accredited sponsor's program that fails the 1-A faculty and hours test.",
    grantedHourForHour: true,
    sources: ["aoaActivityDescriptions", "aoaCat1BForm"],
  },
  {
    code: "2-B",
    label: "AOA Category 2-B",
    definingTest: "Non-osteopathic and not live: home study, journal reading, and non-interactive on-demand internet CME, including ACCME-accredited AMA PRA Category 1 content delivered that way.",
    grantedHourForHour: true,
    sources: ["aoaActivityDescriptions"],
  },
];

export const AOA_CATEGORY_BY_CODE = Object.fromEntries(AOA_CATEGORIES.map(c => [c.code, c]));

// Delivery modality is the field that decides 2-A versus 2-B.
export const MODALITY = {
  live: "Face to face",
  liveOnline: "Real-time interactive online",
  onDemand: "On demand, journal-type, or home study",
  any: "Any delivery",
};

// ---------------------------------------------------------------------------
// The equivalence table
//
// `appCategory` is the exact string the CME entry form stores in `category`
// (see CME_CATEGORIES_DO / CME_CATEGORIES_MD in credentialTypes.js). Rows with
// appCategory: null are real AOA activities that are not selectable categories;
// they are here so the table is complete and so the reference UI can show them.
//
// `default: true` marks the row used when the physician has told us nothing
// about delivery modality.
// ---------------------------------------------------------------------------
export const CREDIT_EQUIVALENCE = [
  // ── ACCME / AMA PRA Category 1, by modality ──────────────────────────────
  {
    id: "amaCat1Live",
    appCategory: "AMA PRA Category 1",
    modality: "live",
    default: true,
    creditType: "AMA PRA Category 1 Credit, ACCME-accredited provider, formal face-to-face program",
    aoaCategory: "2-A",
    satisfies: [
      "The AOA total credit requirement (AOBS: 60 credits per 3-year cycle for time-limited diplomates and non-time-limited diplomates in OCC, 120 for non-time-limited diplomates not in OCC).",
      "California DO: the 50-hour total, inside the 30-hour Category 2 allowance.",
      "Colorado: counts directly toward all 30 accepted hours.",
      "Eligible for CCME conversion to AOA Category 1-B on written request when no equivalent osteopathic course content exists.",
    ],
    doesNotSatisfy: [
      "Any AOA Category 1-A or 1-B minimum.",
      "California's 20-hour AOA Category 1-A/1-B minimum.",
      "Arizona DO's 24-hour Category 1-A minimum, Washington DO's 60-hour Category 1-A minimum.",
    ],
    reporting: "Category 2 is never auto-posted. AOA-accredited Category 1 sponsors report Category 1 to the AOA within 90 days; Category 2 is the physician's own burden, self-reported through the AOA physician portal or by emailing the certificate with the AOA number to memberservice@osteopathic.org. Unreported AMA credit does not exist in the AOA's records.",
    sources: ["aoaCat1BForm", "aoaActivityDescriptions", "aoaReporting", "ombcCme"],
  },
  {
    id: "amaCat1LiveOnline",
    appCategory: "AMA PRA Category 1",
    modality: "liveOnline",
    creditType: "AMA PRA Category 1 Credit, ACCME provider, real-time interactive online (live webinar)",
    aoaCategory: "2-A",
    satisfies: [
      "Same as a face-to-face AMA PRA Category 1 program. The AOA activity table states real-time interactive internet CME from an AMA PRA Category 1 or AAFP sponsor will count as Category 2-A.",
    ],
    doesNotSatisfy: [
      "Any AOA Category 1 minimum, including California's 20 hours.",
    ],
    reporting: "Self-report to the AOA. See amaCat1Live.",
    sources: ["aoaActivityDescriptions"],
  },
  {
    id: "amaCat1OnDemand",
    appCategory: "AMA PRA Category 1",
    modality: "onDemand",
    creditType: "AMA PRA Category 1 Credit, ACCME provider, on-demand, non-interactive or journal-type internet CME (OpenEvidence, UpToDate, most point-of-care CME)",
    aoaCategory: "2-B",
    aoaCategoryAmbiguous: true,
    aoaCategoryNote: "The written AOA activity table puts non-interactive on-demand internet CME in 2-B. The AOA's own reporting form posts all ACCME AMA PRA Category 1 as 2-A without qualification. Point-of-care products sit in that gap.",
    satisfies: [
      "California DO: the 30-hour Category 2 allowance, which pools 2-A and 2-B, so the 2-A versus 2-B ambiguity does not change any California number.",
      "The AOA total credit requirement.",
    ],
    doesNotSatisfy: [
      "Any AOA Category 1 minimum.",
      "The 2-A to 1-B conversion form, which states home study courses are not applicable.",
      "Subject to the AOA's combined 50 percent cap covering journal reading, home study and non-interactive internet CME.",
    ],
    flagWhen: "A state or board caps Category 2-B specifically. There the ambiguity is load-bearing and the app should flag rather than assume.",
    reporting: "Self-report to the AOA. See amaCat1Live.",
    sources: ["aoaActivityDescriptions", "aoaCat1BForm", "ombcCme"],
  },

  // ── AAFP ─────────────────────────────────────────────────────────────────
  {
    id: "aafpPrescribed",
    appCategory: null,
    modality: "any",
    creditType: "AAFP Prescribed / AAFP Category 1 credit",
    aoaCategory: "2-A",
    aoaCategoryNote: "2-A for live and real-time interactive delivery, 2-B for journal-type and on-demand internet delivery. Identical treatment to AMA PRA Category 1 throughout AOA policy; the two are named together in every relevant clause.",
    satisfies: [
      "Everything AMA PRA Category 1 satisfies, including eligibility for the CCME 2-A to 1-B conversion and the small-specialty exception.",
    ],
    doesNotSatisfy: [
      "Any AOA Category 1 minimum, absent conversion or the small-specialty exception.",
    ],
    sources: ["aoaCat1BForm", "aoaActivityDescriptions"],
  },

  // ── AOA-sponsored ────────────────────────────────────────────────────────
  {
    id: "aoa1A",
    appCategory: "AOA Category 1-A",
    modality: "live",
    default: true,
    creditType: "CME from an AOA-accredited Category 1 CME sponsor, face to face or interactive online (asynchronous only if instructor replies within 48 hours)",
    aoaCategory: "1-A",
    satisfies: [
      "Everything. California's 20-hour minimum, every state 1-A-only minimum (Arizona, Washington), and all AOA board requirements.",
      "This is the only credit type with no restriction anywhere.",
    ],
    doesNotSatisfy: [],
    reporting: "The sponsor reports it to the AOA within 90 days. Do not self-report: credits self-submitted for these activities will not be accepted.",
    sources: ["aoaActivityDescriptions", "aoaReporting"],
  },
  {
    id: "aoa1BOnDemand",
    appCategory: "AOA Category 1-B",
    modality: "onDemand",
    default: true,
    creditType: "CME from an AOA-accredited Category 1 sponsor, non-interactive or on-demand internet, plus the enumerated osteopathic professional activities",
    aoaCategory: "1-B",
    satisfies: [
      "California's 20-hour AOA Category 1-A/1-B minimum, since California accepts 1-A or 1-B.",
      "New Mexico DO's 30-hour 1-A/1-B minimum, and any AOA board requirement that reads Category 1-A or 1-B.",
    ],
    doesNotSatisfy: [
      "State or board minimums that name 1-A specifically (Arizona DO 24 hours, Washington DO 60 hours).",
      "Subject to the AOA's 50 percent combined cap on journal reading, home study and non-interactive internet CME.",
    ],
    sources: ["aoaActivityDescriptions"],
  },
  {
    id: "aoa2A",
    appCategory: "AOA Category 2-A",
    modality: "live",
    default: true,
    creditType: "Formal non-osteopathic CME, live or real-time interactive, already categorized as AOA 2-A",
    aoaCategory: "2-A",
    satisfies: [
      "The AOA total credit requirement, and California's 30-hour Category 2 allowance.",
    ],
    doesNotSatisfy: [
      "Any AOA Category 1-A or 1-B minimum.",
    ],
    sources: ["aoaActivityDescriptions"],
  },
  {
    id: "aoa2B",
    appCategory: "AOA Category 2-B",
    modality: "onDemand",
    default: true,
    creditType: "Non-osteopathic home study, journal reading, or non-interactive on-demand internet CME, already categorized as AOA 2-B",
    aoaCategory: "2-B",
    satisfies: [
      "The AOA total credit requirement, and California's 30-hour Category 2 allowance.",
    ],
    doesNotSatisfy: [
      "Any AOA Category 1-A or 1-B minimum.",
      "Not eligible for the 2-A to 1-B conversion form, which excludes home study.",
      "Subject to the combined 50 percent cap on journal reading, home study and non-interactive internet CME.",
    ],
    sources: ["aoaActivityDescriptions"],
  },
  {
    id: "aoaSponsorFailsFaculty",
    appCategory: null,
    modality: "any",
    creditType: "Program from an AOA-accredited Category 1 sponsor that fails the 1-A faculty and hours requirement",
    aoaCategory: "2-A",
    satisfies: [
      "The AOA total credit requirement, and California's 30-hour Category 2 allowance.",
    ],
    doesNotSatisfy: [
      "Any Category 1 minimum, despite the osteopathic sponsor. Sponsor identity alone does not confer 1-A; the faculty and hours test must also be met.",
    ],
    sources: ["aoaActivityDescriptions"],
  },
  {
    id: "ccmeConverted",
    appCategory: null,
    modality: "live",
    creditType: "Non-osteopathic specialty program converted by CCME via the Formal Request for AOA Category 1-B Credit form",
    aoaCategory: "1-B",
    satisfies: [
      "California's 20-hour AOA Category 1-A/1-B minimum. This is the practical route for an osteopathic neurosurgeon to satisfy California's Category 1 minimum from allopathic conferences.",
      "Recognition applies to all physicians in that specialty or subspecialty who attended, not just the requester.",
    ],
    doesNotSatisfy: [
      "1-A-only minimums.",
      "Home study courses are explicitly excluded.",
    ],
    pending: "Approval is not guaranteed: the specialty affiliate must confirm no equivalent osteopathic program exists. Model as pending until granted.",
    sources: ["aoaCat1BForm"],
  },

  // ── Grand rounds: the sponsor decides the category ───────────────────────
  {
    id: "grandRoundsOsteopathic",
    appCategory: "Grand Rounds",
    modality: "live",
    creditType: "Osteopathic grand rounds conducted by an AOA-accredited Category 1 CME sponsor",
    aoaCategory: "1-A",
    satisfies: ["All Category 1 minimums. Granted hour for hour."],
    doesNotSatisfy: [],
    sources: ["aoaActivityDescriptions"],
  },
  {
    id: "grandRoundsNonOsteopathic",
    appCategory: "Grand Rounds",
    modality: "live",
    default: true,
    creditType: "Non-osteopathic grand rounds (the organization is not an AOA Category 1 sponsor)",
    aoaCategory: "1-B",
    satisfies: [
      "California's 20-hour AOA Category 1-A/1-B minimum. Granted hour for hour.",
      "Routine departmental grand rounds land in 1-B, not Category 2. For a hospital-based specialist this is a quietly large source of Category 1 credit.",
    ],
    doesNotSatisfy: [
      "1-A-only minimums.",
      "Departmental and committee meetings earn nothing at all. Grand rounds is the exception, not the rule.",
    ],
    sources: ["aoaActivityDescriptions"],
  },

  // ── AMA PRA Category 2: not addressed by AOA policy ──────────────────────
  {
    id: "amaCat2",
    appCategory: "AMA PRA Category 2",
    modality: "any",
    default: true,
    creditType: "AMA PRA Category 2 Credit",
    aoaCategory: null,
    unverified: true,
    aoaCategoryNote: "The AOA's published category and activity tables address AMA PRA Category 1 and AAFP credit. They do not name AMA PRA Category 2. No AOA equivalence is asserted here.",
    satisfies: [],
    doesNotSatisfy: [
      "Any AOA Category 1 minimum.",
      "States whose rule requires all hours be Category 1.",
    ],
    sources: ["aoaActivityDescriptions", "aoaCat1BForm"],
  },

  // ── Teaching and academic activity ───────────────────────────────────────
  {
    id: "lectureMedicalCollege",
    appCategory: null,
    modality: "live",
    creditType: "Formal delivery of medical education lectures at a DO or MD medical college, or at a specialty or state society conference, to students, interns, residents, fellows and staff",
    aoaCategory: "1-A",
    satisfies: ["Every Category 1 minimum including 1-A-only states. Hour for hour, no cap. This is the one teaching activity that reaches 1-A."],
    doesNotSatisfy: [
      "No credit for preparation time.",
      "Requires verification by the CME department of the medical college, sponsoring hospital or sponsor: a letter stating hours and dates.",
    ],
    sources: ["aoaActivityDescriptions"],
  },
  {
    id: "gmeUmeFaculty",
    appCategory: null,
    modality: "any",
    creditType: "GME or UME core faculty, faculty, or preceptor in an ACGME-accredited GME or COCA-accredited UME program",
    aoaCategory: "1-B",
    satisfies: ["California's 20-hour AOA Category 1-A/1-B minimum. Granted hour for hour."],
    doesNotSatisfy: [
      "1-A-only minimums.",
      "Capped at 20 percent of required credits per 3-year certification cycle.",
      "No credit at all for precepting physician assistants or nurse practitioners.",
      "Requires an institutional letter stating hours and dates if not reported directly by the sponsor.",
    ],
    sources: ["aoaActivityDescriptions"],
  },
  {
    id: "labSessions",
    appCategory: null,
    modality: "live",
    creditType: "Formal delivery of medical education lab sessions, or instructing and grading practical exams and oral presentations",
    aoaCategory: "1-B",
    satisfies: ["California's 20-hour 1-A/1-B minimum. Granted hour for hour."],
    doesNotSatisfy: [
      "1-A-only minimums.",
      "Capped at 20 percent of required credits. No credit for lab preparation.",
      "Requires a letter verified by the institution's CME department with credit hours and dates.",
    ],
    sources: ["aoaActivityDescriptions"],
  },
  {
    id: "teachLifeSupport",
    appCategory: null,
    modality: "live",
    creditType: "Teaching standardized life support courses (ACLS, ATLS, BLS, NRP and the enumerated list)",
    aoaCategory: "1-A",
    satisfies: ["All Category 1 minimums. Granted hour for hour."],
    doesNotSatisfy: [
      "Capped at 10 CME credit hours per calendar year. Note: per calendar year, not per cycle, unlike most AOA caps.",
      "Certificate or teaching log must be submitted. No credit for course preparation.",
    ],
    sources: ["aoaActivityDescriptions"],
  },
  {
    id: "takeLifeSupport",
    appCategory: null,
    modality: "live",
    creditType: "Participating in standardized life support courses at provider, refresher or instructor level",
    aoaCategory: "1-A",
    satisfies: ["All Category 1 minimums including 1-A-only states. Credits follow the number stated on the completion certificate."],
    doesNotSatisfy: [
      "Online standardized courses earn credit for the practical portion only.",
      "Certificates that omit a credit count fall back to the AOA's standardized chart.",
    ],
    sources: ["aoaActivityDescriptions"],
  },

  // ── Training ─────────────────────────────────────────────────────────────
  {
    id: "fellowshipYear",
    appCategory: null,
    modality: "any",
    creditType: "Fellowship training year, ACGME-accredited program",
    aoaCategory: "1-B",
    satisfies: [
      "AOA board certification CME: 20 credits per completed year of training, applied during the certification CME cycle.",
      "AOA Category 1-A/1-B minimums where the board's requirement reads 1-A or 1-B.",
    ],
    doesNotSatisfy: [
      "California licensure. OMBC awards no CME for training and instead waives 50 or 100 percent of the requirement in proportion to time spent in training during the two-year period, evidenced by diploma or program director letter.",
      "Do not double count: a physician cannot both claim the OMBC waiver and log AOA fellowship credit against the same California cycle.",
      "Credit attaches only at completion of each training year, not continuously.",
    ],
    unconfirmed: "Residency (as opposed to fellowship) and AOA-accredited (as opposed to ACGME) programs appeared in the 2019-2021 guide but not the 2025-2027 table.",
    sources: ["aoaFaqs", "aoaActivityDescriptions", "aoaGuide1921", "ombcCme"],
  },

  // ── Examinations and item writing ────────────────────────────────────────
  {
    id: "administerAoaExam",
    appCategory: null,
    modality: "live",
    creditType: "Administering an AOA certifying board oral, clinical, performance or practical examination",
    aoaCategory: "1-A",
    satisfies: ["All Category 1 minimums. Hour for hour, no cap."],
    doesNotSatisfy: ["AOA boards only."],
    sources: ["aoaActivityDescriptions"],
  },
  {
    id: "writeExamItems",
    appCategory: null,
    modality: "any",
    creditType: "Writing examination items accepted by an AOA certifying board, conjoint committee, AOA-accredited Category 1 provider, or the NBOME",
    aoaCategory: "1-A",
    satisfies: ["All Category 1 minimums. 5 credits per accepted case or item; separately 1 credit per 2 accepted items for item writing."],
    doesNotSatisfy: [
      "Each stream capped at 15 credit hours per certification CME cycle.",
      "Credit attaches on acceptance, not submission.",
    ],
    sources: ["aoaActivityDescriptions"],
  },
  {
    id: "passAoaCert",
    appCategory: null,
    modality: "any",
    creditType: "Passing an AOA initial primary, subspecialty or CAQ certification exam",
    aoaCategory: "1-B",
    satisfies: ["15 Category 1-B credits per exam passed. California's 20-hour 1-A/1-B minimum."],
    doesNotSatisfy: ["1-A-only minimums. AOA boards only; ABMS exams land in 2-B."],
    sources: ["aoaActivityDescriptions"],
  },
  {
    id: "occComponent3",
    appCategory: null,
    modality: "any",
    creditType: "Passing an AOA OCC Component 3 recertification exam or completing longitudinal assessment",
    aoaCategory: "1-B",
    satisfies: ["California's 20-hour 1-A/1-B minimum."],
    doesNotSatisfy: ["1-A-only minimums. Capped at 25 percent of required CME credit hours per certification CME cycle."],
    sources: ["aoaActivityDescriptions"],
  },
  {
    id: "examConstruction",
    appCategory: null,
    modality: "any",
    creditType: "Exam construction clinical case development, exam construction committee work, and Job Task Analysis participation",
    aoaCategory: "1-B",
    satisfies: ["California's 20-hour 1-A/1-B minimum."],
    doesNotSatisfy: ["1-A-only minimums. Exam construction and JTA share a combined cap of 50 percent of required credit hours per certification cycle."],
    sources: ["aoaActivityDescriptions"],
  },
  {
    id: "abmsMoc",
    appCategory: null,
    modality: "any",
    creditType: "ABMS Maintenance of Certification, subspecialty or CAQ examinations",
    aoaCategory: "2-B",
    satisfies: ["AOA total credit, capped at 15 CME credit hours per certification CME cycle. California's 30-hour Category 2 allowance."],
    doesNotSatisfy: [
      "Any AOA Category 1 minimum.",
      "This is AOA treatment only. Several states accept ABMS certification or recertification in lieu of hours entirely, which is a separate state MOC pathway (the app models that per state in the `moc` field). The two must not be conflated.",
    ],
    sources: ["aoaActivityDescriptions"],
  },

  // ── Scholarship ──────────────────────────────────────────────────────────
  {
    id: "publishArticle",
    appCategory: null,
    modality: "any",
    creditType: "Development and publication of scientific papers and online osteopathic educational programs",
    aoaCategory: "1-B",
    satisfies: ["California's 20-hour 1-A/1-B minimum. 10 CME credits per article published, no stated cap."],
    doesNotSatisfy: ["1-A-only minimums. Credit attaches at publication, not submission or acceptance."],
    sources: ["aoaActivityDescriptions"],
  },
  {
    id: "peerReview",
    appCategory: null,
    modality: "any",
    creditType: "Physician peer review for the Journal of Osteopathic Medicine or an AOA Category 1 CME sponsor",
    aoaCategory: "1-B",
    satisfies: ["California's 20-hour 1-A/1-B minimum. 3 Category 1-B credits per completed review."],
    doesNotSatisfy: [
      "1-A-only minimums. Capped at 20 percent of total required CME per certification cycle.",
      "Peer review for non-AOA journals is not addressed by the AOA table and should not be assumed to earn credit.",
    ],
    sources: ["aoaActivityDescriptions"],
  },
  {
    id: "posterOsteopathic",
    appCategory: null,
    modality: "live",
    creditType: "Preparing and presenting an osteopathic clinical case or research poster as primary author at an AOA-accredited sponsor event",
    aoaCategory: "1-A",
    satisfies: ["All Category 1 minimums. 5 CME credits per presentation."],
    doesNotSatisfy: ["Requires primary authorship. Co-authors earn nothing."],
    sources: ["aoaActivityDescriptions"],
  },
  {
    id: "posterNonOsteopathic",
    appCategory: null,
    modality: "live",
    creditType: "Preparing and presenting a non-osteopathic clinical case or research poster as primary author",
    aoaCategory: "2-A",
    satisfies: ["AOA total credit and California's Category 2 allowance. 5 CME credits per presentation."],
    doesNotSatisfy: ["Any Category 1 minimum. Requires primary authorship."],
    sources: ["aoaActivityDescriptions"],
  },
  {
    id: "judgePosters",
    appCategory: null,
    modality: "live",
    creditType: "Judging clinical case and research poster presentations",
    aoaCategory: "1-A",
    aoaCategoryNote: "1-A at an AOA-accredited sponsor function, 2-A at a non-osteopathic function.",
    satisfies: ["Granted hour for hour. The osteopathic variant satisfies all Category 1 minimums."],
    doesNotSatisfy: ["Both variants capped at 10 CME credit hours per certification CME cycle. The non-osteopathic variant satisfies no Category 1 minimum."],
    sources: ["aoaActivityDescriptions"],
  },
  {
    id: "scientificExhibit",
    appCategory: null,
    modality: "live",
    creditType: "Preparation and presentation of a scientific exhibit at a county, regional, state or national professional meeting",
    aoaCategory: "2-B",
    satisfies: ["10 CME credit hours per exhibit toward AOA total credit and California's Category 2 allowance."],
    doesNotSatisfy: [
      "Any Category 1 minimum.",
      "Note the asymmetry: a scientific exhibit is 2-B while a clinical case or research poster presentation is 1-A (osteopathic sponsor) or 2-A (non-osteopathic). Do not merge them into one poster credit type.",
    ],
    sources: ["aoaActivityDescriptions"],
  },

  // ── Reading and home study ───────────────────────────────────────────────
  {
    id: "readOsteopathicJournal",
    appCategory: null,
    modality: "onDemand",
    creditType: "Reading an osteopathic journal indexed in PubMed and scoring at least 70 percent on the CME quiz",
    aoaCategory: "1-B",
    satisfies: ["California's 20-hour 1-A/1-B minimum. Journal of Osteopathic Medicine is 2 credits per issue; AOA Online Learning activities are 1 credit."],
    doesNotSatisfy: [
      "1-A-only minimums. Subject to the combined 50 percent cap on journal reading, home study and non-interactive internet CME.",
      "The 70 percent quiz score is a hard gate: reading without passing the quiz earns nothing.",
    ],
    sources: ["aoaActivityDescriptions"],
  },
  {
    id: "readOtherJournal",
    appCategory: null,
    modality: "onDemand",
    creditType: "Reading non-osteopathic medical journals",
    aoaCategory: "2-B",
    satisfies: [
      "AOA total credit at 0.5 credit per journal read.",
      "California accepts self-reported journal readings at 0.5 units of Category 2 each, listing journal name, issues read and years, on a signed and dated document.",
    ],
    doesNotSatisfy: ["Any AOA Category 1 minimum. Subject to the combined 50 percent cap. The AOA Home Study Form must be submitted."],
    sources: ["aoaActivityDescriptions", "ombcCme"],
  },
  {
    id: "homeStudy",
    appCategory: null,
    modality: "onDemand",
    creditType: "Home study: viewing non-osteopathic medical video, audio or online CME courses",
    aoaCategory: "2-B",
    satisfies: ["AOA total credit and California's 30-hour Category 2 allowance."],
    doesNotSatisfy: [
      "Any Category 1 minimum.",
      "Not eligible for the 2-A to 1-B conversion form, which excludes home study.",
      "Subject to the combined 50 percent cap.",
    ],
    sources: ["aoaActivityDescriptions"],
  },

  // ── Federal and uniformed service ────────────────────────────────────────
  {
    id: "federalCmeActiveDuty",
    appCategory: null,
    modality: "live",
    creditType: "Formal federal CME program, participant on active duty or employed by a uniformed service",
    aoaCategory: "1-A",
    satisfies: ["All Category 1 minimums. Hour for hour."],
    doesNotSatisfy: ["The status of the participant, not the program, decides the category."],
    sources: ["aoaActivityDescriptions"],
  },
  {
    id: "federalCmeCivilian",
    appCategory: null,
    modality: "live",
    creditType: "Formal federal CME program, participant not on active duty and not employed by a uniformed service",
    aoaCategory: "1-B",
    satisfies: ["California's 20-hour 1-A/1-B minimum. Hour for hour."],
    doesNotSatisfy: ["1-A-only minimums. Same program, different participant status, different category."],
    sources: ["aoaActivityDescriptions"],
  },
  {
    id: "aviationCourses",
    appCategory: null,
    modality: "live",
    creditType: "Standardized federal aviation courses (aviation medicine, flight surgeon primary, AME maintenance and the enumerated list)",
    aoaCategory: "1-A",
    satisfies: ["All Category 1 minimums. Hour for hour."],
    doesNotSatisfy: ["The course must be sponsored by the Civil Aeronautic Institute, the FAA or the United States Armed Services."],
    sources: ["aoaActivityDescriptions"],
  },
];

// Activities the AOA lists as earning nothing. Common false assumptions, so
// worth blocking rather than warning.
export const NON_CREDIT_ACTIVITIES = {
  activities: [
    "Volunteer work",
    "Facility tours",
    "Departmental and committee meetings",
    "State licensing board service",
    "Physician administrative training",
    "Observation at medical centers",
    "Medical economics courses",
    "Precepting physician assistants or nurse practitioners",
    "Quality assessment program participation",
  ],
  note: "The AOA lists these explicitly as ineligible for AOA CME credit. Quality Improvement and Quality Assessment participation may count for OCC Component 4 via the Quality Improvement Activity Attestation, which is a separate track from CME credit.",
  sources: ["aoaActivityDescriptions"],
};

// ---------------------------------------------------------------------------
// The 2-A to 1-B conversion: the one route that turns allopathic conference
// hours into a real AOA Category 1-B posting.
// ---------------------------------------------------------------------------
export const CAT1B_CONVERSION = {
  id: "cat1bConversion",
  formName: "Formal Request for AOA Category 1-B Credit for Non-Osteopathic Programs",
  formUrl: SOURCES.aoaCat1BForm.url,
  producesCategory: "1-B",
  standard: "The Council on Continuing Medical Education may recognize allopathically sponsored specialty or subspecialty programs for Category 1-B credit when, in the Council's opinion, there is essentially no equivalent course material available from within the osteopathic profession. Recognition applies only to physicians in that specialty or subspecialty.",
  submit: [
    "The completed form.",
    "A copy of the printed program or syllabus showing lectures, length and faculty.",
    "Verification of attendance carrying the AMA PRA Category 1 or AAFP accreditation statement.",
  ],
  cost: "Free to AOA members as a member benefit. Non-members pay a $25 application fee plus $10 processing per program.",
  excludes: "Home study courses are not applicable.",
  routing: "The request is forwarded to the specialty affiliate to verify that no similar osteopathic program exists, so approval is not guaranteed. Treat as pending until granted.",
  whyItMatters: "California accepts AOA Category 1-A or 1-B for its 20-hour minimum. This is the only route that turns AMA PRA Category 1 hours into a posting that minimum will take. Osteopathic neurosurgery is close to the case the policy was written for.",
  sources: ["aoaCat1BForm", "ombcCme", "bpc2454_5"],
};

// ---------------------------------------------------------------------------
// Small-specialty exception (fewer than 300 certificate holders).
// NEVER auto-applied. It depends on the physician's board, on AOA membership,
// and on the AOA's own qualifying-specialty list, and it does not travel to
// state licensure.
// ---------------------------------------------------------------------------
export const SMALL_SPECIALTY_EXCEPTION = {
  id: "smallSpecialty",
  threshold: "Specialties and subspecialties with fewer than 300 certificate holders. The AOA maintains the list of qualifying specialties; this is not a count the physician calculates.",
  creditCap: 15,
  creditCapText: "Up to 15 AMA PRA Category 1 and/or AAFP Category 1 credits per cycle may be applied to the AOA Category 1-A credit requirement.",
  criteria: [
    "The physician must be an AOA member.",
    "The physician must be AOA and/or ABMS certified.",
    "The specialty or subspecialty must be listed as a qualifying specialty.",
  ],
  howToRequest: "To request eligibility, contact your certifying board. For osteopathic neurological surgery that is the American Osteopathic Board of Surgery (AOBS). There is no American Osteopathic Board of Neurological Surgery.",
  scope: "Operates only inside the AOA's own membership and board-certification accounting. The AOA guide describes it as meeting the Category 1-A credit requirement for membership.",
  doesNotTravel: "It does not re-designate the credit on the certificate, so it does not reach state licensure. OMBC states the rule flatly: the Board must accept CME as it is reported on the certificate, and if it is listed as AMA it will count as AOA Category 2. Applying this exception creates no hours that satisfy California's 20-hour AOA Category 1-A/1-B minimum. Use the CCME 2-A to 1-B conversion for that.",
  aobsNote: "For AOBS diplomates the exception is moot on the board side: the AOA 2025-27 requirements-by-board table lists Surgery (AOBS) as 60 credits (time-limited diplomates, or non-time-limited diplomates in OCC) or 120 credits (non-time-limited, not in OCC), with the Category 1-A/1-B column blank. There is no 1-A requirement to apply the 15 credits against.",
  specialtyListConfidence: "Neurological Surgery appears on a CME vendor's reproduction of the AOA qualifying list, alongside Cardiothoracic Surgery, General Vascular Surgery, Hand Surgery, Plastic and Reconstructive Surgery, Thoracic Cardiovascular Surgery, Thoracic Surgery, Urological Surgery and Vascular/Interventional Radiology. The AOA's own current list could not be retrieved. Confirm with your board before relying on it.",
  confirmWith: "Your certifying board, and your AOA membership status.",
  sources: ["aoaGuide1618", "aoaByBoard", "ombcCme", "aobsNeuro", "boardVitals"],
};

// ---------------------------------------------------------------------------
// Training credit: fellowship and residency.
// No AOA form exists for training credit. The form physicians are often told
// to file is the 2-A to 1-B conversion above, which is for a different thing.
// ---------------------------------------------------------------------------
export const TRAINING_CREDIT = {
  id: "trainingCredit",
  aoaCategory: "1-B",
  aoaRule: "AOA board-certified fellows are not exempt from CME requirements for the 2025-2027 cycle. They earn 20 AOA Category 1-B credits for each year of postdoctoral training completed, applied during the certification CME cycle. Credit attaches at completion of each training year, not continuously.",
  aoaScope: "ACGME-accredited fellowship. The current AOA table names fellowship and ACGME only. The 2019-2021 guide also covered residency and AOA-accredited programs at the same 20 credits per year; treat those as unconfirmed for 2025-2027.",
  formRequired: false,
  formNote: "No AOA form is required for training credit. Where the sponsor does not report the credit, the AOA asks for a letter from the institution stating the number of hours and the dates. The 'Formal Request for AOA Category 1-B Credit for Non-Osteopathic Programs' form is not for training: it converts allopathically sponsored specialty programs to 1-B.",
  californiaRule: "California does the opposite of awarding credit. OMBC waives the CME requirement in proportion to time spent in training during the two-year period: 50 percent of the hours if half the period was spent in training, 100 percent if all of it was. Any year of the cycle not spent in training negates the ability to claim the waiver for that year.",
  californiaDocs: "A copy of the residency or fellowship diploma if completed, or a letter from the program director if still in the program. OMBC also publishes a Request for Waiver/Reduction of CME Credit Form, submitted annually.",
  doNotDoubleCount: "A physician cannot both claim the OMBC training waiver and log AOA fellowship credit against the same California cycle.",
  sources: ["aoaFaqs", "aoaActivityDescriptions", "aoaGuide1921", "ombcCme", "ombcProposed"],
};

// ---------------------------------------------------------------------------
// Reporting mechanics that decide whether credit exists in the AOA's records.
// ---------------------------------------------------------------------------
export const AOA_REPORTING = {
  category1: "AOA-accredited Category 1 sponsors report Category 1 credit to the AOA within 90 days. Do not self-report these: credits self-submitted for AOA Category 1 activities will not be accepted.",
  category2: "Category 2 is the physician's own burden. Self-report through the AOA physician portal, or email the certificate with your AOA number to memberservice@osteopathic.org. Unreported AMA credit does not exist in the AOA's records.",
  cycleBoundary: "Credits earned before Jan 1 2025, or already used for a prior cycle, cannot be applied to the 2025-2027 cycle.",
  sources: ["aoaReporting", "aoaFaqs", "aoaPolicies"],
};

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

/** Every equivalence row that maps to a given CME entry category string. */
export function equivalenceRowsFor(appCategory) {
  if (!appCategory) return [];
  return CREDIT_EQUIVALENCE.filter(r => r.appCategory === appCategory);
}

/**
 * The row to use for a logged category. `modality` is optional; without it the
 * row marked `default: true` wins, which for AMA PRA Category 1 is the live
 * (2-A) reading.
 */
export function equivalenceFor(appCategory, modality) {
  const rows = equivalenceRowsFor(appCategory);
  if (rows.length === 0) return null;
  if (modality) {
    const exact = rows.find(r => r.modality === modality);
    if (exact) return exact;
  }
  return rows.find(r => r.default) || rows[0];
}

/** The AOA category code ("1-A", "2-A", ...) a logged category lands in, or null. */
export function aoaCategoryFor(appCategory, modality) {
  return equivalenceFor(appCategory, modality)?.aoaCategory ?? null;
}

/** Short display form of a credit-type string, for tight labels. */
export function shortCategory(name) {
  return String(name || "")
    .replace(/^AOA Category /, "AOA ")
    .replace(/^AMA PRA Category /, "AMA PRA Cat ")
    .replace(/^AAFP /, "AAFP ");
}

/**
 * The note shown at the moment of logging, so a DO sees what the credit
 * actually counts as before saving it. Returns null when the app has no
 * verified equivalence claim for that category.
 */
export function logNoteFor(appCategory, degreeType) {
  if (degreeType !== "DO" || !appCategory) return null;
  const row = equivalenceFor(appCategory);
  if (!row) return null;

  // AMA PRA Category 2: no AOA equivalence is published. Say so.
  if (row.unverified) {
    return {
      tone: "warn",
      headline: "The AOA publishes no category for this credit.",
      detail: "Does not satisfy an AOA Category 1-A or 1-B minimum.",
      lines: [row.aoaCategoryNote, ...row.doesNotSatisfy].filter(Boolean),
    };
  }

  const code = row.aoaCategory;
  const isCat2 = code === "2-A" || code === "2-B";

  // Grand rounds: the sponsor, not the app, decides the category.
  if (appCategory === "Grand Rounds") {
    return {
      tone: "info",
      headline: "The sponsor decides the category.",
      detail: "Osteopathic grand rounds run by an AOA-accredited Category 1 sponsor are AOA Category 1-A. Grand rounds anywhere else are AOA Category 1-B.",
      lines: [
        "Either way it counts toward California's 20-hour AOA Category 1-A/1-B minimum, hour for hour.",
        "1-B does not satisfy a minimum that names 1-A specifically (Arizona DO, Washington DO).",
        "Departmental and committee meetings earn no AOA credit at all. Grand rounds is the exception.",
      ],
    };
  }

  if (isCat2) {
    const lines = [];
    if (row.aoaCategoryAmbiguous && row.aoaCategoryNote) lines.push(row.aoaCategoryNote);
    if (appCategory === "AMA PRA Category 1") {
      lines.push("If the activity was on-demand, journal-type or home study, the AOA activity table calls it 2-B instead. For California the split does not matter: OMBC pools 2-A and 2-B in one 30-hour Category 2 allowance.");
      lines.push("It still counts toward your state total and toward the AOA total credit requirement. It is only the Category 1 minimum it cannot touch.");
      lines.push(`Route that does work: ${CAT1B_CONVERSION.formName}. The CCME converts an allopathic specialty program to AOA Category 1-B when no equivalent osteopathic course content exists. Live programs only; home study is excluded.`);
    } else {
      lines.push(...row.satisfies);
    }
    lines.push(AOA_REPORTING.category2);
    return {
      tone: "warn",
      headline: `Counts as AOA Category ${code}.`,
      detail: "Does not satisfy an AOA Category 1-A or 1-B minimum.",
      lines,
    };
  }

  // Category 1-A / 1-B
  const lines = [...row.satisfies];
  if (appCategory === "AOA Category 1-B") {
    lines.push(`${TRAINING_CREDIT.aoaRule} ${TRAINING_CREDIT.formNote}`);
    lines.push(`California: ${TRAINING_CREDIT.californiaRule} ${TRAINING_CREDIT.doNotDoubleCount}`);
  }
  if (code === "1-A") lines.push(AOA_REPORTING.category1);
  return {
    tone: "info",
    headline: `Counts as AOA Category ${code}.`,
    detail: code === "1-A"
      ? "Satisfies every AOA Category 1 minimum, including states that name 1-A specifically."
      : "Satisfies an AOA Category 1-A or 1-B minimum. It does not satisfy a minimum that names 1-A alone.",
    lines: lines.filter(Boolean),
  };
}

/**
 * Label for the Category 1 progress bar, built from the credit types the state
 * actually accepts (the engine's `cat1Keywords`) rather than a guess from the
 * degree. CA/DO accepts AOA 1-A or 1-B and NOT AMA, so a label reading
 * "Cat 1-A / AMA Cat 1" told the physician the opposite of the math.
 */
export function cat1BucketLabel(accepted, degreeType) {
  const list = Array.isArray(accepted) ? accepted : [];
  if (list.length === 0) return "Category 1 minimum";
  const aoa = list.filter(k => k.startsWith("AOA Category"));
  const other = list.filter(k => !k.startsWith("AOA Category"));
  if (aoa.length && !other.length) {
    const codes = aoa.map(k => k.replace("AOA Category ", ""));
    return `AOA Category ${codes.join(" or ")} minimum`;
  }
  if (!aoa.length && other.length === 1 && degreeType !== "DO") return "AMA PRA Category 1 minimum";
  return `Category 1 minimum (${list.map(shortCategory).join(", ")})`;
}

/**
 * Match the engine's date handling exactly: a bare "YYYY-MM-DD" is local
 * midnight, and both window bounds are in-cycle. Diverging from
 * src/utils/compliance.js here would print a breakdown that disagrees with the
 * bar above it.
 */
function inWindow(entry, start, end) {
  if (!entry?.date) return false;
  const s = String(entry.date);
  const d = new Date(s.length === 10 ? s + "T00:00:00" : s);
  return d >= start && d <= end;
}

/**
 * Split the hours logged inside a cycle window into what the Category 1
 * minimum will take and what it will not, grouped by credit type. This is what
 * makes "10.25 of 20" legible: the physician sees the 20 AMA hours sitting
 * right there and why they do not close the gap.
 */
export function cat1Breakdown(cmeEntries, { start, end, accepted, degreeType }) {
  const acceptedList = Array.isArray(accepted) ? accepted : [];
  const counted = new Map();
  const notCounted = new Map();
  for (const c of cmeEntries || []) {
    if (!inWindow(c, start, end)) continue;
    const hrs = parseFloat(c.hours) || 0;
    if (hrs <= 0) continue;
    const key = c.category || "Uncategorized";
    const bucket = acceptedList.includes(c.category) ? counted : notCounted;
    bucket.set(key, (bucket.get(key) || 0) + hrs);
  }
  const toRows = (m, withReason) => [...m.entries()]
    .map(([category, hours]) => ({
      category,
      hours: Math.round(hours * 100) / 100,
      reason: withReason ? excludedReason(category, degreeType) : null,
    }))
    .sort((a, b) => b.hours - a.hours);
  return {
    counted: toRows(counted, false),
    notCounted: toRows(notCounted, true),
  };
}

/** Why a logged credit type is outside the Category 1 minimum. */
function excludedReason(appCategory, degreeType) {
  if (appCategory === "Uncategorized") return "no credit category on the entry";
  if (degreeType === "DO") {
    const code = aoaCategoryFor(appCategory);
    if (code) return `AOA Category ${code}`;
    return "no published AOA category";
  }
  return "not AMA PRA Category 1";
}

/**
 * The actionable route to close a Category 1 gap, chosen by what the
 * requirement actually accepts. Returns null when the gap needs no explaining
 * (the state already accepts AMA PRA Category 1).
 */
export function cat1RouteNote(accepted, degreeType) {
  if (degreeType !== "DO") return null;
  const list = Array.isArray(accepted) ? accepted : [];
  if (list.some(k => k.startsWith("AMA PRA"))) return null;
  if (list.includes("AOA Category 1-B")) {
    return {
      title: "Turning allopathic hours into credit this minimum accepts",
      body: `${CAT1B_CONVERSION.whyItMatters} The standard the CCME applies: it may recognize an allopathically sponsored specialty or subspecialty program for Category 1-B when there is essentially no equivalent osteopathic course material available. File the ${CAT1B_CONVERSION.formName} with the printed program or syllabus and your attendance verification bearing the AMA PRA Category 1 or AAFP accreditation statement. ${CAT1B_CONVERSION.cost} ${CAT1B_CONVERSION.excludes} ${CAT1B_CONVERSION.routing}`,
      url: CAT1B_CONVERSION.formUrl,
      linkLabel: "AOA Category 1-B request form (PDF)",
    };
  }
  return {
    title: "This minimum takes AOA Category 1-A only",
    body: "Only an AOA-accredited Category 1 sponsor delivering face-to-face or interactive CME produces 1-A. The CCME conversion route for allopathic programs produces 1-B, which this minimum does not accept. Osteopathic grand rounds run by an AOA-accredited sponsor, teaching lectures at a medical college, and standardized life support courses all reach 1-A.",
    url: SOURCES.aoaActivityDescriptions.url,
    linkLabel: "AOA CME category and activity descriptions (PDF)",
  };
}

/**
 * The small-specialty exception as an actionable note, for AOA membership and
 * board-certification cards only. Returns null everywhere else, because the
 * exception does not reach state licensure.
 */
export function smallSpecialtyNote(degreeType) {
  if (degreeType !== "DO") return null;
  const e = SMALL_SPECIALTY_EXCEPTION;
  return {
    title: "You may be able to apply up to 15 AMA PRA Category 1 credits here",
    body: `${e.creditCapText} ${e.threshold} All three criteria must be met: ${e.criteria.join(" ")} ${e.howToRequest}`,
    caveats: [e.scope, e.doesNotTravel, e.aobsNote, e.specialtyListConfidence],
    url: SOURCES.aoaGuide1618.url,
    linkLabel: "AOA CME Guide, small-specialty policy (PDF)",
  };
}

/** One-line DO-facing read of a provider's accreditation, for the directory. */
export function providerAoaLine(provider) {
  const acc = provider?.accreditation || [];
  if (acc.some(a => a.startsWith("AOA Category 1"))) {
    return "Earns AOA Category 1 credit directly. This is the only kind of credit that satisfies every state and board Category 1 minimum.";
  }
  if (acc.some(a => a.startsWith("AMA PRA Category 1") || a.startsWith("AAFP"))) {
    return "For a DO this posts as AOA Category 2 (2-A when live or real-time interactive, 2-B when on demand). It counts toward state totals but satisfies no AOA Category 1-A or 1-B minimum.";
  }
  return null;
}
