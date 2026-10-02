export const CME_TOPICS = [
  "Pain Management",
  "Opioid Prescribing",
  "Controlled Substances",
  "Ethics",
  "Infection Control",
  "Patient Safety",
  "Medical Errors Prevention",
  "Risk Management",
  "Suicide Prevention",
  "Cultural Competency",
  "Implicit Bias",
  "End-of-Life Care",
  "Geriatric Medicine",
  "Domestic Violence",
  "Child Abuse Recognition",
  "Human Trafficking",
  "Pharmacology",
  "Telemedicine",
  "Sexual Harassment Prevention",
  "HIV/AIDS",
  "Palliative Care",
  "Mental Health",
  "Substance Use Disorders",
  "Prescriptive Practice",
  "Trauma-Informed Care",
  "General / No Specific Topic",
];

// Topics PA and NP rule data names that the physician list does not
// (DESIGN 2.7). Only names that rule data uses belong here.
export const APP_EXTRA_TOPICS = [
  "Nutrition",
  "Forensic Evidence Collection",
  "Jurisprudence and Ethics",
  "Sexual Assault",
  "Public Health Priorities",
  "Impairment in the Workplace",
  "Autonomous APRN CE",
  "Death Certificates",
  "Dependent Adult Abuse",
  "Pediatric Controlled Substance Ingestion",
  "Terrorism and Weapons of Mass Destruction",
  "Organ and Tissue Donation",
  "Medical Cannabis",
];

/** The topic list a profession tags CME with: MD, DO and blank keep CME_TOPICS. */
export function getCmeTopics(deg) {
  if (deg !== "PA" && deg !== "NP") return CME_TOPICS;
  const general = CME_TOPICS.indexOf("General / No Specific Topic");
  return [...CME_TOPICS.slice(0, general), ...APP_EXTRA_TOPICS, ...CME_TOPICS.slice(general)];
}
