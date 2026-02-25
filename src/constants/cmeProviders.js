// Curated CME Provider Database
// Maps CME providers/resources to topics defined in cmeTopics.js
// Last researched: February 2026
//
// Accreditation key:
//   "AMA PRA Category 1"   = AMA PRA Category 1 Credit (ACCME-accredited)
//   "AOA Category 1-A"     = AOA Category 1-A Credit (AOA-accredited)
//   "AAFP Prescribed"      = AAFP Prescribed Credit
//   "ABIM MOC"             = ABIM Maintenance of Certification points
//   "Joint Accreditation"  = ACCME + ACPE + ANCC (interprofessional)
//
// Pricing key:
//   "free"                 = No cost (may require free registration)
//   "freemium"             = Free courses available + paid premium options
//   "subscription"         = Requires paid subscription
//   "paid"                 = Per-course or bundle pricing
//   "membership"           = Included with organizational membership

export const CME_PROVIDERS = [
  // ─── MAJOR FREE / FREEMIUM PLATFORMS ────────────────────────────────
  {
    id: "medscape",
    name: "Medscape Education",
    url: "https://www.medscape.org/",
    pricing: "free",
    pricingNote: "Free with registration",
    accreditation: ["AMA PRA Category 1", "ABIM MOC"],
    accreditedBy: "ACCME",
    topics: [
      "Pain Management", "Opioid Prescribing", "Controlled Substances", "Ethics",
      "Infection Control", "Patient Safety", "Suicide Prevention", "Cultural Competency",
      "Implicit Bias", "End-of-Life Care", "Geriatric Medicine", "HIV/AIDS",
      "Palliative Care", "Mental Health", "Substance Use Disorders", "Pharmacology",
      "Telemedicine", "General / No Specific Topic",
    ],
    description: "Largest free online CME platform with 850+ activities across all specialties. Covers virtually every mandatory state topic.",
    stateSpecific: true,
    stateSpecificNote: "State CME requirements tracker at medscape.org/public/staterequirements",
    dualAccredited: false,
    format: ["Online articles", "Video", "Case studies", "Expert commentary"],
  },
  {
    id: "amaEdHub",
    name: "AMA Ed Hub",
    url: "https://edhub.ama-assn.org/",
    pricing: "freemium",
    pricingNote: "Many free courses; AMA membership unlocks full library",
    accreditation: ["AMA PRA Category 1", "ABIM MOC"],
    accreditedBy: "ACCME",
    topics: [
      "Pain Management", "Opioid Prescribing", "Controlled Substances", "Ethics",
      "Patient Safety", "Suicide Prevention", "Mental Health", "Substance Use Disorders",
      "Pharmacology", "Telemedicine", "General / No Specific Topic",
    ],
    description: "AMA official learning platform with 1,700+ credits from JAMA, AMA Journal of Ethics, STEPS Forward, and partner organizations.",
    stateSpecific: false,
    stateSpecificNote: null,
    dualAccredited: false,
    format: ["Online modules", "Video", "Podcasts", "Case-based learning"],
  },
  {
    id: "primed",
    name: "Pri-Med",
    url: "https://www.pri-med.com/",
    pricing: "free",
    pricingNote: "Free with registration; some premium content available",
    accreditation: ["AMA PRA Category 1", "AAFP Prescribed", "ABIM MOC"],
    accreditedBy: "ACCME",
    topics: [
      "Pain Management", "Opioid Prescribing", "Controlled Substances", "Ethics",
      "Infection Control", "End-of-Life Care", "HIV/AIDS", "Palliative Care",
      "Mental Health", "Substance Use Disorders", "Cultural Competency",
      "General / No Specific Topic",
    ],
    description: "Free CME across 50+ therapeutic areas. Strong selection for opioid prescribing, end-of-life care, and cultural competency courses.",
    stateSpecific: true,
    stateSpecificNote: "State-by-state requirement guides with linked courses",
    dualAccredited: false,
    format: ["Online modules", "Video lectures", "Case studies"],
  },
  {
    id: "mycme",
    name: "myCME",
    url: "https://www.mycme.com/",
    pricing: "free",
    pricingNote: "Free with registration",
    accreditation: ["AMA PRA Category 1"],
    accreditedBy: "ACCME",
    topics: [
      "Pain Management", "Opioid Prescribing", "HIV/AIDS", "Palliative Care",
      "Mental Health", "Substance Use Disorders", "Infection Control",
      "General / No Specific Topic",
    ],
    description: "Free online CME/CE for physicians, NPs, PAs covering primary care, cardiology, oncology, and more.",
    stateSpecific: false,
    stateSpecificNote: null,
    dualAccredited: false,
    format: ["Online modules", "Video"],
  },
  {
    id: "freecme",
    name: "FreeCME.com",
    url: "https://www.freecme.com/",
    pricing: "free",
    pricingNote: "Free with registration",
    accreditation: ["AMA PRA Category 1"],
    accreditedBy: "ACCME",
    topics: [
      "Pain Management", "Infection Control", "Patient Safety",
      "Pharmacology", "General / No Specific Topic",
    ],
    description: "Free CME from AHC Media LLC covering a variety of topics in multiple formats.",
    stateSpecific: false,
    stateSpecificNote: null,
    dualAccredited: false,
    format: ["Online articles", "Self-study"],
  },
  {
    id: "cdcHivNexus",
    name: "CDC HIV Nexus",
    url: "https://www.cdc.gov/hivnexus/hcp/cme/index.html",
    pricing: "free",
    pricingNote: "Free; government-funded",
    accreditation: ["AMA PRA Category 1"],
    accreditedBy: "ACCME (via partner providers)",
    topics: [
      "HIV/AIDS", "Infection Control",
    ],
    description: "CDC-funded free CME/CE programs for HIV prevention and care continuum, offered through Medscape and partner organizations.",
    stateSpecific: false,
    stateSpecificNote: null,
    dualAccredited: false,
    format: ["Online modules", "Webinars"],
  },

  // ─── SPECIALTY / TOPIC-FOCUSED PROVIDERS ────────────────────────────
  {
    id: "scopeOfPain",
    name: "SCOPE of Pain (Boston University)",
    url: "https://www.scopeofpain.org/",
    pricing: "free",
    pricingNote: "Free; grant-funded",
    accreditation: ["AMA PRA Category 1", "AAFP Prescribed"],
    accreditedBy: "ACCME (Boston University School of Medicine)",
    topics: [
      "Pain Management", "Opioid Prescribing", "Controlled Substances",
      "Substance Use Disorders", "Palliative Care",
    ],
    description: "Safer/Competent Opioid Prescribing Education. Free modules covering opioid prescribing best practices, addiction, overdose prevention, and naloxone. Meets NY State 3-hour mandate and MATE Act requirements.",
    stateSpecific: true,
    stateSpecificNote: "Approved for NY, MA, and other state-specific opioid prescribing mandates",
    dualAccredited: false,
    format: ["Online modules (30-min to 1.75-hr each)", "Self-paced"],
  },
  {
    id: "nejmPainOpioids",
    name: "NEJM Knowledge+ Pain Management and Opioids",
    url: "https://pain-management-cme.nejm.org/",
    pricing: "free",
    pricingNote: "Free 10-hour adaptive learning course",
    accreditation: ["AMA PRA Category 1", "AAFP Prescribed"],
    accreditedBy: "ACCME",
    topics: [
      "Pain Management", "Opioid Prescribing", "Controlled Substances",
      "Substance Use Disorders",
    ],
    description: "Free, 10-hour adaptive learning course (up to 10.25 credits) covering evidence-based opioid prescribing per CDC guidelines. Satisfies DEA MATE Act 8-hour requirement. Meets MA Board criteria for risk management and opioid education.",
    stateSpecific: true,
    stateSpecificNote: "Meets MA risk management/opioid education; satisfies DEA MATE Act",
    dualAccredited: false,
    format: ["Adaptive learning", "Videos", "Infographics", "Downloadable PDFs"],
  },
  {
    id: "pcss",
    name: "PCSS (Providers Clinical Support System)",
    url: "https://pcssnow.org/",
    pricing: "free",
    pricingNote: "Free; SAMHSA-funded",
    accreditation: ["AMA PRA Category 1"],
    accreditedBy: "ACCME",
    topics: [
      "Substance Use Disorders", "Opioid Prescribing", "Pain Management",
      "Mental Health",
    ],
    description: "SAMHSA-funded clinical training on substance use disorders. Includes SUD 101 Core Curriculum (23 modules) and Chronic Pain Core Curriculum (10 modules). Satisfies DEA MATE Act requirement.",
    stateSpecific: false,
    stateSpecificNote: null,
    dualAccredited: false,
    format: ["Online modules (30-60 min each)", "Webinars", "Mentoring"],
  },
  {
    id: "jhHivMedicine",
    name: "Johns Hopkins Foundations in HIV Medicine",
    url: "https://www.hopkinsmedicine.org/infectious-diseases/education/infectious-diseases-courses/foundations-in-hiv-medicine-online-cme",
    pricing: "free",
    pricingNote: "Free online course",
    accreditation: ["AMA PRA Category 1"],
    accreditedBy: "ACCME (Johns Hopkins University School of Medicine)",
    topics: [
      "HIV/AIDS", "Infection Control", "Pharmacology",
    ],
    description: "Comprehensive 8-module online course covering HIV epidemiology, immunology, antiretroviral therapy, and primary care. Up to 14 AMA PRA Category 1 Credits.",
    stateSpecific: false,
    stateSpecificNote: null,
    dualAccredited: false,
    format: ["Online modules (8 modules)"],
  },
  {
    id: "healthhiv",
    name: "HealthHIV - HIVPCP Certified Provider",
    url: "https://healthhiv.org/hivpcp/",
    pricing: "free",
    pricingNote: "Free certification program",
    accreditation: ["AMA PRA Category 1", "ABIM MOC"],
    accreditedBy: "Joint Accreditation (ACCME + ACPE + ANCC)",
    topics: [
      "HIV/AIDS",
    ],
    description: "HIVPCP Certified Provider certification program. 8 modules covering HIV prevention, testing, treatment, and care. Up to 8 credits.",
    stateSpecific: false,
    stateSpecificNote: null,
    dualAccredited: false,
    format: ["Online modules (8 modules)", "Certification program"],
  },
  {
    id: "ceiTraining",
    name: "CEI (Clinical Education Initiative - NY AIDS Institute)",
    url: "https://ceitraining.org/",
    pricing: "free",
    pricingNote: "Free; NY State DOH funded",
    accreditation: ["AMA PRA Category 1"],
    accreditedBy: "ACCME",
    topics: [
      "HIV/AIDS", "Infection Control", "Substance Use Disorders",
    ],
    description: "NY State DOH AIDS Institute program offering free CE-accredited trainings on HIV primary care, prevention, sexual health, hepatitis C, and drug user health.",
    stateSpecific: true,
    stateSpecificNote: "New York State-focused but available nationally",
    dualAccredited: false,
    format: ["Online courses", "Live trainings", "Preceptorships"],
  },
  {
    id: "mjhsPalliative",
    name: "MJHS Institute for Innovation in Palliative Care",
    url: "https://www.mjhspalliativeinstitute.org/e-learning/?p=physician",
    pricing: "free",
    pricingNote: "Free webinars and multimedia modules",
    accreditation: ["AMA PRA Category 1"],
    accreditedBy: "ACCME",
    topics: [
      "Palliative Care", "End-of-Life Care", "Implicit Bias",
      "Cultural Competency", "Geriatric Medicine",
    ],
    description: "Free interdisciplinary palliative care education including webinars and interactive multimedia modules. Award-winning unconscious bias awareness module for end-of-life care. Up to 9.75 CE credits.",
    stateSpecific: false,
    stateSpecificNote: null,
    dualAccredited: false,
    format: ["Webinars (live and on-demand)", "Interactive multimedia modules"],
  },
  {
    id: "capc",
    name: "Center to Advance Palliative Care (CAPC)",
    url: "https://www.capc.org/training/",
    pricing: "membership",
    pricingNote: "Requires CAPC membership (institutional or individual)",
    accreditation: ["AMA PRA Category 1"],
    accreditedBy: "ACCME",
    topics: [
      "Palliative Care", "End-of-Life Care", "Pain Management",
      "Geriatric Medicine",
    ],
    description: "Comprehensive palliative care training with unlimited access for members. Covers introduction to palliative care, symptom management, communication skills, and care delivery models.",
    stateSpecific: false,
    stateSpecificNote: null,
    dualAccredited: false,
    format: ["Online courses", "Virtual seminars"],
  },

  // ─── MAJOR PAID / SUBSCRIPTION PLATFORMS ────────────────────────────
  {
    id: "uptodate",
    name: "UpToDate (Wolters Kluwer)",
    url: "https://www.wolterskluwer.com/en/solutions/uptodate/",
    pricing: "subscription",
    pricingNote: "Individual subscription ~$579/yr; institutional access varies; CME included with subscription",
    accreditation: ["AMA PRA Category 1", "AAFP Prescribed", "ABIM MOC"],
    accreditedBy: "ACCME (Accreditation with Commendation)",
    topics: [
      "Pain Management", "Opioid Prescribing", "Controlled Substances", "Ethics",
      "Infection Control", "Patient Safety", "End-of-Life Care", "Geriatric Medicine",
      "HIV/AIDS", "Palliative Care", "Mental Health", "Substance Use Disorders",
      "Pharmacology", "General / No Specific Topic",
    ],
    description: "Evidence-based clinical decision support. Earn CME credits passively while researching clinical questions -- no quizzes required. 0.5 credits per learning cycle with no annual limit. Also meets DEA MATE Act requirement.",
    stateSpecific: false,
    stateSpecificNote: null,
    dualAccredited: false,
    aoaNote: "AMA PRA Category 1 credits recognized as AOA Category 2-B; not direct 1-A",
    format: ["Point-of-care (search-based)", "Clinical summaries", "Mobile app"],
  },
  {
    id: "boardvitals",
    name: "BoardVitals",
    url: "https://www.boardvitals.com/",
    pricing: "subscription",
    pricingNote: "$599-$899/6 months; $999/12 months; up to 100 Cat 1 credits",
    accreditation: ["AMA PRA Category 1", "ABIM MOC"],
    accreditedBy: "ACCME",
    topics: [
      "Pain Management", "Pharmacology", "Patient Safety",
      "General / No Specific Topic",
    ],
    description: "Board-style review question banks across 35+ specialties. Earn CME by answering case-style questions (70% minimum to earn credit). Also tracks state CME requirements.",
    stateSpecific: true,
    stateSpecificNote: "CME Coach tool helps find courses matching state-specific requirements",
    dualAccredited: false,
    format: ["Question banks", "Mobile app", "Customizable exams"],
  },
  {
    id: "oakstone",
    name: "Oakstone / Harvard Medical School Online CE",
    url: "https://oakstone.com/",
    pricing: "subscription",
    pricingNote: "Subscription plans vary; Harvard CME courses individually priced ($200-$1,395+)",
    accreditation: ["AMA PRA Category 1", "ABIM MOC"],
    accreditedBy: "ACCME (Harvard Medical School: Accreditation with Commendation)",
    topics: [
      "Geriatric Medicine", "Palliative Care", "Pain Management",
      "Mental Health", "Pharmacology", "Patient Safety",
      "General / No Specific Topic",
    ],
    description: "Premium CME from Harvard Medical School and other academic institutions. Specialties include geriatrics, palliative care, internal medicine, and more. 24/7 multimedia access.",
    stateSpecific: false,
    stateSpecificNote: null,
    dualAccredited: false,
    format: ["Audio", "Video", "Text-based", "Streaming"],
  },

  // ─── STATE-SPECIFIC / COMPLIANCE-FOCUSED PROVIDERS ──────────────────
  {
    id: "netce",
    name: "NetCE",
    url: "https://www.netce.com/",
    pricing: "paid",
    pricingNote: "Individual courses ~$20-$75; unlimited packages ~$99-$189/yr depending on profession",
    accreditation: ["AMA PRA Category 1", "ABIM MOC"],
    accreditedBy: "ACCME",
    topics: [
      "Pain Management", "Opioid Prescribing", "Controlled Substances", "Ethics",
      "Infection Control", "Patient Safety", "Medical Errors Prevention",
      "Risk Management", "Suicide Prevention", "Cultural Competency",
      "Implicit Bias", "End-of-Life Care", "Geriatric Medicine",
      "Domestic Violence", "Child Abuse Recognition", "Human Trafficking",
      "Pharmacology", "Telemedicine", "Sexual Harassment Prevention",
      "HIV/AIDS", "Palliative Care", "Mental Health", "Substance Use Disorders",
      "Prescriptive Practice", "Trauma-Informed Care",
      "General / No Specific Topic",
    ],
    description: "Comprehensive state-specific mandatory topic library. Covers virtually every state-mandated CME topic including domestic violence, human trafficking, child abuse, sexual harassment, and implicit bias. Courses are individually approved by state boards where required (e.g., TX HHSC for human trafficking).",
    stateSpecific: true,
    stateSpecificNote: "Dedicated state requirement pages for all 50 states with pre-mapped courses",
    dualAccredited: false,
    format: ["Text-based online courses", "Self-paced"],
  },
  {
    id: "cmetrail",
    name: "CME Trail",
    url: "https://www.cmetrail.com/",
    pricing: "freemium",
    pricingNote: "Free state requirement guides; paid CME question bank and courses for up to 120 credits",
    accreditation: ["AMA PRA Category 1"],
    accreditedBy: "ACCME",
    topics: [
      "Pain Management", "Opioid Prescribing", "Controlled Substances",
      "Ethics", "Substance Use Disorders", "General / No Specific Topic",
    ],
    description: "CME compliance platform with question banks, summarized guidelines, guideline-based algorithms, and a price transparency tool. Comprehensive state-by-state requirement guides for MD and DO physicians.",
    stateSpecific: true,
    stateSpecificNote: "Detailed state-by-state guides for all 50 states plus territories",
    dualAccredited: false,
    format: ["Question banks", "Guideline summaries", "Algorithms"],
  },

  // ─── PROFESSIONAL SOCIETY CME ───────────────────────────────────────
  {
    id: "aafp",
    name: "AAFP (American Academy of Family Physicians)",
    url: "https://www.aafp.org/cme.html",
    pricing: "freemium",
    pricingNote: "Many free courses; FP Comprehensive ~$495 for 60 credits; membership unlocks more",
    accreditation: ["AAFP Prescribed", "AMA PRA Category 1", "ABIM MOC"],
    accreditedBy: "AAFP Credit System (ACCME Accreditation with Commendation)",
    topics: [
      "Pain Management", "Opioid Prescribing", "Ethics", "Infection Control",
      "Patient Safety", "End-of-Life Care", "Geriatric Medicine", "HIV/AIDS",
      "Palliative Care", "Mental Health", "Substance Use Disorders",
      "Pharmacology", "Telemedicine", "General / No Specific Topic",
    ],
    description: "Premier family medicine CME provider. FP Comprehensive offers up to 60 credits per year. FMX (Family Medicine Experience) conference offers 250+ education options. Free ABFM exam-style questions and journal CME available.",
    stateSpecific: false,
    stateSpecificNote: null,
    dualAccredited: false,
    format: ["Online modules", "Self-assessment", "Conferences", "Journal-based"],
  },
  {
    id: "acp",
    name: "ACP (American College of Physicians)",
    url: "https://www.acponline.org/cme-moc/",
    pricing: "freemium",
    pricingNote: "Some free (Ethics Manual 10 credits, High-Value Care 5 credits); paid modules $25 each or $199 package",
    accreditation: ["AMA PRA Category 1", "ABIM MOC"],
    accreditedBy: "ACCME",
    topics: [
      "Ethics", "Pain Management", "Opioid Prescribing", "Patient Safety",
      "HIV/AIDS", "Palliative Care", "Mental Health", "Pharmacology",
      "General / No Specific Topic",
    ],
    description: "Internal medicine CME with notable free offerings: ACP Ethics Manual (10 credits) and High-Value Care Cases (5 credits). Pain Management series available ($25/module or $199 full package of 7 modules + 2 case studies).",
    stateSpecific: false,
    stateSpecificNote: null,
    dualAccredited: false,
    format: ["Online modules", "Case studies", "Journal CME", "Conferences"],
  },
  {
    id: "acep",
    name: "ACEP (American College of Emergency Physicians)",
    url: "https://www.acep.org/education/cme",
    pricing: "membership",
    pricingNote: "Free CME hours for ACEP members; discounted rates; non-member pricing varies",
    accreditation: ["AMA PRA Category 1", "ACEP Category I"],
    accreditedBy: "ACCME",
    topics: [
      "Pain Management", "Patient Safety", "Medical Errors Prevention",
      "Pharmacology", "Trauma-Informed Care", "Substance Use Disorders",
      "General / No Specific Topic",
    ],
    description: "Emergency medicine CME including Critical Decisions (5 credits/lesson, 24 lessons/yr) and Practice Essentials (27.25 credits). Online Learning Center provides dozens of free CME hours for members.",
    stateSpecific: false,
    stateSpecificNote: null,
    dualAccredited: false,
    format: ["Online modules", "Case-based learning", "Conferences", "Webinars"],
  },
  {
    id: "acofp",
    name: "ACOFP (American College of Osteopathic Family Physicians)",
    url: "https://www.acofp.org/continuing-education/continuing-medical-education",
    pricing: "membership",
    pricingNote: "Live conferences and on-demand events; pricing varies",
    accreditation: ["AOA Category 1-A", "AMA PRA Category 1"],
    accreditedBy: "AOA + ACCME",
    topics: [
      "Pain Management", "Opioid Prescribing", "Ethics",
      "Patient Safety", "Mental Health", "Substance Use Disorders",
      "Geriatric Medicine", "General / No Specific Topic",
    ],
    description: "Osteopathic family medicine CME offering both AOA Category 1-A and AMA PRA Category 1 credits. Key events include ACOFP annual conference (up to 40 credits) and CME at Sea.",
    stateSpecific: false,
    stateSpecificNote: null,
    dualAccredited: true,
    format: ["Live conferences", "On-demand virtual events", "Webinars"],
  },
  {
    id: "aahivm",
    name: "AAHIVM (American Academy of HIV Medicine)",
    url: "https://aahivm.org/accredited-ce-opportunities/",
    pricing: "membership",
    pricingNote: "CE opportunities included with membership",
    accreditation: ["AMA PRA Category 1"],
    accreditedBy: "ACCME",
    topics: [
      "HIV/AIDS", "Infection Control", "Pharmacology",
    ],
    description: "Accredited CE including Core Curriculum in HIV Prevention, Treatment and Care, plus National HIV and Aging Initiative.",
    stateSpecific: false,
    stateSpecificNote: null,
    dualAccredited: false,
    format: ["Online courses", "Conferences"],
  },

  // ─── DEA / MATE ACT COMPLIANCE ──────────────────────────────────────
  {
    id: "amaDea",
    name: "AMA Ed Hub - DEA MATE Act Training",
    url: "https://edhub.ama-assn.org/course/302",
    pricing: "free",
    pricingNote: "Free; up to 93.5 credits available (only 8 required)",
    accreditation: ["AMA PRA Category 1"],
    accreditedBy: "ACCME",
    topics: [
      "Substance Use Disorders", "Opioid Prescribing", "Pain Management",
      "Controlled Substances",
    ],
    description: "Free training to satisfy the one-time DEA MATE Act 8-hour requirement for all registered practitioners. While only 8 hours required, the course offers up to 93.5 hours of credit on treating/managing patients with opioid or other substance use disorders.",
    stateSpecific: false,
    stateSpecificNote: null,
    dualAccredited: false,
    format: ["Online modules", "Self-paced"],
    mateActCompliant: true,
  },
  {
    id: "asamBuprenorphine",
    name: "ASAM Buprenorphine Mini Course",
    url: "https://edhub.ama-assn.org/asam-education-cme/by-topic",
    pricing: "free",
    pricingNote: "Free; 1 hour",
    accreditation: ["AMA PRA Category 1"],
    accreditedBy: "ACCME (via ASAM / AMA Ed Hub)",
    topics: [
      "Substance Use Disorders", "Opioid Prescribing", "Pharmacology",
    ],
    description: "Free 1-hour buprenorphine mini course from the American Society of Addiction Medicine. Contributes toward DEA MATE Act requirement.",
    stateSpecific: false,
    stateSpecificNote: null,
    dualAccredited: false,
    format: ["Online module"],
    mateActCompliant: true,
  },

  // ─── ADDITIONAL SPECIALTY PROVIDERS ─────────────────────────────────
  {
    id: "pamed",
    name: "PAMED (Pennsylvania Medical Society)",
    url: "https://www.pamedsoc.org/opioids-cme",
    pricing: "paid",
    pricingNote: "Pricing varies by course",
    accreditation: ["AMA PRA Category 1"],
    accreditedBy: "ACCME",
    topics: [
      "Pain Management", "Opioid Prescribing", "Controlled Substances",
      "Substance Use Disorders",
    ],
    description: "PA Act 124-compliant online training on opioid prescribing and pain management to meet Pennsylvania-specific CME requirements.",
    stateSpecific: true,
    stateSpecificNote: "Pennsylvania Act 124 compliant",
    dualAccredited: false,
    format: ["Online courses"],
  },
  {
    id: "mayoClinicCME",
    name: "Mayo Clinic CME",
    url: "https://ce.mayo.edu/",
    pricing: "paid",
    pricingNote: "Course pricing varies; some free offerings",
    accreditation: ["AMA PRA Category 1", "ABIM MOC"],
    accreditedBy: "ACCME (Accreditation with Commendation)",
    topics: [
      "Palliative Care", "End-of-Life Care", "Pain Management",
      "Geriatric Medicine", "Mental Health", "Patient Safety",
      "General / No Specific Topic",
    ],
    description: "Highly regarded CME from Mayo Clinic across multiple specialties including palliative medicine, geriatrics, and internal medicine. Live courses, podcasts, and online education.",
    stateSpecific: false,
    stateSpecificNote: null,
    dualAccredited: false,
    format: ["Live conferences", "Podcasts", "Online courses"],
  },
  {
    id: "clevelandClinic",
    name: "Cleveland Clinic Center for Continuing Education",
    url: "https://www.ccfcme.org/",
    pricing: "freemium",
    pricingNote: "Many free CME activities; registration required",
    accreditation: ["AMA PRA Category 1"],
    accreditedBy: "ACCME",
    topics: [
      "Pain Management", "Infection Control", "Patient Safety",
      "Pharmacology", "Geriatric Medicine", "Mental Health",
      "General / No Specific Topic",
    ],
    description: "Cleveland Clinic CME including text-based programs, webcasts, and podcasts. Free registration required. Wide range of specialties.",
    stateSpecific: false,
    stateSpecificNote: null,
    dualAccredited: false,
    format: ["Text-based", "Webcasts", "Podcasts"],
  },
  {
    id: "cme4life",
    name: "CME4Life",
    url: "https://cme4life.com/",
    pricing: "paid",
    pricingNote: "$59-$800+ per course; conference bundles available",
    accreditation: ["AMA PRA Category 1", "AAPA Category 1"],
    accreditedBy: "ACCME (American Medical Seminars)",
    topics: [
      "Pharmacology", "Pain Management", "Mental Health",
      "General / No Specific Topic",
    ],
    description: "Active engagement learning CME using mnemonics and interactive techniques. Specializes in emergency medicine, pharmacology, urgent care, and critical care. Known for Demystifying Emergency Medicine series.",
    stateSpecific: false,
    stateSpecificNote: null,
    dualAccredited: false,
    format: ["Live conferences", "Streaming video", "Self-study materials"],
  },
  {
    id: "ebmedicine",
    name: "EB Medicine",
    url: "https://www.ebmedicine.net/",
    pricing: "subscription",
    pricingNote: "Annual subscription ~$349/yr",
    accreditation: ["AMA PRA Category 1", "ACEP Category I"],
    accreditedBy: "ACCME",
    topics: [
      "Pain Management", "Patient Safety", "Medical Errors Prevention",
      "Pharmacology", "Trauma-Informed Care",
      "General / No Specific Topic",
    ],
    description: "Evidence-based emergency medicine and urgent care CME. Focuses on clinical decision-making and evidence-based education for emergency and urgent care practitioners.",
    stateSpecific: false,
    stateSpecificNote: null,
    dualAccredited: false,
    format: ["Journals", "Online modules", "Mobile app"],
  },
  {
    id: "dynaMed",
    name: "DynaMed",
    url: "https://www.dynamed.com/",
    pricing: "subscription",
    pricingNote: "Individual ~$399/yr; institutional pricing varies; CME included",
    accreditation: ["AMA PRA Category 1", "AAFP Prescribed"],
    accreditedBy: "ACCME",
    topics: [
      "Pain Management", "Infection Control", "Pharmacology",
      "General / No Specific Topic",
    ],
    description: "Evidence-based clinical decision support (like UpToDate). Earn 0.5 AMA PRA Category 1 Credits per reflective learning cycle, up to 20 credits per year, while doing clinical research.",
    stateSpecific: false,
    stateSpecificNote: null,
    dualAccredited: false,
    format: ["Point-of-care (search-based)", "Clinical summaries"],
  },
  {
    id: "qxmd",
    name: "Read by QxMD",
    url: "https://qxmd.com/read",
    pricing: "free",
    pricingNote: "Free; up to 20 CME credits/yr for reading eligible articles",
    accreditation: ["AMA PRA Category 1"],
    accreditedBy: "ACCME",
    topics: [
      "General / No Specific Topic",
    ],
    description: "Earn up to 20 free CME credits per year by reading eligible journal articles. Each article provides 0.5 CME credits. Personalized feed based on your specialty.",
    stateSpecific: false,
    stateSpecificNote: null,
    dualAccredited: false,
    format: ["Article reading", "Mobile app"],
  },
];

// ─── TOPIC-TO-PROVIDER MAPPING ────────────────────────────────────────
// Pre-computed lookup: topic -> array of provider IDs for fast access.
// Regenerated from CME_PROVIDERS data above.

export const TOPIC_PROVIDER_MAP = CME_PROVIDERS.reduce((map, provider) => {
  provider.topics.forEach(topic => {
    if (!map[topic]) map[topic] = [];
    map[topic].push(provider.id);
  });
  return map;
}, {});

// ─── HELPER FUNCTIONS ─────────────────────────────────────────────────

/** Get all providers for a specific topic */
export function getProvidersForTopic(topic) {
  return CME_PROVIDERS.filter(p => p.topics.includes(topic));
}

/** Get only free providers for a topic */
export function getFreeProvidersForTopic(topic) {
  return CME_PROVIDERS.filter(
    p => p.topics.includes(topic) && (p.pricing === "free" || p.pricing === "freemium")
  );
}

/** Get providers that offer state-specific courses */
export function getStateSpecificProviders() {
  return CME_PROVIDERS.filter(p => p.stateSpecific);
}

/** Get providers offering dual AMA/AOA accreditation */
export function getDualAccreditedProviders() {
  return CME_PROVIDERS.filter(p => p.dualAccredited);
}

/** Get providers that satisfy DEA MATE Act requirement */
export function getMateActProviders() {
  return CME_PROVIDERS.filter(p => p.mateActCompliant);
}

/** Get a single provider by id */
export function getProviderById(id) {
  return CME_PROVIDERS.find(p => p.id === id);
}

/** Get all unique topics covered across all providers */
export function getAllCoveredTopics() {
  return [...new Set(CME_PROVIDERS.flatMap(p => p.topics))].sort();
}

/** Search providers by name or description text */
export function searchProviders(query) {
  const q = query.toLowerCase();
  return CME_PROVIDERS.filter(
    p => p.name.toLowerCase().includes(q) ||
         p.description.toLowerCase().includes(q)
  );
}

/** Get providers grouped by pricing tier */
export function getProvidersByPricing() {
  return {
    free: CME_PROVIDERS.filter(p => p.pricing === "free"),
    freemium: CME_PROVIDERS.filter(p => p.pricing === "freemium"),
    paid: CME_PROVIDERS.filter(p => p.pricing === "paid"),
    subscription: CME_PROVIDERS.filter(p => p.pricing === "subscription"),
    membership: CME_PROVIDERS.filter(p => p.pricing === "membership"),
  };
}
