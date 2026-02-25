// Comprehensive state CME requirements (from Feb 2026 CME Compliance Database)
// States with separate MD/DO boards have { md: {...}, do: {...} } structure.
// States with combined boards have a flat structure.
// States with NO CME requirement (IN, MT, SD) have total: 0.

export const STATE_REQS = {
  AK: { total: 50, cycle: 2, cat1min: 50, cat1note: "All AMA Cat 1 or AOA Cat 1/2", topics: [
    { topic: "Opioid Prescribing", hours: 2.0, note: "2 hrs pain management & opioid use/addiction (DEA holders)" },
  ], notes: "2 hrs pain management & opioid use/addiction (DEA holders)", rollover: "No (max 15 hrs exemption per 5 yrs)", moc: "ABMS/AOA initial cert or recert accepted", source: "Alaska Admin. Code tit. 12, \u00a7 40.200" },
  AL: { total: 25, cycle: 1, cat1min: 25, cat1note: "All AMA PRA Cat 1", topics: [
    { topic: "Controlled Substances", hours: 2.0, note: "2 hrs controlled substance prescribing every 2 yrs (ACSC holders)" },
    { topic: "Ethics", hours: 0, note: "professional boundaries course (one-time, by 12/31/2025)" },
  ], notes: "2 hrs controlled substance prescribing every 2 yrs (ACSC holders); professional boundaries course (one-time, by 12/31/2025)", rollover: "No", moc: "ABMS cert/MoC accepted as equivalent", source: "Ala. Admin. Code r. 540-x-14.02" },
  AR: { total: 20, cycle: 1, cat1min: 10, cat1note: "50% must be Cat 1 in primary practice area", topics: [
    { topic: "Opioid Prescribing", hours: 1.0, note: "1 hr/yr prescribing opioids/benzodiazepines" },
    { topic: "Controlled Substances", hours: 3.0, note: "one-time 3 hrs prescribing ed (first 2 yrs)" },
  ], notes: "1 hr/yr prescribing opioids/benzodiazepines; one-time 3 hrs prescribing ed (first 2 yrs)", rollover: "No", moc: "No", source: "AR Admin Rules 060.00.18-001" },
  AZ: { md: { total: 40, cycle: 2, cat1min: 0, cat1note: "Not specified", topics: [
    { topic: "Opioid Prescribing", hours: 3.0, note: "3 hrs opioid/SUD/addiction (DEA holders)" },
  ], notes: "3 hrs opioid/SUD/addiction (DEA holders)", rollover: "No", moc: "No", source: "Ariz. Admin. Code R4-16-102" }, do: { total: 40, cycle: 2, cat1min: 24, cat1note: "24 hrs AOA Cat 1-A; max 16 hrs AMA Cat 1", topics: [
    { topic: "Opioid Prescribing", hours: 3.0, note: "3 hrs opioid/SUD/addiction (DEA holders)" },
  ], notes: "3 hrs opioid/SUD/addiction (DEA holders)", rollover: "No", moc: "No", source: "Ariz. Admin. Code R4-22-207" } },
  CA: { md: { total: 50, cycle: 2, cat1min: 50, cat1note: "All Cat 1 approved", topics: [
    { topic: "Pain Management", hours: 12.0, note: "One-time 12 hrs pain management/terminally ill (by 2nd renewal)" },
    { topic: "Geriatric Medicine", hours: 0, note: "geriatrics if >25% patients 65+" },
  ], notes: "One-time 12 hrs pain management/terminally ill (by 2nd renewal); geriatrics if >25% patients 65+", rollover: "No", moc: "ABMS cert/recert = 4 yrs (100 hrs) credit", source: "Cal. Code Reg. tit. 16, \u00a7 1336" }, do: { total: 50, cycle: 2, cat1min: 20, cat1note: "20 hrs AOA Cat 1A or 1B", topics: [
    { topic: "Pain Management", hours: 12.0, note: "One-time 12 hrs pain management/terminally ill" },
    { topic: "Substance Use Disorders", hours: 0, note: "Schedule II addiction risks course each cycle" },
  ], notes: "One-time 12 hrs pain management/terminally ill; Schedule II addiction risks course each cycle", rollover: "No", moc: "No", source: "OPSC Guidance" } },
  CO: { total: 30, cycle: 2, cat1min: 0, cat1note: "AMA Cat 1 or equivalent", topics: [
    { topic: "Opioid Prescribing", hours: 2.0, note: "2 hrs opioid prescribing/PDMP (unless no opioid prescribing)" },
  ], notes: "2 hrs opioid prescribing/PDMP (unless no opioid prescribing)", rollover: "No", moc: "National board cert with equivalent SUD training accepted", source: "HB 1153 (2024); SB 228 (2019)" },
  CT: { total: 50, cycle: 2, cat1min: 0, cat1note: "Not specified", topics: [
    { topic: "Infection Control", hours: 1.0, note: "1 hr each infectious disease, risk management (first renewal then every 6 yrs)" },
    { topic: "Suicide Prevention", hours: 0, note: "behavioral health/suicide prevention" },
  ], notes: "1 hr each infectious disease, risk management (first renewal then every 6 yrs); behavioral health/suicide prevention", rollover: "No (up to 10 hr waiver for Board service)", moc: "No", source: "Conn. Gen. Stat. \u00a7 20-10(b)" },
  DC: { total: 50, cycle: 2, cat1min: 50, cat1note: "All Cat 1; 10% (5 hrs) in public health priorities", topics: [
    { topic: "Cultural Competency", hours: 2.0, note: "2 hrs LGBTQ cultural competency" },
    { topic: "Pharmacology", hours: 0, note: "1 pharmacology course" },
  ], notes: "2 hrs LGBTQ cultural competency; 1 pharmacology course", rollover: "No", moc: "No", source: "D.C. Mun. Regs. tit.17, \u00a7 4607.4" },
  DE: { total: 40, cycle: 2, cat1min: 40, cat1note: "All AMA or AOA Cat 1", topics: [
    { topic: "Controlled Substances", hours: 2.0, note: "2 hrs controlled substance prescribing/chronic pain biennially" },
  ], notes: "2 hrs controlled substance prescribing/chronic pain biennially", rollover: "No", moc: "No", source: "24 Del. Admin. Code 1700-12.0" },
  FL: { md: { total: 40, cycle: 2, cat1min: 0, cat1note: "Cat 1 for required topics", topics: [
    { topic: "HIV/AIDS", hours: 1.0, note: "1 hr HIV/AIDS" },
    { topic: "Medical Errors Prevention", hours: 2.0, note: "2 hrs medical errors" },
    { topic: "Domestic Violence", hours: 2.0, note: "2 hrs domestic violence (every 3rd renewal)" },
    { topic: "Controlled Substances", hours: 2.0, note: "2 hrs controlled substances (DEA)" },
  ], notes: "1 hr HIV/AIDS; 2 hrs medical errors; 2 hrs domestic violence (every 3rd renewal); 2 hrs controlled substances (DEA)", rollover: "No", moc: "No", source: "Fla. Admin. Code. Ann. r. 64B8-13.005" }, do: { total: 40, cycle: 2, cat1min: 20, cat1note: "20 hrs AOA Cat 1-A", topics: [
    { topic: "HIV/AIDS", hours: 1.0, note: "1 hr HIV/AIDS" },
    { topic: "Medical Errors Prevention", hours: 2.0, note: "2 hrs medical errors" },
    { topic: "Controlled Substances", hours: 1.0, note: "1 hr each risk mgmt, FL laws, controlled substances" },
    { topic: "Domestic Violence", hours: 0, note: "domestic violence (every 3rd renewal)" },
  ], notes: "1 hr HIV/AIDS; 2 hrs medical errors; 1 hr each risk mgmt, FL laws, controlled substances; domestic violence (every 3rd renewal)", rollover: "No", moc: "No", source: "Fla. Admin. Code. Ann. r. 64B15-13.001" } },
  GA: { total: 40, cycle: 2, cat1min: 0, cat1note: "AMA Cat 1, AOA Cat 1, AAFP, ACOG, or ACEP Cat 1", topics: [
    { topic: "Opioid Prescribing", hours: 3.0, note: "3 hrs responsible opioid prescribing (DEA holders)" },
    { topic: "Sexual Harassment Prevention", hours: 2.0, note: "one-time 2 hr sexual misconduct course" },
  ], notes: "3 hrs responsible opioid prescribing (DEA holders); one-time 2 hr sexual misconduct course; 20 hrs pain mgmt if >50% opioid patients", rollover: "No (up to 8 hrs waived for volunteer/peer review)", moc: "ABMS/AOA cert or recert accepted", source: "Ga. Comp. R. & Regs. 360-15-.01" },
  GU: { total: 100, cycle: 2, cat1min: 25, cat1note: "25% must be Cat 1", topics: [], notes: "Not specified", rollover: "No", moc: "", source: "25 GAR Prof. & Voc. Regs \u00a7 11101(g)(9)" },
  HI: { total: 40, cycle: 2, cat1min: 40, cat1note: "All Cat 1 or 1A", topics: [], notes: "Not specified", rollover: "No", moc: "No", source: "Haw. Admin. R. \u00a716-85-33" },
  IA: { total: 40, cycle: 2, cat1min: 0, cat1note: "Not specified", topics: [
    { topic: "Child Abuse Recognition", hours: 2.0, note: "2 hrs child abuse (pediatric providers)" },
    { topic: "Opioid Prescribing", hours: 2.0, note: "2 hrs opioid prescribing every 5 yrs (if prescribed)" },
    { topic: "End-of-Life Care", hours: 0, note: "end-of-life care every 5 yrs" },
  ], notes: "2 hrs child abuse (pediatric providers); 2 hrs adult abuse (adult providers) every 3 yrs; 2 hrs opioid prescribing every 5 yrs (if prescribed); end-of-life care every 5 yrs", rollover: "Yes (up to 20 hrs)", moc: "ABMS/AOA cert or recert = 50 hrs Cat 1", source: "Iowa Admin. Code r. 653-11.2(2)" },
  ID: { total: 40, cycle: 2, cat1min: 40, cat1note: "All Cat 1", topics: [], notes: "Not specified", rollover: "No", moc: "ABMS/AOA/RCPSC cert or recert accepted", source: "Idaho Admin. Code r. 22.01.01-079" },
  IL: { total: 150, cycle: 3, cat1min: 60, cat1note: "60 hrs Cat 1", topics: [
    { topic: "Sexual Harassment Prevention", hours: 1.0, note: "1 hr sexual harassment prevention" },
    { topic: "Implicit Bias", hours: 1.0, note: "1 hr implicit bias (each cycle)" },
    { topic: "Opioid Prescribing", hours: 1.0, note: "1 hr each opioids, cultural competency, dementia (every 6 yrs)" },
    { topic: "Geriatric Medicine", hours: 1.0, note: "1 hr Alzheimer's" },
  ], notes: "1 hr sexual harassment prevention; 1 hr implicit bias (each cycle); 1 hr each opioids, cultural competency, dementia (every 6 yrs); 1 hr Alzheimer's", rollover: "No", moc: "Board cert/licensure CME from other states accepted", source: "Ill. Admin. Code tit.68, \u00a7 1285.110" },
  IN: { total: 0, cycle: 0, cat1min: 0, cat1note: "", topics: [], notes: "No CME requirement", rollover: "No", moc: "", source: "No statutory CME requirement" },
  KS: { total: 50, cycle: 1, cat1min: 20, cat1note: "20 Cat 1 per year (or 40/100 per 2/3-yr cycle)", topics: [
    { topic: "Opioid Prescribing", hours: 3.0, note: "1-3 hrs (per cycle length) pain mgmt/opioid prescribing/PDMP" },
  ], notes: "1-3 hrs (per cycle length) pain mgmt/opioid prescribing/PDMP", rollover: "No", moc: "No", source: "Kan. Admin. Regs. \u00a7 100-15-5" },
  KY: { total: 60, cycle: 3, cat1min: 30, cat1note: "30 hrs Cat 1", topics: [
    { topic: "Controlled Substances", hours: 4.5, note: "4.5 hrs KASPER/pain mgmt/addiction (controlled substance prescribers)" },
    { topic: "Domestic Violence", hours: 0, note: "one-time domestic violence (primary care)" },
  ], notes: "4.5 hrs KASPER/pain mgmt/addiction (controlled substance prescribers); one-time domestic violence (primary care)", rollover: "No", moc: "No", source: "201 KAR 9:310" },
  LA: { total: 20, cycle: 1, cat1min: 20, cat1note: "All Cat 1", topics: [
    { topic: "Controlled Substances", hours: 3.0, note: "One-time 3 hr drug diversion/controlled substance prescribing" },
    { topic: "General / No Specific Topic", hours: 1.0, note: "1 hr nutrition/metabolic health every 2 yrs (primary care, eff. 2025)" },
  ], notes: "One-time 3 hr drug diversion/controlled substance prescribing; one-time board orientation; 1 hr nutrition/metabolic health every 2 yrs (primary care, eff. 2025)", rollover: "No", moc: "No", source: "La. Admin. Code tit. 46, pt. XLV" },
  MA: { total: 50, cycle: 2, cat1min: 0, cat1note: "Cat 1 or 2 (ACCME/AOA/AAFP accredited)", topics: [
    { topic: "Opioid Prescribing", hours: 3.0, note: "3 hrs opioid education (if prescribing)" },
    { topic: "Risk Management", hours: 10.0, note: "10 hrs risk mgmt" },
    { topic: "End-of-Life Care", hours: 2.0, note: "2 hrs end-of-life (one-time)" },
    { topic: "Implicit Bias", hours: 2.0, note: "2 hrs implicit bias" },
    { topic: "Child Abuse Recognition", hours: 0, note: "child abuse" },
    { topic: "Domestic Violence", hours: 0, note: "domestic violence" },
    { topic: "Geriatric Medicine", hours: 0, note: "Alzheimer's (one-time, adult populations)" },
  ], notes: "3 hrs opioid education (if prescribing); 10 hrs risk mgmt; 2 hrs end-of-life (one-time); 2 hrs implicit bias; child abuse; domestic violence; Alzheimer's (one-time, adult populations)", rollover: "No", moc: "No", source: "BORIM Guidance; Policy 2017-05" },
  MD: { total: 50, cycle: 2, cat1min: 25, cat1note: "25 hrs Cat 1", topics: [
    { topic: "Controlled Substances", hours: 2.0, note: "2 hrs controlled substance prescribing (CDS registration)" },
    { topic: "Implicit Bias", hours: 0, note: "one-time implicit bias training" },
  ], notes: "2 hrs controlled substance prescribing (CDS registration); one-time implicit bias training", rollover: "No", moc: "Active time-limited ABMS/AOA cert accepted (within 5 yrs)", source: "COMAR 10.32.01.10" },
  ME: { md: { total: 40, cycle: 2, cat1min: 40, cat1note: "All Cat 1", topics: [
    { topic: "Opioid Prescribing", hours: 3.0, note: "3 hrs opioid prescribing every 2 yrs" },
  ], notes: "3 hrs opioid prescribing every 2 yrs", rollover: "No", moc: "25 hrs for ABMS cert/recert within 24 months", source: "ME BLM CME Information" }, do: { total: 100, cycle: 2, cat1min: 0, cat1note: "40 hrs osteopathic medical ed; primary care: all AOA Cat 1", topics: [
    { topic: "Opioid Prescribing", hours: 3.0, note: "3 hrs opioid prescribing every 2 yrs" },
  ], notes: "3 hrs opioid prescribing every 2 yrs", rollover: "No", moc: "No", source: "02 ME Code Rules \u00a7 383-14-1" } },
  MI: { md: { total: 150, cycle: 3, cat1min: 75, cat1note: "75 hrs Cat 1", topics: [
    { topic: "Ethics", hours: 1.0, note: "1 hr medical ethics" },
    { topic: "Pain Management", hours: 3.0, note: "3 hrs pain/symptom management" },
    { topic: "Implicit Bias", hours: 1.0, note: "1 hr/yr implicit bias (eff. 2022)" },
    { topic: "Human Trafficking", hours: 0, note: "one-time human trafficking" },
  ], notes: "1 hr medical ethics; 3 hrs pain/symptom management; 1 hr/yr implicit bias (eff. 2022); one-time human trafficking", rollover: "No", moc: "30 hrs for ABMS MOC activities", source: "LARA MD Licensing Guide" }, do: { total: 150, cycle: 3, cat1min: 60, cat1note: "60 hrs Cat 1", topics: [
    { topic: "Ethics", hours: 1.0, note: "1 hr medical ethics" },
    { topic: "Controlled Substances", hours: 3.0, note: "3 hrs pain/symptom management (1 hr controlled substances)" },
    { topic: "Implicit Bias", hours: 1.0, note: "1 hr/yr implicit bias" },
    { topic: "Human Trafficking", hours: 0, note: "one-time human trafficking" },
  ], notes: "1 hr medical ethics; 3 hrs pain/symptom management (1 hr controlled substances); 1 hr/yr implicit bias; one-time human trafficking", rollover: "No", moc: "No", source: "LARA DO Licensing Guide" } },
  MN: { total: 75, cycle: 3, cat1min: 75, cat1note: "All Cat 1", topics: [], notes: "Not specified", rollover: "No", moc: "ABMS/AOA/RCPSC cert or recert accepted", source: "Minnesota Rules, part 5605.0100" },
  MO: { total: 50, cycle: 2, cat1min: 50, cat1note: "All AMA Cat 1 or AOA Cat 1A/2A (or 40 hrs Cat 1 with post-testing)", topics: [], notes: "Not specified", rollover: "No", moc: "ABMS cert/recert during reporting period accepted", source: "20 CSR 2150-2.125" },
  MP: { total: 50, cycle: 2, cat1min: 50, cat1note: "All Cat 1", topics: [], notes: "Not specified", rollover: "No", moc: "No", source: "Title 185-10-4215" },
  MS: { total: 40, cycle: 2, cat1min: 40, cat1note: "All Cat 1", topics: [
    { topic: "Controlled Substances", hours: 5.0, note: "5 hrs prescribing medications/controlled substances (DEA holders)" },
  ], notes: "5 hrs prescribing medications/controlled substances (DEA holders)", rollover: "No", moc: "No", source: "MS Rules Part 2610 Ch. 2" },
  MT: { total: 0, cycle: 0, cat1min: 0, cat1note: "", topics: [], notes: "No CME requirement", rollover: "No", moc: "", source: "No statutory CME requirement" },
  NC: { total: 60, cycle: 3, cat1min: 60, cat1note: "All Cat 1 (in specialty/practice area)", topics: [
    { topic: "Controlled Substances", hours: 3.0, note: "3 hrs controlled substance prescribing" },
  ], notes: "3 hrs controlled substance prescribing", rollover: "No", moc: "ABMS/AOA/RCPSC recert/MOC = entire requirement", source: "N.C. Admin. Code tit. 21, r. 32R.0101" },
  ND: { total: 40, cycle: 2, cat1min: 40, cat1note: "All Cat 1", topics: [], notes: "Not specified", rollover: "No", moc: "ABMS/AOA/RCPSC cert/MOC exempt from CME", source: "N.D. Admin. Code 50-04-01-02" },
  NE: { total: 50, cycle: 2, cat1min: 50, cat1note: "All Cat 1", topics: [
    { topic: "Opioid Prescribing", hours: 3.0, note: "3 hrs opioid prescribing (incl. 0.5 hr PDMP) biennially (controlled substance prescribers)" },
  ], notes: "3 hrs opioid prescribing (incl. 0.5 hr PDMP) biennially (controlled substance prescribers)", rollover: "Yes (up to 25 hrs)", moc: "AMA PRA or AOA CME Certification accepted", source: "Neb. Admin. R. & Regs. Tit. 172, Ch. 88" },
  NH: { total: 100, cycle: 2, cat1min: 40, cat1note: "40 hrs Cat 1; max 60 hrs Cat 2", topics: [
    { topic: "Pain Management", hours: 3.0, note: "3 hrs pain management/addiction disorders (NH-DEA holders)" },
  ], notes: "3 hrs pain management/addiction disorders (NH-DEA holders)", rollover: "No", moc: "ABMS board exam = 100 hrs Cat 1", source: "N.H. Rev. Stat. \u00a7 329:16-g" },
  NJ: { total: 100, cycle: 2, cat1min: 40, cat1note: "40 hrs Cat 1; 60 hrs Cat 1 or 2; 6 hrs cultural competence", topics: [
    { topic: "End-of-Life Care", hours: 2.0, note: "2 hrs end-of-life care" },
    { topic: "Opioid Prescribing", hours: 1.0, note: "1 hr opioid prescribing" },
    { topic: "Sexual Harassment Prevention", hours: 2.0, note: "2 hrs sexual misconduct prevention (eff. 2025)" },
    { topic: "Implicit Bias", hours: 1.0, note: "1 hr implicit bias (perinatal providers)" },
  ], notes: "2 hrs end-of-life care; 1 hr opioid prescribing; 2 hrs sexual misconduct prevention (eff. 2025); 1 hr implicit bias (perinatal providers)", rollover: "No", moc: "No", source: "N.J. Admin. Code 13:35-6.25" },
  NM: { total: 75, cycle: 3, cat1min: 75, cat1note: "All Cat 1", topics: [
    { topic: "Pain Management", hours: 5.0, note: "5 hrs pain management (DEA/NM CSR holders, first year)" },
  ], notes: "5 hrs pain management (DEA/NM CSR holders, first year); 1 hr NM Medical Practice Act review", rollover: "No", moc: "AMA PRA, ABMS cert/recert accepted", source: "N.M. Admin. Code \u00a7 16.10.14.11" },
  NV: { md: { total: 40, cycle: 2, cat1min: 40, cat1note: "All Cat 1", topics: [
    { topic: "Pain Management", hours: 2.0, note: "2 hrs ethics/pain mgmt/addiction" },
    { topic: "Controlled Substances", hours: 2.0, note: "2 hrs controlled substance prescribing" },
    { topic: "Suicide Prevention", hours: 2.0, note: "2 hrs suicide prevention (every 4 yrs)" },
  ], notes: "20 hrs in specialty; 2 hrs ethics/pain mgmt/addiction; 2 hrs controlled substance prescribing; 2 hrs suicide prevention (every 4 yrs); SBIRT (one-time); 4 hrs WMD/bioterrorism (new licensees)", rollover: "No", moc: "No", source: "NRS \u00a7 630.253" }, do: { total: 35, cycle: 1, cat1min: 10, cat1note: "10 AOA or AMA Cat 1A", topics: [
    { topic: "Controlled Substances", hours: 2.0, note: "2 hrs controlled substance prescribing" },
    { topic: "Suicide Prevention", hours: 2.0, note: "2 hrs suicide prevention (every 4 yrs)" },
    { topic: "Pain Management", hours: 2.0, note: "2 hrs ethics/pain mgmt/addiction" },
    { topic: "Cultural Competency", hours: 0, note: "cultural competency (psychiatrists)" },
  ], notes: "2 hrs controlled substance prescribing; 2 hrs suicide prevention (every 4 yrs); 2 hrs ethics/pain mgmt/addiction; cultural competency (psychiatrists)", rollover: "No", moc: "No", source: "Nev. Rev. Stat. 633.471" } },
  NY: { total: 0, cycle: 0, cat1min: 0, cat1note: "None (general)", topics: [
    { topic: "Pain Management", hours: 3.0, note: "3 hrs pain mgmt/palliative care/addiction (DEA holders)" },
    { topic: "Child Abuse Recognition", hours: 2.0, note: "2 hrs child abuse/maltreatment" },
    { topic: "Infection Control", hours: 0, note: "infection control every 4 yrs" },
  ], notes: "No CME requirement", rollover: "No", moc: "", source: "N.Y. Comp. Codes tit. 8, \u00a7\u00a7 59.12-13" },
  OH: { total: 50, cycle: 2, cat1min: 50, cat1note: "All Cat 1", topics: [
    { topic: "Ethics", hours: 1.0, note: "1 hr duty to report" },
    { topic: "Pain Management", hours: 20.0, note: "20 hrs pain medicine (pain clinic operators, incl. addiction)" },
  ], notes: "1 hr duty to report; 20 hrs pain medicine (pain clinic operators, incl. addiction)", rollover: "No", moc: "No", source: "Ohio Admin. Code \u00a7\u00a7 4731-10-02" },
  OK: { md: { total: 60, cycle: 3, cat1min: 60, cat1note: "All Cat 1", topics: [
    { topic: "Opioid Prescribing", hours: 1.0, note: "1 hr/yr pain management or opioid use/addiction (DEA holders)" },
  ], notes: "1 hr/yr pain management or opioid use/addiction (DEA holders); 1-hr training on provider rights/responsibilities every 2 yrs", rollover: "No", moc: "AMA PRA or ABMS cert/recert accepted", source: "59 O.S. \u00a7 495a.1" }, do: { total: 16, cycle: 1, cat1min: 16, cat1note: "All AOA Cat 1A or 1B", topics: [
    { topic: "Controlled Substances", hours: 1.0, note: "1 hr/yr controlled substance prescribing/dispensing/administering (DEA holders)" },
  ], notes: "1 hr/yr controlled substance prescribing/dispensing/administering (DEA holders)", rollover: "No", moc: "No", source: "OK Admin Code 510:10-3-8" } },
  OR: { total: 60, cycle: 2, cat1min: 60, cat1note: "All AMA Cat 1 or AOA Cat 1A/2A", topics: [
    { topic: "Pain Management", hours: 6.0, note: "6 hrs pain management/end-of-life care" },
  ], notes: "1-hr pain management course (Pain Mgmt Commission); 6 hrs pain management/end-of-life care", rollover: "No", moc: "ABMS/AOA-BOS recert/MOC accepted as alternative", source: "OAR 847-008-0075" },
  PA: { md: { total: 100, cycle: 2, cat1min: 20, cat1note: "20 hrs Cat 1", topics: [
    { topic: "Patient Safety", hours: 12.0, note: "12 hrs patient safety/risk management" },
    { topic: "Child Abuse Recognition", hours: 2.0, note: "2 hrs child abuse reporting" },
    { topic: "Pain Management", hours: 2.0, note: "2 hrs pain mgmt/addiction" },
    { topic: "Opioid Prescribing", hours: 2.0, note: "2 hrs opioid prescribing (initial then ongoing)" },
  ], notes: "12 hrs patient safety/risk management; 2 hrs child abuse reporting; 2 hrs pain mgmt/addiction; 2 hrs opioid prescribing (initial then ongoing)", rollover: "No", moc: "ABMS cert documentation accepted for Cat 1", source: "Pa. Code tit. 49, \u00a7 16.19" }, do: { total: 100, cycle: 2, cat1min: 20, cat1note: "20 hrs Cat 1-A", topics: [
    { topic: "Patient Safety", hours: 12.0, note: "12 hrs patient safety/risk management" },
    { topic: "Child Abuse Recognition", hours: 2.0, note: "2 hrs child abuse reporting" },
    { topic: "Pain Management", hours: 2.0, note: "2 hrs pain mgmt/addiction" },
    { topic: "Opioid Prescribing", hours: 2.0, note: "2 hrs opioid prescribing" },
  ], notes: "12 hrs patient safety/risk management; 2 hrs child abuse reporting; 2 hrs pain mgmt/addiction; 2 hrs opioid prescribing", rollover: "No", moc: "No", source: "Pa. Code tit. 49, \u00a7 25.271" } },
  PR: { total: 60, cycle: 3, cat1min: 30, cat1note: "Not specified; 50% in specialty", topics: [
    { topic: "Pain Management", hours: 3.0, note: "3 hrs pain mgmt" },
    { topic: "Ethics", hours: 4.0, note: "4 hrs bioethics" },
  ], notes: "2 hrs Dengue/Chikungunya/Zika; 1 hr diabetes; 1 hr vaccination; 1 hr obesity; 1 hr cardiovascular; 3 hrs pain mgmt; 3 hrs antibiotics; 4 hrs bioethics; autism (pediatricians/autism providers); 20 hrs", rollover: "No", moc: "No", source: "Reglamento General JLDM PR 9.1" },
  RI: { total: 40, cycle: 2, cat1min: 40, cat1note: "All AMA Cat 1 or AOA Cat 1A", topics: [
    { topic: "Geriatric Medicine", hours: 1.0, note: "1 hr Alzheimer's (one-time/career)" },
  ], notes: "1 hr Alzheimer's (one-time/career)", rollover: "No", moc: "ABMS MOC program = equivalent", source: "216-RICR-40-05-1.5.5" },
  SC: { total: 40, cycle: 2, cat1min: 40, cat1note: "All Cat 1; 30 hrs in practice area", topics: [
    { topic: "Controlled Substances", hours: 2.0, note: "2 hrs controlled substance prescribing/monitoring" },
  ], notes: "2 hrs controlled substance prescribing/monitoring", rollover: "No", moc: "ABMS/AOA cert or added qualifications accepted", source: "SC Code \u00a7 40-47-40" },
  SD: { total: 0, cycle: 0, cat1min: 0, cat1note: "", topics: [], notes: "No CME requirement", rollover: "No", moc: "", source: "No statutory CME requirement" },
  TN: { md: { total: 40, cycle: 2, cat1min: 40, cat1note: "All Cat 1", topics: [
    { topic: "Opioid Prescribing", hours: 2.0, note: "2 hrs controlled substance prescribing (incl. opioid/benzo/barbiturate/carisoprodol guidelines)" },
    { topic: "Pain Management", hours: 0, note: "pain management CME for intractable pain providers" },
  ], notes: "2 hrs controlled substance prescribing (incl. opioid/benzo/barbiturate/carisoprodol guidelines); pain management CME for intractable pain providers", rollover: "No", moc: "No", source: "Tenn. Comp. R. & Regs. 0880-02-.19" }, do: { total: 40, cycle: 2, cat1min: 40, cat1note: "All AOA Cat 1A or 2A", topics: [
    { topic: "Controlled Substances", hours: 2.0, note: "2 hrs prescribing practices" },
  ], notes: "2 hrs prescribing practices", rollover: "No", moc: "No", source: "Tenn. Comp. R. & Regs. 1050-02-.12" } },
  TX: { total: 48, cycle: 2, cat1min: 24, cat1note: "24 hrs AMA Cat 1 or AOA Cat 1A", topics: [
    { topic: "Ethics", hours: 2.0, note: "2 hrs medical ethics/professional responsibility (incl. human trafficking)" },
    { topic: "Opioid Prescribing", hours: 2.0, note: "2 hrs opioid prescribing (first 2 renewals, then every 8 yrs)" },
    { topic: "Pain Management", hours: 10.0, note: "10 hrs pain mgmt/yr (pain clinic operators)" },
    { topic: "General / No Specific Topic", hours: 0, note: "nutrition training (eff. 9/1/2025)" },
  ], notes: "2 hrs medical ethics/professional responsibility (incl. human trafficking); 2 hrs opioid prescribing (first 2 renewals, then every 8 yrs); 10 hrs pain mgmt/yr (pain clinic operators); nutrition training", rollover: "No", moc: "ABMS cert/recert (within 36 months) exempts CME", source: "Tex. Admin. Code tit. 22, \u00a7 161.35" },
  UT: { total: 40, cycle: 2, cat1min: 34, cat1note: "34 hrs Cat 1; max 6 hrs DOPL", topics: [
    { topic: "Controlled Substances", hours: 3.5, note: "3.5 hrs controlled substance prescribing" },
    { topic: "Suicide Prevention", hours: 0, note: "1 online suicide prevention training" },
  ], notes: "3.5 hrs controlled substance prescribing; 1 online suicide prevention training", rollover: "No (up to 15% from volunteer services)", moc: "No", source: "Utah Admin. Code R156-67-304" },
  VA: { total: 60, cycle: 2, cat1min: 30, cat1note: "30 hrs Cat 1", topics: [
    { topic: "Controlled Substances", hours: 2.0, note: "2 hrs addiction/pain management/controlled substance prescribing" },
    { topic: "Human Trafficking", hours: 1.0, note: "1 hr human trafficking (2024-2025 renewals)" },
  ], notes: "2 hrs addiction/pain management/controlled substance prescribing; 1 hr human trafficking (2024-2025 renewals)", rollover: "No (up to 15 Cat 2 hrs from volunteer services)", moc: "No", source: "18 Va. Admin. Code 85-20-235" },
  VI: { total: 50, cycle: 2, cat1min: 50, cat1note: "All AMA Cat 1", topics: [], notes: "Not specified", rollover: "No", moc: "No", source: "" },
  VT: { md: { total: 30, cycle: 2, cat1min: 0, cat1note: "Not specified", topics: [
    { topic: "Pain Management", hours: 1.0, note: "1 hr hospice/palliative care/pain management" },
    { topic: "Controlled Substances", hours: 2.0, note: "2 hrs safe prescribing of controlled substances (DEA holders)" },
  ], notes: "1 hr hospice/palliative care/pain management; 2 hrs safe prescribing of controlled substances (DEA holders)", rollover: "No", moc: "No", source: "12-5 Vt. Code R. \u00a7 200:22.1" }, do: { total: 30, cycle: 2, cat1min: 0, cat1note: "Not specified", topics: [], notes: "Not specified", rollover: "No", moc: "No", source: "26 V.S.A \u00a7 1836" } },
  WA: { md: { total: 200, cycle: 4, cat1min: 200, cat1note: "All 200 may be Cat 1; max 80 each of Cat 2-5", topics: [
    { topic: "Suicide Prevention", hours: 6.0, note: "One-time 6 hrs suicide assessment/treatment" },
    { topic: "Opioid Prescribing", hours: 1.0, note: "one-time 1 hr opioid prescribing" },
    { topic: "Cultural Competency", hours: 2.0, note: "2 hrs health equity per cycle" },
  ], notes: "One-time 6 hrs suicide assessment/treatment; one-time 1 hr opioid prescribing; 2 hrs health equity per cycle", rollover: "No", moc: "AMA PRA, ABMS cert or MOC accepted", source: "WAC 246-919-460" }, do: { total: 150, cycle: 3, cat1min: 60, cat1note: "60 hrs Cat 1", topics: [
    { topic: "Suicide Prevention", hours: 6.0, note: "One-time 6 hrs suicide assessment/treatment" },
    { topic: "Opioid Prescribing", hours: 1.0, note: "one-time 1 hr opioid prescribing" },
    { topic: "Cultural Competency", hours: 2.0, note: "2 hrs health equity per cycle" },
  ], notes: "One-time 6 hrs suicide assessment/treatment; one-time 1 hr opioid prescribing; 2 hrs health equity per cycle", rollover: "No", moc: "ABMS/ABOMS cert accepted", source: "WAC 246-853-080" } },
  WI: { total: 30, cycle: 2, cat1min: 30, cat1note: "All Cat 1 (AMA or AOA)", topics: [
    { topic: "Opioid Prescribing", hours: 2.0, note: "2 hrs opioid/controlled substance prescribing (Board-approved not required)" },
  ], notes: "2 hrs opioid/controlled substance prescribing (Board-approved not required)", rollover: "No", moc: "No", source: "Wis. Admin. Code MED \u00a7 13.02" },
  WV: { md: { total: 50, cycle: 2, cat1min: 50, cat1note: "All Cat 1; 30 hrs in specialty", topics: [
    { topic: "Controlled Substances", hours: 3.0, note: "3 hrs Board-approved risk assessment/controlled substance prescribing training" },
  ], notes: "3 hrs Board-approved risk assessment/controlled substance prescribing training", rollover: "No", moc: "ABMS cert/recert or MOC; ACGME training year accepted", source: "W. Va. Code, \u00a7 30-3-12" }, do: { total: 32, cycle: 2, cat1min: 16, cat1note: "16 hrs AOA Cat 1A or 1B", topics: [
    { topic: "Controlled Substances", hours: 3.0, note: "3 hrs Board-approved drug diversion/controlled substance prescribing" },
  ], notes: "3 hrs Board-approved drug diversion/controlled substance prescribing", rollover: "No", moc: "No", source: "W. Va. Code R. \u00a7 24-1-15" } },
  WY: { total: 60, cycle: 3, cat1min: 60, cat1note: "All Cat 1 or 2 (AMA/AOA)", topics: [
    { topic: "Controlled Substances", hours: 1.0, note: "1 hr responsible prescribing of controlled substances or SUD treatment every 2 yrs (CSR holders)" },
  ], notes: "1 hr responsible prescribing of controlled substances or SUD treatment every 2 yrs (CSR holders)", rollover: "No", moc: "AMA PRA; ABMS cert accepted as equivalent", source: "WY Board of Medicine Rules Ch. 3, \u00a7 7" },
};

export const DEFAULT_STATE_REQ = {
  total: 50, cycle: 2, cat1min: 0, cat1note: "", topics: [], notes: "Check your state medical board for specifics.", rollover: "No", moc: "", source: "",
};

export function getStateReq(st, deg) {
  const entry = STATE_REQS[st];
  if (!entry) return DEFAULT_STATE_REQ;
  if (entry.md || entry.do) {
    const r = deg === "DO" ? (entry.do || entry.md) : (entry.md || entry.do);
    return { hours: r.total, cycle: r.cycle, cat1min: r.cat1min, cat1note: r.cat1note, topics: r.topics, notes: r.notes, rollover: r.rollover, moc: r.moc, source: r.source };
  }
  return { hours: entry.total, cycle: entry.cycle, cat1min: entry.cat1min, cat1note: entry.cat1note, topics: entry.topics, notes: entry.notes, rollover: entry.rollover, moc: entry.moc, source: entry.source };
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
