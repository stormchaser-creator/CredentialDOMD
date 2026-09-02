export const CERTIFICATION_TYPE = "Certification";

export const LICENSE_TYPES_MD = [
  "State Medical License",
  "DEA Registration",
  "State Controlled Substance",
  "Board Certification (ABMS)",
  "ECFMG Certificate",
  "USMLE",
  "BLS Certification",
  "ACLS Certification",
  "ATLS Certification",
  "Fluoroscopy Permit",
  "Laser Safety Certificate",
  CERTIFICATION_TYPE,
  "Other",
];

export const LICENSE_TYPES_DO = [
  "State Medical License (DO)",
  "State Medical License (MD-equiv)",
  "DEA Registration",
  "State Controlled Substance",
  "Board Certification (AOA)",
  "Board Certification (ABMS)",
  "COMLEX",
  "USMLE",
  "BLS Certification",
  "ACLS Certification",
  "ATLS Certification",
  "Fluoroscopy Permit",
  "Laser Safety Certificate",
  CERTIFICATION_TYPE,
  "Other",
];

export const getLicenseTypes = (deg) => deg === "DO" ? LICENSE_TYPES_DO : LICENSE_TYPES_MD;

export const PRIVILEGE_TYPES = [
  "Full Admitting Privileges",
  "Surgical Privileges",
  "Courtesy Privileges",
  "Temporary Privileges",
  "Telemedicine Privileges",
  "Emergency Privileges",
  "Consulting Privileges",
];

export const INSURANCE_TYPES = [
  "Medical Malpractice (Occurrence)",
  "Medical Malpractice (Claims-Made)",
  "Tail Coverage",
  "General Liability",
  "Umbrella/Excess Liability",
  "Cyber Liability",
  "Workers Compensation",
  "Health Insurance (personal)",
  "Dental Insurance",
  "Vision Insurance",
  "Disability Insurance",
  "Life Insurance",
];

export const CME_CATEGORIES_MD = [
  "AMA PRA Category 1",
  "AMA PRA Category 2",
  "State-Specific Required",
  "MOC Part II (Lifelong Learning)",
  "MOC Part IV (Practice Improvement)",
  "Self-Assessment",
  "Grand Rounds",
  "Other",
];

export const CME_CATEGORIES_DO = [
  "AOA Category 1-A",
  "AOA Category 1-B",
  "AOA Category 2-A",
  "AOA Category 2-B",
  "AMA PRA Category 1",
  "AMA PRA Category 2",
  "OCC Component 2 (Lifelong Learning)",
  "OCC Component 4 (Practice Assessment)",
  "State-Specific Required",
  "Grand Rounds",
  "Other",
];

export const getCMECategories = (deg) => deg === "DO" ? CME_CATEGORIES_DO : CME_CATEGORIES_MD;

// Case categories follow the ACGME Review Committee for Neurological Surgery's
// "Defined Case Categories" (effective 7/1/2019) so a case log groups the same
// way a residency case log and credentialing reviewers already expect.
export const CASE_CATEGORY_GROUPS = [
  {
    header: "Cranial",
    options: [
      "Cranial: Tumor General",
      "Cranial: Tumor Sellar/Parasellar",
      "Cranial: Trauma/Other",
      "Cranial: Decompressive Hemicraniectomy",
      "Cranial: Evacuation of Intraparenchymal Hematoma",
      "Cranial: Vascular Open",
      "Cranial: Vascular Endovascular",
      "Cranial: CSF Diversion/ETV/Other",
      "Cranial/Extracranial: Pain",
      "Cranial/Extracranial: Functional Disorder",
      "Cranial/Extracranial: Epilepsy",
    ],
  },
  {
    header: "Spinal",
    options: [
      "Spinal: Anterior Cervical",
      "Spinal: Posterior Cervical",
      "Spinal: Thoracic/Lumbar/Sacral/Instrumentation/Fusion",
      "Spinal: Lumbar Laminectomy/Laminotomy",
      "Spinal: Stimulation/Lesion/Pump/Other",
    ],
  },
  {
    header: "Peripheral Nerve & Other",
    options: ["Peripheral Nerve", "Radiosurgery", "Peripheral Device Management"],
  },
  {
    header: "Critical Care",
    options: [
      "Airway Management",
      "Angiography",
      "Arterial Line Placement",
      "CVP Line Placement",
      "EVD/Transdural Monitor Placement",
      "Lumbar/Other Puncture/Drain Placement",
      "Percutaneous Tap of CSF Reservoir",
    ],
  },
  {
    header: "Pediatric",
    options: [
      "Pediatric: Cranial Tumor",
      "Pediatric: Cranial Trauma/Other",
      "Pediatric: CSF Diversion/ETV/Other",
      "Pediatric: Spinal",
    ],
  },
  { header: "Other", options: ["Other"] },
];

export const CASE_CATEGORIES = CASE_CATEGORY_GROUPS.flatMap(g => g.options);

export const HEALTH_RECORD_CATEGORIES = ["Vaccination", "Titer / Immunity", "TB Test", "Drug Screen", "Fit Test"];

export const TITER_TYPES = [
  "Hepatitis B Surface Antibody (HBsAb)",
  "MMR Panel (Measles, Mumps, Rubella)",
  "Measles (Rubeola) IgG",
  "Mumps IgG",
  "Rubella IgG",
  "Varicella Zoster IgG",
  "Hepatitis C Antibody",
  "Other Titer",
];

export const TITER_RESULTS = ["Immune", "Not Immune", "Equivocal", "Negative", "Positive", "Pending"];

export const DRUG_SCREEN_TYPES = [
  "9-Panel Urine", "10-Panel Urine", "5-Panel Urine",
  "Hair Follicle", "Breath Alcohol", "Other",
];

export const DRUG_SCREEN_RESULTS = ["Negative", "Positive", "Dilute", "Pending", "Refused"];

export const VACCINATION_TYPES = [
  "Hepatitis B", "MMR (Measles, Mumps, Rubella)", "Varicella (Chickenpox)",
  "Influenza (Flu)", "COVID-19", "Tdap (Tetanus, Diphtheria, Pertussis)",
  "Meningococcal", "Polio (IPV)", "Hepatitis A", "HPV", "Other",
];

export const TB_TEST_TYPES = [
  "PPD/TST (Skin Test)", "QuantiFERON-TB Gold", "T-SPOT.TB",
  "Chest X-Ray", "Other",
];

export const FIT_TEST_TYPES = [
  "N95 Respirator", "PAPR (Powered Air-Purifying)", "Half-Face Respirator",
  "Full-Face Respirator", "Other",
];

export const TB_RESULTS = ["Negative", "Positive", "Indeterminate"];

export const EDUCATION_TYPES = [
  "Doctor of Osteopathic Medicine (DO)",
  "Doctor of Medicine (MD)",
  "Bachelor of Science (BS)",
  "Bachelor of Arts (BA)",
  "Master of Science (MS)",
  "Master of Public Health (MPH)",
  "Fellowship Certificate",
  "Residency Certificate",
  "Internship Certificate",
  "Other",
];

export const getHealthRecordTypes = (category) => {
  if (category === "Vaccination") return VACCINATION_TYPES;
  if (category === "Titer / Immunity") return TITER_TYPES;
  if (category === "TB Test") return TB_TEST_TYPES;
  if (category === "Drug Screen") return DRUG_SCREEN_TYPES;
  if (category === "Fit Test") return FIT_TEST_TYPES;
  return [];
};

/** Result choices for a health-record category (empty = free text). */
export const getHealthRecordResults = (category) => {
  if (category === "Titer / Immunity") return TITER_RESULTS;
  if (category === "Drug Screen") return DRUG_SCREEN_RESULTS;
  return [];
};

/** Screening / background-check report types. */
export const SCREENING_TYPES = [
  "Background Screening Report",
  "Drug Screen Report",
  "Occupational Health Panel",
  "OIG / SAM Exclusion Check",
  "Sanctions / Licensure Monitoring",
  "Fingerprinting / Livescan",
  "Other Screening",
];

export const SCREENING_RESULTS = ["Clear", "Review", "Complete", "Pending", "Flagged"];

export const WORK_HISTORY_TYPES = [
  "Full-Time Employed",
  "Part-Time Employed",
  "Independent Contractor",
  "Locum Tenens",
  "Academic Faculty",
  "Fellowship",
  "Residency",
  "Internship",
  "Military Service",
  "Volunteer",
  "Other",
];

export const REFERENCE_RELATIONSHIPS = [
  "Colleague/Peer",
  "Supervisor/Chair",
  "Partner/Co-Physician",
  "Residency Director",
  "Fellowship Director",
  "Department Head",
  "Medical Director",
  "Other",
];

export const MALPRACTICE_OUTCOMES = [
  "Dismissed/No Merit",
  "Settled - No Admission",
  "Settled - With Conditions",
  "Judgment for Defendant",
  "Judgment for Plaintiff",
  "Pending",
  "Other",
];

export const SECTION_META = {
  license: { label: "License / Certification", icon: "\ud83e\udea3", color: "#6366f1", section: "licenses" },
  cme: { label: "CME Credit", icon: "\ud83d\udcda", color: "#10b981", section: "cme" },
  privilege: { label: "Hospital Privilege", icon: "\ud83c\udfe5", color: "#f59e0b", section: "privileges" },
  insurance: { label: "Insurance Policy", icon: "\ud83d\udee1\ufe0f", color: "#ef4444", section: "insurance" },
  healthRecord: { label: "Health Record", icon: "\ud83d\udc89", color: "#ec4899", section: "healthRecords" },
  education: { label: "Education / Training", icon: "\ud83c\udf93", color: "#8b5cf6", section: "education" },
  agreement: { label: "Contract", icon: "\ud83d\udcdd", color: "#0ea5e9", section: "locumContracts" },
  travel: { label: "ID / Travel Document", icon: "\ud83e\udeaa", color: "#0891b2", section: "travelDocs" },
  // A receipt has two possible homes (Work > Expenses to bill an agency, or
  // the deduction ledger); the scan card picks, so no fixed section here.
  receipt: { label: "Expense Receipt", icon: "\ud83e\uddfe", color: "#d97706", section: null },
  unknown: { label: "Unrecognized Document", icon: "\u2753", color: "#6b7280", section: null },
};
