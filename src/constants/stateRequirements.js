// Comprehensive state CME requirements (from Feb 2026 CME Compliance Database)
// States with separate MD/DO boards have { md: {...}, do: {...} } structure.
// States with combined boards have a flat structure.
// States with NO CME requirement (IN, MT, SD) have total: 0.
//
// Provenance: every entry carries `source` (the statute or rule it came from).
// Entries checked against the regulator carry `verified: "YYYY-MM"` and, when
// the check loaded an official page, `sourceUrl` (the best primary-source URL
// for that rule set). Rules that are enacted but not yet in force, or pending
// board action, live in `upcoming: [ "..." ]` so the current numbers stay
// current and the physician still sees what is coming.
// STATE_REQS_META dates the database as a whole. Full 2026-08 recheck:
// docs/CME-RULES-CHANGELOG-2026-08.md.

export const STATE_REQS_META = {
  databaseDate: "2026-02",
  lastReviewed: "2026-08",
  reviewMethod: "primary-source recheck, every jurisdiction, 2026-08-17",
};

export const STATE_REQS = {
  AK: { total: 50, cycle: 2, cat1min: 50, cat1note: "All AMA Cat 1 or AOA Cat 1/2", topics: [
    { topic: "Opioid Prescribing", hours: 2.0, note: "2 hrs pain management & opioid use/addiction (DEA holders)" },
  ], notes: "2 hrs pain management & opioid use/addiction (DEA holders)", rollover: "No (max 15 hrs exemption per 5 yrs)", moc: "ABMS/AOA initial cert or recert accepted", source: "Alaska Admin. Code tit. 12, \u00a7 40.200", verified: "2026-08", sourceUrl: "https://www.commerce.alaska.gov/web/portals/5/pub/med0077.pdf" },
  AL: { total: 25, cycle: 1, cat1min: 25, cat1note: "All AMA PRA Cat 1", topics: [
    { topic: "Controlled Substances", hours: 2.0, note: "2 hrs controlled substance prescribing every 2 yrs (ACSC holders)" },
    { topic: "Ethics", hours: 0, note: "Board-designated professional boundaries course (one-time; existing licensees by 12/31/2025, new licensees within 12 months of license issue; residents/fellows on limited license exempt)" },
  ], notes: "2 hrs controlled substance prescribing every 2 yrs (ACSC holders); Board-designated professional boundaries course (one-time; existing licensees by 12/31/2025, new licensees within 12 months of license issue; residents/fellows on limited license exempt)", rollover: "No", moc: "ABMS cert/MoC accepted as equivalent", source: "Ala. Admin. Code r. 540-X-14-.02; r. 540-X-4-.09(8) (controlled substance CME)", verified: "2026-08", sourceUrl: "https://www.albme.gov/resources/licensees/continuing-medical-education/licensure-cme-requirement" },
  AR: { total: 20, cycle: 1, cat1min: 10, cat1note: "50% must be Cat 1 in primary practice area", topics: [
    { topic: "Opioid Prescribing", hours: 1.0, note: "1 hr/yr prescribing opioids/benzodiazepines" },
    { topic: "Controlled Substances", hours: 3.0, note: "one-time 3 hrs prescribing ed (first 2 yrs)" },
  ], notes: "1 hr/yr prescribing opioids/benzodiazepines; one-time 3 hrs prescribing ed (first 2 yrs)", rollover: "No", moc: "No", source: "ASMB Rule 17 (CME) and Rule 2 (prescriber education), armedicalboard.org/professionals/pdf/mpa.pdf", verified: "2026-08", sourceUrl: "https://www.armedicalboard.org/professionals/pdf/mpa.pdf" },
  AZ: { md: { total: 40, cycle: 2, cat1min: 0, cat1note: "Not specified", topics: [
    { topic: "Opioid Prescribing", hours: 3.0, note: "3 hrs opioid/SUD/addiction (DEA holders)" },
  ], notes: "3 hrs opioid/SUD/addiction (DEA holders)", rollover: "No", moc: "No", source: "Ariz. Admin. Code R4-16-102", verified: "2026-08", sourceUrl: "https://www.law.cornell.edu/regulations/arizona/Ariz-Admin-Code-SS-R4-16-102" }, do: { total: 40, cycle: 2, cat1min: 24, cat1note: "24 hrs AOA Cat 1-A; max 16 hrs AMA Cat 1", topics: [
    { topic: "Opioid Prescribing", hours: 3.0, note: "3 hrs opioid/SUD/addiction (DEA holders)" },
  ], notes: "3 hrs opioid/SUD/addiction (DEA holders)", rollover: "No", moc: "No", source: "Ariz. Admin. Code R4-22-207", verified: "2026-08", sourceUrl: "https://www.law.cornell.edu/regulations/arizona/Ariz-Admin-Code-SS-R4-16-102" } },
  CA: { md: { total: 50, cycle: 2, cat1min: 50, cat1note: "All Cat 1 approved", topics: [
    { topic: "Pain Management", hours: 12.0, note: "One-time 12 hrs pain management/terminally ill (by 2nd renewal)" },
    { topic: "Geriatric Medicine", hours: 0, note: "geriatrics if >25% patients 65+" },
    { topic: "Implicit Bias", hours: 0, note: "AB 241: CME must include implicit bias content (verified 2026-07)" },
  ], notes: "One-time 12 hrs pain management/terminally ill (by 2nd renewal); geriatrics if >25% patients 65+; implicit bias content required (AB 241)", rollover: "No", moc: "ABMS cert/recert = 4 yrs (100 hrs) credit", source: "Cal. Code Reg. tit. 16, \u00a7 1336; AB 241", verified: "2026-08", sourceUrl: "https://www.mbc.ca.gov/Licensing/Physicians-and-Surgeons/Renew/Current-Status/Continuing-Medical-Education.aspx" }, do: { total: 50, cycle: 2, cat1min: 20, cat1note: "20 hrs AOA Cat 1A or 1B", topics: [
    { topic: "Pain Management", hours: 12.0, note: "One-time 12 hrs pain management/terminally ill, within 4 yrs of licensure or by 2nd renewal, whichever first; pathology and radiology exempt" },
    { topic: "Substance Use Disorders", hours: 1.0, note: "Min 1 hr on addiction to Schedule II drugs or opioids each renewal cycle (OMBC CME document effective 2025-10-01; BPC 2454.5)" },
    { topic: "Implicit Bias", hours: 0, note: "AB 241: CME must include implicit bias content" },
  ], notes: "One-time 12 hrs pain management/terminally ill (within 4 yrs of licensure or by 2nd renewal; pathology and radiology exempt); min 1 hr Schedule II/opioid addiction each cycle; implicit bias content (AB 241). 50/2yr + 20 AOA 1-A/1-B verified vs OMBC 2026-07", rollover: "No", moc: "No", source: "OMBC (Cal. B&P Code \u00a7 2454.5); AB 241", verified: "2026-08", sourceUrl: "https://www.ombc.ca.gov/licensees/cme" } },
  CO: { total: 30, cycle: 2, cat1min: 30, cat1note: "All 30 hrs must be from accepted programs: AMA PRA Category 1 (ACCME), AAFP Prescribed credit, AOA Category 1-A, or programs required to maintain national board certification (not self-claimed). Applies to renewals on or after Jan 1 2026.", topics: [
    { topic: "Substance Use Disorders", hours: 2.0, note: "2 cumulative hrs substance use prevention training each renewal (opioid prescribing best practices, SUD recognition and referral, PDMP use); counts within the 30 hrs. Exempt if you hold national board certification requiring equivalent training or attest you do not prescribe opioids." },
  ], notes: "30 hrs accepted CME per 2-yr renewal, including 2 hrs SUD training. Prorated for a first renewal under 24 months (22/15/10/5/0 hrs by time licensed). Board may audit up to 5% of physicians annually, oversampling non-board-certified. Board may waive first renewal if licensed within 12 months of finishing training. Verified vs DORA and CRS 12-240-130.5, 2026-08.", rollover: "No", moc: "Programs required to maintain national board certification count toward the 30 hrs; board cert with equivalent SUD training exempts the 2-hr SUD requirement", source: "HB 24-1153 (effective 2026-01-01)", verified: "2026-08", sourceUrl: "https://dpo.colorado.gov/Medical/CME", upcoming: [
    "Board stakeholder process (per CRS 12-240-130.5(7)(b)(II)) is considering required CME in health disparities and outcomes data, reproductive/sexual/gender-based health care, and explicit/implicit bias; no adopted rule or hour count found in loaded sources; any mandate must fit within the 30 hrs",
  ] },
  CT: { total: 50, cycle: 2, cat1min: 0, cat1note: "Not specified", topics: [
    { topic: "Infection Control", hours: 1.0, note: "infectious diseases including AIDS/HIV, first renewal in which CME is required, then once every 6 years" },
    { topic: "Risk Management", hours: 1.0, note: "includes prescribing controlled substances and pain management, plus screening for inflammatory breast cancer, GI cancers and endometriosis; first renewal in which CME is required, then once every 6 years" },
    { topic: "Sexual Assault", hours: 1.0, note: "first renewal in which CME is required, then once every 6 years" },
    { topic: "Domestic Violence", hours: 1.0, note: "first renewal in which CME is required, then once every 6 years" },
    { topic: "Cultural Competency", hours: 1.0, note: "includes systemic racism, explicit and implicit bias, racial disparities, and care of transgender and gender diverse persons; first renewal in which CME is required, then once every 6 years" },
    { topic: "Behavioral Health", hours: 2.0, note: "mental health conditions common to veterans and their families (PTSD, suicide risk, depression, grief), or suicide prevention, or cognitive conditions (Alzheimer's, dementia, delirium); first renewal in which CME is required, then once every 6 years" },
  ], notes: "Six mandated topics (infectious diseases, risk management, sexual assault, domestic violence, cultural competency, behavioral health) required in the first renewal in which CME is required and then once every 6 years. CME is not required for the first license renewal. Same rule for MD and DO.", rollover: "No (up to 10 hr waiver for Board service)", moc: "No", source: "Conn. Gen. Stat. \u00a7 20-10b", verified: "2026-08", sourceUrl: "https://portal.ct.gov/dph/practitioner-licensing--investigations/physician/continuing-medical-education" },
  DC: { total: 50, cycle: 2, cat1min: 50, cat1note: "All Cat 1; 10% (5 hrs) in public health priorities", topics: [
    { topic: "Cultural Competency", hours: 2.0, note: "2 hrs LGBTQ cultural competency" },
    { topic: "Pharmacology", hours: 0, note: "1 pharmacology course" },
  ], notes: "2 hrs LGBTQ cultural competency; 1 pharmacology course", rollover: "No", moc: "No", source: "D.C. Mun. Regs. tit.17, \u00a7 4607.4", verified: "2026-08", sourceUrl: "https://dchealth.dc.gov/bomed" },
  DE: { total: 40, cycle: 2, cat1min: 40, cat1note: "All AMA or AOA Cat 1", topics: [
    { topic: "Controlled Substances", hours: 2.0, note: "2 hrs controlled substance prescribing, chronic pain, or related topics biennially, required of every Delaware controlled substance registration (CSR) holder; plus a one-time 1 hr course on Delaware controlled substance law within the first year of CSR registration" },
  ], notes: "2 hrs controlled substance prescribing, chronic pain, or related topics biennially (every Delaware CSR holder); one-time 1 hr Delaware controlled substance law course within the first year of CSR registration", rollover: "No", moc: "No", source: "24 Del. Admin. Code 1700-12.0; 24 DE Admin Code Uniform Controlled Substances Act Regulations 3.1; 24 Del. C. 1713(d)", verified: "2026-08", sourceUrl: "https://dpr.delaware.gov/boards/medicalpractice/continuing-education-and-audit-information/", upcoming: [
    "Alzheimer's/dementia CE (24 Del. C. 1713(d)): 2 hrs of the 40 required at the 2027 renewal (cycle ending March 31, 2027) and each renewal after; exempt with attestation if no direct care of adults age 26+, no practice in Delaware, or previously completed in a prior period (so effectively one-time once done). Not yet reflected in Board regulation 1700-12.0.",
  ] },
  FL: { md: { total: 40, cycle: 2, cat1min: 0, cat1note: "Cat 1 for required topics", topics: [
    { topic: "HIV/AIDS", hours: 1.0, note: "1 hr HIV/AIDS, one-time, due by first renewal" },
    { topic: "Medical Errors Prevention", hours: 2.0, note: "2 hrs medical errors" },
    { topic: "Domestic Violence", hours: 2.0, note: "2 hrs domestic violence (every 3rd renewal)" },
    { topic: "Controlled Substances", hours: 2.0, note: "2 hrs prescribing controlled substances, each renewal, DEA registrants only" },
    { topic: "Human Trafficking", hours: 1.0, note: "1 hr human trafficking, one-time (s. 456.0341; deadline was Jan 1, 2021; counts toward the 40)" },
  ], notes: "2 hrs medical errors; 2 hrs controlled substances (DEA registrants); 2 hrs domestic violence every 3rd renewal; 1 hr HIV/AIDS one-time by first renewal; 1 hr human trafficking one-time", rollover: "No", moc: "No", source: "Fla. Admin. Code. Ann. r. 64B8-13.005", verified: "2026-08", sourceUrl: "https://flboardofmedicine.gov/medical-doctor-renewal/" }, do: { total: 40, cycle: 2, cat1min: 20, cat1note: "20 hrs AOA Cat 1-A", topics: [
    { topic: "HIV/AIDS", hours: 1.0, note: "1 hr HIV/AIDS, one-time, no later than first renewal" },
    { topic: "Medical Errors Prevention", hours: 2.0, note: "2 hrs medical errors" },
    { topic: "Controlled Substances", hours: 2.0, note: "2 hrs prescribing controlled substances, each renewal, DEA registrants only" },
    { topic: "Florida Laws and Rules", hours: 1.0, note: "1 hr Florida Laws and Rules/Professional and Medical Ethics, each renewal" },
    { topic: "Domestic Violence", hours: 2.0, note: "2 hrs domestic violence, every third biennial renewal" },
    { topic: "Human Trafficking", hours: 1.0, note: "1 hr human trafficking, one-time (s. 456.0341)" },
  ], notes: "2 hrs medical errors; 1 hr FL laws and rules/ethics; 2 hrs controlled substances (DEA registrants); 2 hrs domestic violence every 3rd renewal; 1 hr HIV/AIDS one-time by first renewal; 1 hr human trafficking one-time; max 8 hrs home study", rollover: "No", moc: "No", source: "Fla. Admin. Code. Ann. r. 64B15-13.001", verified: "2026-08", sourceUrl: "https://floridasosteopathicmedicine.gov/renewals/osteopathic-physician-renewal/" } },
  GA: { total: 40, cycle: 2, cat1min: 0, cat1note: "AMA Cat 1, AOA Cat 1, AAFP, ACOG, or ACEP Cat 1", topics: [
    { topic: "Opioid Prescribing", hours: 3.0, note: "3 hrs Cat 1 controlled substance prescribing, one-time (active DEA holders who prescribe controlled substances; not required if meeting the 20 hr pain mgmt rule)" },
    { topic: "Sexual Harassment Prevention", hours: 2.0, note: "one-time 2 hr professional boundaries/sexual misconduct course" },
  ], notes: "one-time 3 hrs Cat 1 controlled substance prescribing (DEA holders); one-time 2 hr professional boundaries/sexual misconduct course; 20 hrs pain mgmt per cycle if 50% or more opioid pain patients and no pain/palliative certification", rollover: "No (waivers: up to 10 hrs per biennium for uncompensated care at 1 hr per 4 hrs worked; up to 8 hrs per biennium for Board peer review at 2 hrs per case)", moc: "Not addressed in rule; Board accepts only AMA Cat 1, AOA Cat 1, AAFP Prescribed, ACOG Cat 1 Cognates, ACEP Cat 1", source: "Ga. Comp. R. & Regs. 360-15-.01", verified: "2026-08", sourceUrl: "https://medicalboard.georgia.gov/professional-resources/continuing-education-and-other-required-training-physicians" },
  GU: { total: 50, cycle: 2, cat1min: 13, cat1note: "25% must be Cat 1 (13 of 50; statute and board form still disagree, confirm with the board)", topics: [], notes: "Board FAQ lists 50 credit hours per 2-year renewal cycle. 25 GAR \u00a711103(c)(2) (1997) still reads 100 hours with 25% Category I, and the GBME-9 CME report form reads 100 hours with 50 Category I. Confirm the current figure with the board. Renew by December 31 of odd-numbered years. CME requirement is deemed met with a current AMA PRA or similar accrediting certification (\u00a711103(d)).", rollover: "No", moc: "", source: "25 GAR Prof. & Voc. Regs \u00a7 11103(c)(2); GBME FAQ", verified: "2026-08", sourceUrl: "https://guamhplo.org/gbme/faqs" },
  HI: { total: 40, cycle: 2, cat1min: 40, cat1note: "All Cat 1 or 1A", topics: [], notes: "MD renews by Jan 31 of even years, DO by June 30 of even years, both under the Hawaii Medical Board. First renewal after initial licensure: 20 hours. Meeting a specialty society or board CME requirement of 40+ hours, or a current AMA PRA, satisfies the requirement. Board certification alone, passing a board exam, membership, or teaching do not count.", rollover: "No", moc: "No", source: "Haw. Admin. R. \u00a716-85-33", verified: "2026-08", sourceUrl: "https://cca.hawaii.gov/pvl/boards/medical/physician-podiatrist-and-emt-continuing-education-requirements/" },
  IA: { total: 40, cycle: 2, cat1min: 40, cat1note: "All 40 hours must be Category 1 (or board-approved equivalent such as ABMS/AOA certification)", topics: [
    { topic: "Child Abuse Recognition", hours: 2.0, note: "2 hrs child abuse every 3 yrs (pediatric primary care providers, incl. EM, FM, GP, peds, psychiatry)" },
    { topic: "Dependent Adult Abuse", hours: 2.0, note: "2 hrs dependent adult abuse every 3 yrs (adult primary care providers)" },
    { topic: "Opioid Prescribing", hours: 2.0, note: "2 hrs opioid prescribing every 5 yrs (if prescribed)" },
    { topic: "End-of-Life Care", hours: 2.0, note: "2 hrs end-of-life care every 5 yrs (if regularly caring for actively dying patients)" },
  ], notes: "2 hrs child abuse every 3 yrs (pediatric primary care providers, incl. EM, FM, GP, peds, psychiatry); 2 hrs dependent adult abuse every 3 yrs (adult primary care providers); 2 hrs opioid prescribing every 5 yrs (if prescribed); 2 hrs end-of-life care every 5 yrs (if regularly caring for actively dying patients)", rollover: "Yes (up to 20 hrs)", moc: "ABMS/AOA cert or recert = 50 hrs Cat 1", source: "Iowa Admin. Code r. 481-654.3 (formerly 653-11; transferred IAC Supp. 6/11/25)", verified: "2026-08", sourceUrl: "https://www.legis.iowa.gov/docs/iac/chapter/481.654.pdf" },
  ID: { total: 40, cycle: 2, cat1min: 40, cat1note: "All Cat 1", topics: [], notes: "Not specified", rollover: "No", moc: "ABMS/AOA/RCPSC cert or recert accepted", source: "Idaho Admin. Code r. 22.01.01-079", verified: "2026-08", sourceUrl: "https://dopl.idaho.gov/bom/" },
  IL: { total: 150, cycle: 3, cat1min: 60, cat1note: "60 hrs Cat 1", topics: [
    { topic: "Sexual Harassment Prevention", hours: 1.0, note: "1 hr sexual harassment prevention (each cycle)" },
    { topic: "Implicit Bias", hours: 1.0, note: "1 hr implicit bias (each cycle)" },
    { topic: "Opioid Prescribing", hours: 1.0, note: "1 hr safe opioid prescribing each renewal cycle, only if you hold an Illinois controlled substance license" },
    { topic: "Cultural Competency", hours: 1.0, note: "1 hr cultural competency, before first renewal then once every 6 years (renewals on or after Jan 1, 2025)" },
    { topic: "Alzheimer's Disease and Other Dementias", hours: 1.0, note: "1 hr Alzheimer's disease and other dementias, before first renewal then once every 6 years (renewals on or after Jan 1, 2025)" },
  ], notes: "1 hr sexual harassment prevention (each cycle); 1 hr implicit bias (each cycle); 1 hr safe opioid prescribing each cycle if you hold an IL controlled substance license; 1 hr cultural competency and 1 hr Alzheimer's/dementia, each once every 6 years; 1 hr mandated reporter training every 6 years. All count toward the 150.", rollover: "No", moc: "Board cert/licensure CME from other states accepted", source: "Ill. Admin. Code tit.68, \u00a7 1285.110; 720 ILCS 570/315.5", verified: "2026-08", sourceUrl: "https://idfpr.illinois.gov/dpr/continuing-education.html", upcoming: [
    "2026 physician renewal deadline extended from July 31 to August 31, 2026 (IDFPR notice, one-time extension, not a rule change)",
  ] },
  IN: { total: 0, cycle: 0, cat1min: 0, cat1note: "", topics: [], notes: "No CME requirement", rollover: "No", moc: "", source: "No statutory CME requirement", verified: "2026-08", sourceUrl: "https://www.in.gov/pla/professions/physicians-home/physicians-licensing-information/" },
  KS: { total: 50, cycle: 1, cat1min: 20, cat1note: "20 Cat 1 per year (or 40/100 per 2/3-yr cycle)", topics: [
    { topic: "Opioid Prescribing", hours: 3.0, note: "1-3 hrs (per cycle length) pain mgmt/opioid prescribing/PDMP" },
  ], notes: "1-3 hrs (per cycle length) pain mgmt/opioid prescribing/PDMP", rollover: "No", moc: "No", source: "Kan. Admin. Regs. \u00a7 100-15-5", verified: "2026-08", sourceUrl: "https://sos.ks.gov/publications/Register/Volume-40/Issues/Issue%2016/04-22-21-49068.html" },
  KY: { total: 60, cycle: 3, cat1min: 30, cat1note: "30 hrs Cat 1", topics: [
    { topic: "Controlled Substances", hours: 4.5, note: "4.5 hrs Cat 1 KASPER/pain mgmt/addiction per cycle (controlled substance prescribers, prorated 3 or 1.5 hrs if first authorized mid-cycle)" },
    { topic: "Domestic Violence", hours: 3.0, note: "3 hrs domestic violence, one-time within 3 yrs of initial licensure (primary care: family/general practice, pediatrics, internal medicine, emergency medicine, OB/GYN, preventive medicine/public health)" },
    { topic: "Pediatric Abusive Head Trauma", hours: 1.0, note: "1 hr pediatric abusive head trauma, one-time within 5 yrs of licensure (pediatrics, radiology, family medicine, emergency medicine, urgent care)" },
  ], notes: "4.5 hrs Cat 1 KASPER/pain mgmt/addiction per cycle (controlled substance prescribers, prorated 3 or 1.5 hrs if first authorized mid-cycle); 3 hrs domestic violence one-time (primary care); 1 hr pediatric abusive head trauma one-time (peds, radiology, FM, EM, urgent care); 12 hrs Cat 1 addiction medicine per cycle for buprenorphine prescribers (201 KAR 9:270)", rollover: "No", moc: "Yes (passing an ABMS or AOA board certification or recertification exam counts as 60 hrs Cat 1, satisfies full cycle)", source: "201 KAR 9:310", verified: "2026-08", sourceUrl: "https://kbml.ky.gov/cme/Pages/default.aspx" },
  LA: { total: 20, cycle: 1, cat1min: 20, cat1note: "All Cat 1", topics: [
    { topic: "Controlled Substances", hours: 3.0, note: "One-time 3 hr CDS prescribing CME before first renewal (CDS holders; exemption if no CDS prescribed in prior year)" },
    { topic: "Nutrition / Metabolic Health", hours: 1.0, note: "1 hr nutrition/metabolic health every 4 yrs, counted within the 20 hrs; applies to physicians practicing family medicine, internal medicine, pediatrics, psychiatry, endocrinology, gastroenterology, cardiology, oncology, rheumatology, neurology, nephrology, dermatology, pulmonology, surgery, immunology, hematology, obstetrics, gynecology (eff. Jan 1, 2026)" },
    { topic: "Sickle Cell (Emergency Medicine)", hours: 1.0, note: "Physicians (and PAs) practicing emergency medicine: initial 1 hr board-approved course on treatment of sickle cell disease, then 1 hr refresher at least every 3 yrs (eff. Aug 1, 2024). Board-approved course to be posted on lsbme.la.gov; not located on the site during this check." },
  ], notes: "One-time 3 hr CDS prescribing CME before first renewal (CDS holders; exemption if no CDS prescribed in prior year); one-time Laws and Rules Course before first renewal (hour-for-hour credit); 1 hr nutrition/metabolic health every 4 yrs for listed specialties (eff. Jan 1, 2026, counts within the 20); emergency medicine: 1 hr sickle cell initial then 1 hr every 3 yrs; ABMS/AOA certification or recertification within past year satisfies annual CME; CE Broker tracking mandatory; renewal in birth month.", rollover: "No", moc: "Yes: annual CME requirement does not apply to a physician certified or recertified by an ABMS member board or AOA-recognized specialty board within the past year (LAC 46:XLV.447.A.3). Note: initial-renewal Laws and Rules course and CDS CME are still required (\u00a7447 is subject to \u00a7449).", source: "La. Admin. Code tit. 46, pt. XLV \u00a7\u00a7435-449, \u00a74005; R.S. 37:1270(A)(8)", verified: "2026-08", sourceUrl: "https://www.lsbme.la.gov/content/board-orientations-online-courses", upcoming: [
    "Pending LAC 46:XLV.417/418/435/447 amendment (Notice of Intent Jan 2026 Register 52 LR 114, OLRP review Apr-May 2026): CME credit for medical review panel service and reporting updates; no change to the 20 hr total. Final adoption date not confirmed.",
  ] },
  MA: { total: 50, cycle: 2, cat1min: 0, cat1note: "Cat 1 or 2 (ACCME/AOA/AAFP accredited)", topics: [
    { topic: "Opioid Prescribing", hours: 3.0, note: "3 hrs opioid/pain mgmt (if prescribing controlled substances)" },
    { topic: "Risk Management", hours: 10.0, note: "10 hrs risk mgmt (Cat 1 or 2, up to 7 hrs wellness/burnout count)" },
    { topic: "End-of-Life Care", hours: 2.0, note: "2 hrs end-of-life (one-time)" },
    { topic: "Electronic Health Records", hours: 3.0, note: "3 hrs EHR proficiency (one-time; may count toward risk mgmt)" },
    { topic: "Implicit Bias", hours: 2.0, note: "2 hrs implicit bias (one-time; counts toward risk mgmt)" },
    { topic: "Child Abuse Recognition", hours: 0, note: "child abuse and neglect training (one-time, no hour minimum)" },
    { topic: "Domestic Violence", hours: 0, note: "domestic and sexual violence training, DPH-approved course (one-time, no hour minimum)" },
    { topic: "Geriatric Medicine", hours: 1.0, note: "1 hr Alzheimer's/dementia (one-time, if serving adult populations)" },
  ], notes: "Per cycle: 3 hrs opioid/pain mgmt (if prescribing controlled substances); 10 hrs risk mgmt (Cat 1 or 2, up to 7 hrs wellness/burnout count); 2 hrs reading Board regs. One-time: 2 hrs end-of-life; 3 hrs EHR; 2 hrs implicit bias; 1 hr Alzheimer's (adult populations); child abuse training; domestic/sexual violence training", rollover: "No", moc: "Yes: ABMS/AOA board certification or recertification = 60 Cat 1 credits incl. 4 risk mgmt, applied to the cycle in which pass notice is received", source: "BORIM Policy 17-05 (amended 4/11/2024); Final Amended CME Guidelines (amended 4/11/2024); Policy 94-05 (amended 3/28/2024)", verified: "2026-08", sourceUrl: "https://www.mass.gov/info-details/general-physician-licensing-questions" },
  MD: { total: 50, cycle: 2, cat1min: 25, cat1note: "25 hrs Cat 1", topics: [
    { topic: "Controlled Substances", hours: 2.0, note: "2 hrs CE on prescribing or dispensing controlled dangerous substances, one-time, required by MDH OCSA for CDS registration (new or first renewal on or after Oct 1, 2018), not a Board of Physicians renewal requirement" },
    { topic: "Implicit Bias", hours: 0, note: "one-time implicit bias training; plus one-time structural racism training for licensees renewing for the first time after April 1, 2026 (HO 1-225). ACCME-accredited or board-recognized program." },
  ], notes: "2 hrs controlled substance prescribing CE, one-time, for CDS registration; one-time implicit bias training; one-time structural racism training at first renewal after April 1, 2026; CME requirement waived at first renewal after initial licensure", rollover: "No", moc: "Active time-limited ABMS/AOA cert accepted (within 5 yrs)", source: "COMAR 10.32.01.10", verified: "2026-08", sourceUrl: "https://www.mbp.state.md.us/forms/2026_renewal_info.pdf" },
  ME: { md: { total: 40, cycle: 2, cat1min: 40, cat1note: "All Cat 1", topics: [
    { topic: "Opioid Prescribing", hours: 3.0, note: "3 hrs opioid prescribing every 2 yrs" },
  ], notes: "3 hrs opioid prescribing every 2 yrs", rollover: "No", moc: "Yes: current ABMS certification with MOC counts as the 40 Cat 1 hrs (lifetime certs excluded); 3 hrs opioid CME still required", source: "ME BLM Rules ch. 1 s. 11 (amended eff. Feb 3, 2026); ME BLM CME Information", verified: "2026-08", sourceUrl: "https://www.maine.gov/md/licensure/license-faq" }, do: { total: 100, cycle: 2, cat1min: 0, cat1note: "40 hrs osteopathic medical ed; primary care: all AOA Cat 1", topics: [
    { topic: "Opioid Prescribing", hours: 3.0, note: "3 hrs opioid prescribing every 2 yrs, applies to DOs who prescribe opioids (32 MRS 2600-C)" },
  ], notes: "3 hrs opioid prescribing every 2 yrs (DOs who prescribe opioids, 32 MRS 2600-C)", rollover: "No", moc: "No", source: "02 ME Code Rules \u00a7 383-14-1", verified: "2026-08", sourceUrl: "https://legislature.maine.gov/statutes/32/title32sec2600-C.html" } },
  MI: { md: { total: 150, cycle: 3, cat1min: 75, cat1note: "75 hrs Cat 1", topics: [
    { topic: "Ethics", hours: 1.0, note: "1 hr medical ethics" },
    { topic: "Pain Management", hours: 3.0, note: "3 hrs pain/symptom management" },
    { topic: "Implicit Bias", hours: 1.0, note: "1 hr/yr implicit bias (eff. 2022)" },
    { topic: "Human Trafficking", hours: 0, note: "one-time human trafficking" },
    { topic: "Opioid Awareness", hours: 0, note: "one-time opioids and controlled substance awareness training, controlled substance licensees only (R 338.3135)" },
  ], notes: "1 hr medical ethics; 3 hrs pain/symptom management; 1 hr/yr implicit bias (eff. 2022); one-time human trafficking; one-time opioid/controlled substance awareness training (controlled substance licensees)", rollover: "No", moc: "30 hrs for ABMS MOC activities", source: "LARA MD Licensing Guide", verified: "2026-08", sourceUrl: "https://www.michigan.gov/lara/bureau-list/bpl/health/hp-lic-health-prof/medical/medical-doctor-licensing-guides-and-faqs/md-licensing-guide-and-faqs" }, do: { total: 150, cycle: 3, cat1min: 60, cat1note: "60 hrs Cat 1, at least 40 of them AOA or MOA approved", topics: [
    { topic: "Ethics", hours: 1.0, note: "1 hr medical ethics" },
    { topic: "Controlled Substances", hours: 3.0, note: "3 hrs pain/symptom management (1 hr controlled substances)" },
    { topic: "Implicit Bias", hours: 1.0, note: "1 hr/yr implicit bias" },
    { topic: "Human Trafficking", hours: 0, note: "one-time human trafficking" },
    { topic: "Opioid Awareness", hours: 0, note: "one-time opioids and controlled substance awareness training, controlled substance licensees only (R 338.3135)" },
  ], notes: "1 hr medical ethics; 3 hrs pain/symptom management (1 hr controlled substances); 1 hr/yr implicit bias; one-time human trafficking; one-time opioid/controlled substance awareness training (controlled substance licensees)", rollover: "No", moc: "No", source: "LARA DO Licensing Guide", verified: "2026-08", sourceUrl: "https://www.law.cornell.edu/regulations/michigan/Mich-Admin-Code-R-338-143" } },
  MN: { total: 75, cycle: 3, cat1min: 75, cat1note: "All Cat 1", topics: [], notes: "Not specified", rollover: "No", moc: "ABMS/AOA/RCPSC cert or recert accepted", source: "Minnesota Rules, parts 5605.0100 and 5605.0300", verified: "2026-08", sourceUrl: "https://mn.gov/boards/medical-practice/licensing/continuing-ed/" },
  MO: { total: 50, cycle: 2, cat1min: 50, cat1note: "All AMA Cat 1, AOA Cat 1A/2A, or AAFP Prescribed (or 40 hrs AMA Cat 1/AOA 1A, each activity with post-test)", topics: [
    { topic: "Nutrition / Metabolic Health", hours: 1.0, note: "1 hr on the health benefits of nutrition, per 2-year cycle, within the 50 hrs; all licensees" },
  ], notes: "Cycle is fixed calendar: Jan 1 even year to Dec 31 odd year. Exempt in initial licensure period; residency/fellowship 60+ days in period counts as full compliance.", rollover: "No", moc: "ABMS cert/recert during reporting period accepted", source: "20 CSR 2150-2.125", verified: "2026-08", sourceUrl: "https://www.sos.mo.gov/cmsimages/adrules/csr/current/20csr/20c2150-2.pdf" },
  MP: { total: 50, cycle: 2, cat1min: 50, cat1note: "All Cat 1", topics: [], notes: "Not specified", rollover: "No", moc: "No", source: "Title 185-10-4215", verified: "2026-08", sourceUrl: "https://cnmilaw.org/pdf/admincode/T185/T185-10.pdf" },
  MS: { total: 40, cycle: 2, cat1min: 40, cat1note: "All Cat 1", topics: [
    { topic: "Controlled Substances", hours: 8.0, note: "One-time 8-hour DEA training on opioid or other substance use disorders (Controlled Substances Act Section 303) for licensees holding an active DEA registration; the 5-hour per-cycle prescribing requirement was removed from Rule 2.1" },
  ], notes: "DEA registrants: one-time 8-hour DEA opioid/SUD training satisfies the Board's controlled substance requirement. Licensees must keep CME in a Board-approved tracker (CE Broker, ACCME, ABMS, AOA); active ABMS/AOA certification exempts from the tracker. Cycle runs July 1 to June 30 of even years, certified at renewal in even years.", rollover: "No", moc: "No", source: "30 Miss. Admin. Code Pt. 2610 Ch. 2, Rule 2.1 (amended, effective Feb 27, 2026)", verified: "2026-08", sourceUrl: "https://www.msbml.ms.gov/licensure/cme-requirements" },
  MT: { total: 0, cycle: 0, cat1min: 0, cat1note: "", topics: [], notes: "No CME requirement", rollover: "No", moc: "", source: "No statutory CME requirement", verified: "2026-08", sourceUrl: "https://boards.bsd.dli.mt.gov/medical-examiners/faq" },
  NC: { total: 60, cycle: 3, cat1min: 60, cat1note: "All Cat 1 (in specialty/practice area)", topics: [
    { topic: "Controlled Substances", hours: 3.0, note: "3 hrs controlled substance prescribing" },
  ], notes: "3 hrs controlled substance prescribing", rollover: "No", moc: "ABMS/AOA/RCPSC recert/MOC = entire requirement", source: "N.C. Admin. Code tit. 21, r. 32R.0101", verified: "2026-08", sourceUrl: "https://www.ncmedboard.org/resources-information/faqs/professional-faqs/cme" },
  ND: { total: 40, cycle: 2, cat1min: 40, cat1note: "All Cat 1", topics: [], notes: "Not specified", rollover: "No", moc: "ABMS/AOA/RCPSC cert/MOC exempt from CME", source: "N.D. Admin. Code 50-04-01 (hours in 50-04-01-01, MOC exemption in 50-04-01-02)", verified: "2026-08", sourceUrl: "https://www.ndbom.org/practitioners/physicians/current/cme.asp" },
  NE: { total: 50, cycle: 2, cat1min: 50, cat1note: "All Cat 1", topics: [
    { topic: "Opioid Prescribing", hours: 3.0, note: "3 hrs opioid prescribing (incl. 0.5 hr PDMP) biennially (controlled substance prescribers)" },
  ], notes: "3 hrs opioid prescribing (incl. 0.5 hr PDMP) biennially (controlled substance prescribers)", rollover: "Yes (up to 25 hrs)", moc: "AMA PRA or AOA CME Certification accepted", source: "Neb. Admin. R. & Regs. Tit. 172, Ch. 88", verified: "2026-08", sourceUrl: "https://dhhs.ne.gov/licensure/pages/medicine-and-surgery.aspx", upcoming: [
    "Neb. Rev. Stat. 38-145(6) opioid/PDMP CE requirement terminates January 1, 2029 unless extended",
  ] },
  NH: { total: 100, cycle: 2, cat1min: 40, cat1note: "40 hrs Cat 1; max 60 hrs Cat 2", topics: [
    { topic: "Pain Management", hours: 3.0, note: "3 hrs pain management/addiction disorders (NH-DEA holders)" },
  ], notes: "3 hrs pain management/addiction disorders (NH-DEA holders)", rollover: "No", moc: "ABMS board exam = 100 hrs Cat 1", source: "N.H. Rev. Stat. \u00a7 329:16-g", verified: "2026-08", sourceUrl: "https://www.law.cornell.edu/regulations/new-hampshire/N-H-Admin-Code-SS-Med-402.01" },
  NJ: { total: 100, cycle: 2, cat1min: 40, cat1note: "40 hrs Cat 1; 60 hrs Cat 1 or 2; 6 hrs cultural competence", topics: [
    { topic: "End-of-Life Care", hours: 2.0, note: "2 hrs end-of-life care" },
    { topic: "Opioid Prescribing", hours: 1.0, note: "1 hr opioid prescribing" },
    { topic: "Sexual Harassment Prevention", hours: 2.0, note: "2 hrs sexual misconduct prevention (eff. 2025)" },
    { topic: "Implicit Bias", hours: 1.0, note: "1 hr implicit bias (perinatal providers)" },
  ], notes: "2 hrs end-of-life care; 1 hr opioid prescribing; 2 hrs sexual misconduct prevention (eff. 2025); 1 hr implicit bias (perinatal providers)", rollover: "Yes, up to 25 excess credits into the next biennial period only", moc: "No", source: "N.J. Admin. Code 13:35-6.15; 13:35-6.25", verified: "2026-08", sourceUrl: "https://www.law.cornell.edu/regulations/new-jersey/N-J-A-C-13-35-6-15" },
  NM: { md: { total: 75, cycle: 3, cat1min: 75, cat1note: "All Cat 1", topics: [
    { topic: "Pain Management", hours: 5.0, note: "5 hrs pain management and controlled substance prescribing every triennial cycle (applies to licensees holding both a federal DEA registration and a NM controlled substance registration); counts toward the 75" },
  ], notes: "5 hrs pain management per triennial cycle (DEA and NM CSR holders); 1 hr review of NM Medical Practice Act and board rules, attested at renewal; CME may be earned July 1 through June 30 of the 3-year licensing period", rollover: "No", moc: "AMA PRA Cat 1; ABMS cert/recert or ABMS CME certificate; AOA active membership; osteopathic specialty board cert/recert; SPEX or COMVEX passage during the cycle", source: "N.M. Admin. Code 16.10.4.8, 16.10.4.10, 16.10.14.11", verified: "2026-08", sourceUrl: "https://www.srca.nm.gov/parts/title16/16.010.0004.html", upcoming: [
    "NM Medical Board IMLC implementation rules projected for board hearing Nov 5-6, 2026 (licensure, not CME)",
  ] }, do: { total: 75, cycle: 3, cat1min: 30, cat1note: "30 AOA Cat 1-A/1-B minimum; 45 may be AMA PRA Cat 1 or equivalent (CCME/AMA/ACCME/AAFP/AACOM/AAPS)", topics: [
    { topic: "Pain Management", hours: 6.0, note: "6 hrs pain management per triennial cycle; counts toward the 75; exempt if no NM controlled substance registration or not practicing in NM" },
  ], notes: "1 credit review of NM Osteopathic Medical Practice Act and board rules, attested at renewal; 6 hrs pain management for NM CSR holders; AOA membership, specialty board cert/recert, SPEX/COMVEX passage accepted", rollover: "No", moc: "AOA active membership, osteopathic specialty board cert/recert, SPEX/COMVEX passage accepted", source: "N.M. Admin. Code 16.17.3.9, 16.17.3.10", verified: "2026-08", sourceUrl: "https://www.srca.nm.gov/parts/title16/16.017.0003.html", upcoming: [
    "NM Medical Board IMLC implementation rules projected for board hearing Nov 5-6, 2026 (licensure, not CME)",
  ] } },
  NV: { md: { total: 40, cycle: 2, cat1min: 40, cat1note: "All Cat 1", topics: [
    { topic: "Pain Management", hours: 2.0, note: "2 hrs ethics/pain mgmt/addiction each biennium" },
    { topic: "Controlled Substances", hours: 2.0, note: "2 hrs controlled substances/opioids/addiction per biennium, only if registered to dispense controlled substances (NRS 630.2535)" },
    { topic: "Suicide Prevention", hours: 2.0, note: "2 hrs suicide detection, intervention and prevention within 2 yrs of licensure, then every 4 yrs" },
    { topic: "Cultural Competency", hours: 2.0, note: "2 hrs cultural competency and DEI every 2 yrs, psychiatrists only" },
    { topic: "HIV Stigma", hours: 2.0, note: "2 hrs stigma, discrimination and unrecognized bias toward persons with or at high risk of HIV, one-time within 2 yrs, only MDs who provide or supervise emergency medical services in a hospital or primary care" },
  ], notes: "20 hrs in specialty; 2 hrs ethics/pain mgmt/addiction each biennium; 2 hrs controlled substances/opioids if registered to dispense; 2 hrs suicide prevention within 2 yrs then every 4 yrs; 2 hrs SBIRT one-time within 2 yrs of licensure; 2 hrs cultural competency/DEI (psychiatrists); 2 hrs HIV stigma one-time (EMS/primary care); up to 4 hrs double credit for geriatrics, medication management, rare diseases; WMD/bioterrorism no longer on board summary (NRS 630.253 text still shows 4 hrs within 2 yrs of licensure)", rollover: "No", moc: "No", source: "NRS 630.253, 630.2535; NAC 630.153", verified: "2026-08", sourceUrl: "https://medboard.nv.gov/uploadedFiles/mednvgov/content/Licensees/CME_Requirements_MDs_PAs_AAs.pdf" }, do: { total: 35, cycle: 1, cat1min: 10, cat1note: "10 AOA or AMA Cat 1A", topics: [
    { topic: "Controlled Substances", hours: 2.0, note: "2 hrs controlled substances/opioids/addiction annually, all DOs (NAC 633.250)" },
    { topic: "Suicide Prevention", hours: 2.0, note: "2 hrs suicide prevention within 2 yrs of licensure, then every 4 yrs" },
    { topic: "Pain Management", hours: 2.0, note: "2 hrs ethics/pain mgmt/addiction, even years only (NRS 633.471(7))" },
    { topic: "Cultural Competency", hours: 2.0, note: "2 hrs cultural competency and DEI biennially, psychiatrists only (NRS 633.471(12))" },
  ], notes: "2 hrs controlled substances/opioids/addiction annually (all DOs); 2 hrs suicide prevention within 2 yrs of licensure then every 4 yrs; 2 hrs ethics/pain mgmt/addiction (even years); 2 hrs cultural competency/DEI biennially (psychiatrists)", rollover: "No", moc: "No", source: "NRS 633.471; NAC 633.250", verified: "2026-08", sourceUrl: "https://bom.nv.gov/uploadedFiles/bomnvgov/content/Licensee/CME_Requirements.pdf" } },
  NY: { total: 0, cycle: 0, cat1min: 0, cat1note: "None (general)", topics: [
    { topic: "Pain Management", hours: 3.0, note: "3 hrs pain mgmt/palliative care/addiction (DEA holders)" },
    { topic: "Child Abuse Recognition", hours: 2.0, note: "2 hrs child abuse/maltreatment" },
    { topic: "Infection Control", hours: 0, note: "infection control every 4 yrs" },
  ], notes: "No CME requirement", rollover: "No", moc: "", source: "N.Y. Comp. Codes tit. 8, \u00a7\u00a7 59.12-13", verified: "2026-08", sourceUrl: "https://www.op.nysed.gov/professions/physicians/nysdoh-mandatory-prescriber-education" },
  OH: { total: 50, cycle: 2, cat1min: 50, cat1note: "All Cat 1", topics: [
    { topic: "Ethics", hours: 1.0, note: "1 hr duty to report" },
    { topic: "Pain Management", hours: 20.0, note: "20 hrs pain medicine (pain clinic operators, incl. addiction)" },
  ], notes: "1 hr duty to report; 20 hrs pain medicine (pain clinic operators, incl. addiction)", rollover: "No", moc: "No", source: "Ohio Admin. Code \u00a7\u00a7 4731-10-02", verified: "2026-08", sourceUrl: "https://codes.ohio.gov/ohio-administrative-code/rule-4731-10-02" },
  OK: { md: { total: 60, cycle: 3, cat1min: 60, cat1note: "All Cat 1", topics: [
    { topic: "Opioid Prescribing", hours: 1.0, note: "1 hr/yr pain management or opioid use/addiction (DEA holders)" },
  ], notes: "1 hr/yr pain management or opioid use/addiction (DEA holders); 1-hr training on provider rights/responsibilities every 2 yrs", rollover: "No", moc: "AMA PRA or ABMS cert/recert accepted", source: "59 O.S. \u00a7 495a.1; OAC 435:10-15-1", verified: "2026-08", sourceUrl: "https://www.okmedicalboard.org/cme/CMEguidelines.pdf" }, do: { total: 16, cycle: 1, cat1min: 16, cat1note: "16 AOA Cat 1 (AMA PRA Cat 1 accepted if ABMS certified)", topics: [
    { topic: "Controlled Substances", hours: 1.0, note: "1 hr/yr controlled substance prescribing (pain management, opioid use, or addiction) for DEA/OBNDD holders" },
  ], notes: "1 hr/yr controlled substance prescribing (pain management, opioid use, or addiction) for DEA/OBNDD holders; 2 hr/yr medical marijuana CME if registered with OMMA as a recommending physician (63 O.S. 427.10); ABMS-certified DOs may use 16 AMA PRA Cat 1 hrs instead of AOA", rollover: "No", moc: "No", source: "OK Admin Code 510:10-3-8", verified: "2026-08", sourceUrl: "https://oklahoma.gov/osboe/resources/title-510/chapter-10/510-10-3.html" } },
  OR: { total: 60, cycle: 2, cat1min: 60, cat1note: "All AMA Cat 1 or AOA Cat 1A/2A", topics: [
    { topic: "Pain Management", hours: 1.0, note: "1 hr Oregon Pain Management Commission course at initial licensure and every 24 months (counts toward the 60 hrs)" },
    { topic: "Cultural Competency", hours: 2.0, note: "Average 1 hr per year (2 hrs per 2-yr cycle), audited every other renewal cycle (about 4 yrs); counts toward the 60 hrs; exempt: residents, Volunteer Camp licensees" },
  ], notes: "1 hr Pain Management Commission course every 24 months; cultural competency avg 1 hr/yr audited every other renewal; suicide risk assessment and dementia CME encouraged, not required", rollover: "No", moc: "ABMS/AOA-BOS recert/MOC accepted as alternative", source: "OAR 847-008-0070; 847-008-0075; 847-008-0077", verified: "2026-08", sourceUrl: "https://secure.sos.state.or.us/oard/view.action?ruleNumber=847-008-0070" },
  PA: { md: { total: 100, cycle: 2, cat1min: 20, cat1note: "20 hrs Cat 1", topics: [
    { topic: "Patient Safety", hours: 12.0, note: "12 hrs patient safety/risk management" },
    { topic: "Child Abuse Recognition", hours: 2.0, note: "2 hrs child abuse recognition and reporting" },
    { topic: "Pain Management", hours: 2.0, note: "2 hrs pain management, identification of addiction, or prescribing/dispensing opioids; applies only if you hold or use a DEA registration" },
    { topic: "Organ and Tissue Donation", hours: 2.0, note: "2 hrs organ and tissue donation and recovery process, one time within 5 years of initial licensure or of renewal/reactivation, Cat 1 or 2, counts toward the 100" },
  ], notes: "12 hrs patient safety/risk management; 2 hrs child abuse recognition and reporting; 2 hrs pain management/addiction/opioid prescribing (DEA registrants); 2 hrs organ and tissue donation one time within 5 years of licensure or renewal (eff. May 1, 2026)", rollover: "No", moc: "ABMS cert documentation accepted for Cat 1", source: "Pa. Code tit. 49, \u00a7 16.19", verified: "2026-08", sourceUrl: "https://www.pacodeandbulletin.gov/Display/pacode?file=/secure/pacode/data/049/chapter16/s16.19.html", upcoming: [
    "Organ and tissue donation 2-hr one-time CE, effective 2026-05-01 (already in force); first deadline for existing licensees is within 5 years of their next renewal, i.e., MD renewal 12/31/2026 -> due by 2031",
  ] }, do: { total: 100, cycle: 2, cat1min: 20, cat1note: "20 hrs Cat 1-A", topics: [
    { topic: "Patient Safety", hours: 12.0, note: "12 hrs patient safety/risk management" },
    { topic: "Child Abuse Recognition", hours: 2.0, note: "2 hrs child abuse recognition and reporting" },
    { topic: "Pain Management", hours: 2.0, note: "2 hrs pain management, identification of addiction, or prescribing/dispensing opioids" },
    { topic: "Organ and Tissue Donation", hours: 2.0, note: "2 hrs organ and tissue donation and recovery process, one time within 5 years of initial licensure or of renewal, AOA Cat 1 or 2, counts toward the 100" },
  ], notes: "12 hrs patient safety/risk management; 2 hrs child abuse recognition and reporting; 2 hrs pain management/addiction/opioid prescribing; 2 hrs organ and tissue donation one time within 5 years of licensure or renewal (eff. May 1, 2026)", rollover: "No", moc: "No", source: "Pa. Code tit. 49, \u00a7 25.271", verified: "2026-08", sourceUrl: "https://www.pacodeandbulletin.gov/Display/pacode?file=/secure/pacode/data/049/chapter25/s25.271.html", upcoming: [
    "Organ and tissue donation 2-hr one-time CE, effective 2026-05-01 (already in force); first deadline for existing licensees is within 5 years of their next renewal",
  ] } },
  PR: { total: 60, cycle: 3, cat1min: 0, cat1note: "No Category 1 minimum stated. Specialists and subspecialists: 30 credits in the specialty, 22 free topics, 8 compulsory. Generalists: 52 free topics plus 8 compulsory.", topics: [
    { topic: "Pain Management", hours: 3.0, note: "3 hrs pain mgmt" },
    { topic: "Ethics", hours: 3.0, note: "3 hrs bioethics (must include discrimination against elderly, women, disabled, LGBTTQ+ community, diversity and inclusion; Resolution 2023-195)" },
    { topic: "Dengue", hours: 3.0, note: "3 hrs dengue per cycle (Resolution 2024-83 of 30 Aug 2024)" },
    { topic: "Hypertension", hours: 1.0, note: "1 hr hypertension per cycle" },
    { topic: "Diabetes", hours: 1.0, note: "1 hr diabetes per cycle" },
  ], notes: "60 credits per 3-year cycle. Compulsory 8 credits: hypertension 1, diabetes 1, bioethics 3, dengue 3. Specialists: 30 credits in specialty plus 22 free topics. Generalists: 52 free topics. Autism: pediatricians 6 credits, physicians working directly with autism in specialized centers 15 credits. Non-emergency-medicine physicians who provide direct or indirect services in a hospital ER or primary level: 20 hrs life-support courses (ACLS, PALS, NALS, ATLS, BLS) per triennium. Residents/fellows in ACGME programs: residency certification plus bioethics 3 and dengue 3 only. Physicians residing in the US with a valid state license: exempt from these courses. Older Dept. of Health topics (Zika, vaccination, obesity, pain, antibiotics) were removed by OA 542.", rollover: "No", moc: "No", source: "JLDM Requisitos de renovacion 2025-2028 (salud.pr.gov/CMS/DOWNLOAD/6481); JLDM Resolucion 2025-162 (31 Oct 2025); Ley 139-2008 Art. 36-37", verified: "2026-08", sourceUrl: "https://www.salud.pr.gov/CMS/DOWNLOAD/6481" },
  RI: { total: 40, cycle: 2, cat1min: 40, cat1note: "All AMA Cat 1 or AOA Cat 1A", topics: [
    { topic: "Geriatric Medicine", hours: 1.0, note: "1 hr Alzheimer's (one-time/career)" },
  ], notes: "1 hr Alzheimer's (one-time/career)", rollover: "No", moc: "ABMS MOC program = equivalent", source: "216-RICR-40-05-1.5.5", verified: "2026-08", sourceUrl: "https://rules.sos.ri.gov/regulations/part/216-40-05-1", upcoming: [
    "2026 H8545 (introduced May 13, 2026, on House calendar June 8, 2026) would amend RIGL 23-1.7-5 to require the 1-hour cognitive-impairment course each license renewal period instead of one-time, and extend it to PAs. Not enacted as of the codified statute loaded today; recheck after the 2026 session.",
  ] },
  SC: { total: 40, cycle: 2, cat1min: 40, cat1note: "All Cat 1; 30 hrs in practice area", topics: [
    { topic: "Controlled Substances", hours: 2.0, note: "2 hrs controlled substance prescribing/monitoring" },
  ], notes: "2 hrs controlled substance prescribing/monitoring", rollover: "No", moc: "ABMS/AOA cert or added qualifications accepted", source: "SC Code \u00a7 40-47-40", verified: "2026-08", sourceUrl: "https://llr.sc.gov/med/PDF/Medical_CE_Reqs.pdf" },
  SD: { total: 0, cycle: 0, cat1min: 0, cat1note: "", topics: [], notes: "No CME requirement", rollover: "No", moc: "", source: "No statutory CME requirement", verified: "2026-08", sourceUrl: "https://www.sdbmoe.gov/professions-physicians/professions-physicians-physician-license-md-do/" },
  TN: { md: { total: 40, cycle: 2, cat1min: 40, cat1note: "All Cat 1", topics: [
    { topic: "Opioid Prescribing", hours: 2.0, note: "2 hrs controlled substance prescribing (incl. opioid/benzo/barbiturate/carisoprodol guidelines)" },
    { topic: "Pain Management", hours: 0, note: "pain management CME for intractable pain providers" },
  ], notes: "2 hrs controlled substance prescribing (incl. opioid/benzo/barbiturate/carisoprodol guidelines); pain management CME for intractable pain providers", rollover: "No", moc: "No", source: "Tenn. Comp. R. & Regs. 0880-02-.19", verified: "2026-08", sourceUrl: "https://www.tn.gov/content/dam/tn/health/healthprofboards/medicalexaminers/MDcmefaqs.pdf" }, do: { total: 40, cycle: 2, cat1min: 40, cat1note: "AOA Cat 1-A, 2-A and/or 1-B; no more than 20 hrs in Cat 1-B", topics: [
    { topic: "Controlled Substances", hours: 2.0, note: "2 hrs prescribing practices" },
  ], notes: "2 hrs prescribing practices", rollover: "No", moc: "No", source: "Tenn. Comp. R. & Regs. 1050-02-.12", verified: "2026-08", sourceUrl: "https://publications.tnsosfiles.com/rules/1050/1050-02.20220721.pdf" } },
  TX: { total: 48, cycle: 2, cat1min: 24, cat1note: "24 hrs AMA Cat 1 or AOA Cat 1A", topics: [
    { topic: "Ethics", hours: 2.0, note: "2 hrs medical ethics/professional responsibility (Cat 1/1A), every renewal, all physicians" },
    { topic: "Human Trafficking", hours: 1.0, note: "HHSC-approved human trafficking prevention course, direct patient care physicians, before first renewal then every 3rd renewal (every 6 yrs); TMB page states at least 1 hr; may count toward ethics; not covered by board cert/MOC" },
    { topic: "Opioid Prescribing", hours: 2.0, note: "2 hrs opioid prescribing (first 2 renewals, then every 8 yrs)" },
    { topic: "Pain Management", hours: 10.0, note: "10 hrs pain mgmt/yr (pain clinic operators)" },
    { topic: "Life of the Mother Act", hours: 0, note: "One-time TMB Life of the Mother Act course (SB 31), physicians providing obstetric care (OB/GYN, MFM, family medicine, emergency medicine and related); counts only as ethics credit" },
  ], notes: "2 hrs medical ethics/professional responsibility (all physicians); human trafficking prevention course (direct patient care, before first renewal then every 6 yrs); 2 hrs opioid prescribing (first 2 renewals, then every 8 yrs); 10 hrs pain mgmt/yr (pain clinic operators); one-time Life of the Mother Act course (obstetric care); nutrition training", rollover: "Yes: up to 48 excess credits carry forward to the next registration period only; required ethics, opioid, and human trafficking hours cannot be carried forward", moc: "Board cert/recert within 36 months before renewal presumes compliance for one renewal; current ABMS MOC or AOA OCC also accepted; covers ethics, does not cover human trafficking; opioid depends on specialty board", source: "Tex. Admin. Code tit. 22, \u00a7 161.35", verified: "2026-08", sourceUrl: "https://www.tmb.texas.gov/apply-renew/physician/continuing-education-requirements-for-physicians", upcoming: [
    "Nutrition and metabolic health CME (Occ. Code 156.061, SB 25): all physicians, applies to renewals filed on or after 1/1/2027; hours and content to be set by TMB rule (due by 12/31/2026), hours currently unknown",
    "Forensic evidence collection: 2 hrs per renewal for physicians treating patients in an ER setting, licenses expiring on or after 2/28/2027; no approved courses yet (SASTF approval required)",
    "Mandatory CE tracking via CE Broker for all TMB licensees begins 9/1/2026",
  ] },
  UT: { total: 40, cycle: 2, cat1min: 34, cat1note: "34 hrs Cat 1; max 6 hrs DOPL", topics: [
    { topic: "Controlled Substances", hours: 3.5, note: "3.5 hrs controlled substance prescribing" },
    { topic: "Suicide Prevention", hours: 0, note: "1 online suicide prevention training" },
  ], notes: "3.5 hrs controlled substance prescribing; 1 online suicide prevention training", rollover: "No (up to 15% from volunteer services)", moc: "No", source: "Utah Admin. Code R156-67-304", verified: "2026-08", sourceUrl: "https://commerce.utah.gov/dopl/physician-and-surgeon/renew-a-license/", upcoming: [
    "H.B. 301 (2026 General Session, enrolled) renumbers Utah Code 58-37-6.5 to 58-37-303 effective 05/06/2026; controlled substance CE content and 3.5 hr requirement unchanged. Consider updating any citation text that names 58-37-6.5 once DOPL updates its page.",
  ] },
  VA: { total: 30, cycle: 2, cat1min: 30, cat1note: "All 30 hrs must be Type 1 (accredited sponsor, e.g. AMA PRA Cat 1); Type 2 no longer counts", topics: [], notes: "30 Type 1 hrs per biennium (reduced from 60 eff. 2025-02-27). Exempt at first renewal after initial VA licensure. Board may designate up to 2 Type 1 hrs on a specific subject per \u00a7 54.1-2928.3; none published for 2026 renewals as of 2026-08-17", rollover: "No", moc: "Yes, conditional: specialty board recertification or AMA PRA accepted if the Board has proof the requirements equal or exceed the renewal requirement", source: "18VAC85-20-235 (eff. 2025-02-27); Va. Code \u00a7 54.1-2912.1; \u00a7 54.1-2928.3", verified: "2026-08", sourceUrl: "https://law.lis.virginia.gov/admincode/title18/agency85/chapter20/section235/" },
  VI: { total: 50, cycle: 2, cat1min: 50, cat1note: "All AMA Cat 1", topics: [], notes: "Not specified", rollover: "No", moc: "No", source: "https://www.fsmb.org/siteassets/advocacy/key-issues/continuing-medical-education-by-state.pdf" },
  VT: { md: { total: 30, cycle: 2, cat1min: 30, cat1note: "Not specified", topics: [
    { topic: "Pain Management", hours: 1.0, note: "1 hr hospice/palliative care/pain management" },
    { topic: "Controlled Substances", hours: 2.0, note: "2 hrs safe prescribing of controlled substances (DEA holders)" },
  ], notes: "1 hr hospice/palliative care/pain management; 2 hrs safe prescribing of controlled substances (DEA holders)", rollover: "No", moc: "No", source: "Vermont Board of Medical Practice Rules, Section 24 (13-141-001 Code Vt. R., eff. April 1, 2024)", verified: "2026-08", sourceUrl: "https://healthvermont.gov/systems/medical-practice-board/statutes-rules-policies-and-newsletters" }, do: { total: 30, cycle: 2, cat1min: 0, cat1note: "Not specified", topics: [], notes: "Not specified", rollover: "No", moc: "No", source: "26 V.S.A \u00a7 1836", verified: "2026-08", sourceUrl: "https://healthvermont.gov/systems/medical-practice-board/statutes-rules-policies-and-newsletters" } },
  WA: { md: { total: 200, cycle: 4, cat1min: 200, cat1note: "All 200 may be Cat 1; max 80 each of Cat 2-5", topics: [
    { topic: "Suicide Prevention", hours: 6.0, note: "One-time 6 hrs suicide assessment/treatment" },
    { topic: "Opioid Prescribing", hours: 1.0, note: "one-time 1 hr opioid prescribing" },
    { topic: "Cultural Competency", hours: 2.0, note: "2 hrs health equity every 4 years (WAC 246-919-445, eff 1/1/2024)" },
  ], notes: "One-time 6 hrs suicide assessment/treatment; one-time 1 hr opioid prescribing; 2 hrs health equity every 4 yrs", rollover: "No", moc: "AMA PRA (2 of last 4 yrs), ABMS cert in last 4 yrs, or ABMS MOC participation accepted in lieu of 200 hrs", source: "WAC 246-919-430; 246-919-460; 246-919-435; 246-919-445; 246-919-875", verified: "2026-08", sourceUrl: "https://app.leg.wa.gov/wac/default.aspx?cite=246-919-430" }, do: { total: 150, cycle: 3, cat1min: 60, cat1note: "60 hrs Category 1A (AOA 1A per DOH page); remainder any approved category", topics: [
    { topic: "Suicide Prevention", hours: 6.0, note: "One-time 6 hrs suicide assessment/treatment" },
    { topic: "Opioid Prescribing", hours: 1.0, note: "one-time 1 hr opioid prescribing" },
    { topic: "Cultural Competency", hours: 2.0, note: "2 hrs health equity every 4 years (not per 3-yr cycle), WAC 246-853-075" },
  ], notes: "One-time 6 hrs suicide assessment/treatment; one-time 1 hr opioid prescribing; 2 hrs health equity every 4 yrs", rollover: "No", moc: "ABOMS or ABMS cert/recert within last 6 yrs, current AOA CME certificate, or AMA PRA satisfies 150 hrs; state mandates still required", source: "WAC 246-853-080; 246-853-065; 246-853-075; 246-853-685", verified: "2026-08", sourceUrl: "https://doh.wa.gov/licenses-permits-and-certificates/professions-new-renew-or-update/osteopathic-physician-and-surgeon/continuing-education" } },
  WI: { total: 30, cycle: 2, cat1min: 30, cat1note: "All Cat 1 (AMA or AOA)", topics: [
    { topic: "Opioid Prescribing", hours: 2.0, note: "2 hrs opioid/controlled substance prescribing (Board-approved not required)" },
  ], notes: "2 hrs opioid/controlled substance prescribing (Board-approved not required)", rollover: "No", moc: "No", source: "Wis. Admin. Code MED \u00a7 13.02", verified: "2026-08", sourceUrl: "https://dsps.wi.gov/Pages/Professions/Physician/CE.aspx" },
  WV: { md: { total: 50, cycle: 2, cat1min: 50, cat1note: "All Cat 1; 30 hrs in specialty", topics: [
    { topic: "Controlled Substances", hours: 3.0, note: "3 hrs Board-approved risk assessment/controlled substance prescribing training" },
  ], notes: "3 hrs Board-approved risk assessment/controlled substance prescribing training", rollover: "No", moc: "ABMS cert/recert or MOC; ACGME training year accepted", source: "W. Va. Code, \u00a7 30-3-12", verified: "2026-08", sourceUrl: "https://wvbom.wv.gov/Cont_Med_Education.asp" }, do: { total: 32, cycle: 2, cat1min: 16, cat1note: "16 hrs AOA Cat 1A or 1B", topics: [
    { topic: "Controlled Substances", hours: 3.0, note: "3 hrs Board-approved drug diversion/controlled substance prescribing" },
  ], notes: "3 hrs Board-approved drug diversion/controlled substance prescribing", rollover: "No", moc: "No", source: "W. Va. Code R. \u00a7 24-1-15", verified: "2026-08", sourceUrl: "https://wvbom.wv.gov/Cont_Med_Education.asp" } },
  WY: { total: 60, cycle: 3, cat1min: 60, cat1note: "All Cat 1 or 2 (AMA/AOA)", topics: [
    { topic: "Controlled Substances", hours: 1.0, note: "1 hr responsible prescribing of controlled substances or SUD treatment every 2 yrs (CSR holders)" },
  ], notes: "1 hr responsible prescribing of controlled substances or SUD treatment every 2 yrs (CSR holders)", rollover: "No", moc: "AMA PRA; ABMS cert accepted as equivalent", source: "WY Board of Medicine Rules Ch. 3, \u00a7 7", verified: "2026-08", sourceUrl: "https://www.law.cornell.edu/regulations/wyoming/052-3-Wyo-Code-R-SS-3-7" },
};

export const DEFAULT_STATE_REQ = {
  total: 50, cycle: 2, cat1min: 0, cat1note: "", topics: [], notes: "Check your state medical board for specifics.", rollover: "No", moc: "", source: "", sourceUrl: "", upcoming: [],
};

export function getStateReq(st, deg) {
  const entry = STATE_REQS[st];
  if (!entry) return DEFAULT_STATE_REQ;
  if (entry.md || entry.do) {
    const r = deg === "DO" ? (entry.do || entry.md) : (entry.md || entry.do);
    return { hours: r.total, cycle: r.cycle, cat1min: r.cat1min, cat1note: r.cat1note, topics: r.topics, notes: r.notes, rollover: r.rollover, moc: r.moc, source: r.source, verified: r.verified, sourceUrl: r.sourceUrl, upcoming: r.upcoming };
  }
  return { hours: entry.total, cycle: entry.cycle, cat1min: entry.cat1min, cat1note: entry.cat1note, topics: entry.topics, notes: entry.notes, rollover: entry.rollover, moc: entry.moc, source: entry.source, verified: entry.verified, sourceUrl: entry.sourceUrl, upcoming: entry.upcoming };
}

export function getStateEntry(st, deg) {
  const entry = STATE_REQS[st];
  if (!entry) return DEFAULT_STATE_REQ;
  if (entry.md || entry.do) return deg === "DO" ? (entry.do || entry.md) : (entry.md || entry.do);
  return entry;
}

export function hasSeparateBoards(st) {
  const e = STATE_REQS[st];
  return e && (e.md || e.do);
}
