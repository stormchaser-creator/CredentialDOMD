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

export const CASE_CATEGORIES = [
  "Craniotomy - Tumor",
  "Craniotomy - Vascular",
  "Craniotomy - Trauma",
  "Spinal Fusion - Cervical",
  "Spinal Fusion - Thoracic",
  "Spinal Fusion - Lumbar",
  "Spinal Decompression",
  "VP Shunt",
  "Endoscopic Procedure",
  "Stereotactic/Functional",
  "Peripheral Nerve",
  "Pediatric Neurosurgery",
  "Spine - Minimally Invasive",
  "Interventional",
  "Other",
];

export const HEALTH_RECORD_CATEGORIES = ["Vaccination", "TB Test", "Fit Test"];

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
  if (category === "TB Test") return TB_TEST_TYPES;
  if (category === "Fit Test") return FIT_TEST_TYPES;
  return [];
};

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
  unknown: { label: "Unrecognized Document", icon: "\u2753", color: "#6b7280", section: null },
};
