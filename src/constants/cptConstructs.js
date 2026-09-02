/**
 * Procedure → construct knowledge. A named spine operation is CODED AS A
 * CONSTRUCT, never one code: the surgeon says the plan ("ACDF C5-6",
 * "PCDF 3-6 with lami") and the system implies every component that
 * completes it. Cranial tumor cases are coded by COMPARTMENT + PATHOLOGY,
 * never by the word craniotomy vs craniectomy. Injected into the
 * case-dictation and RVU-coder prompts: one source of truth for both.
 *
 * Sources for the cranial section: AMA CPT descriptors for 61510-61521;
 * NCCI Policy Manual for Medicare Services 2026 Ch VIII Sec C.4 (cranioplasty),
 * Sec F.1 (operating microscope); Medicare Claims Processing Manual
 * (Pub 100-04) Ch 12 Sec 20.4.5; CPT Diagnostic Ultrasound guidelines.
 * The deterministic post-model pass in src/utils/cptCoderRules.js enforces
 * the bundling rules again regardless of what the model emits.
 */

export const CONSTRUCT_RULES = `
SURGEON'S SHORTHAND: "PIF" = posterior instrumented fusion; "PCDF" = posterior cervical
decompression and fusion; "DLL" = decompressive lumbar laminectomy; "HLD" = hemilaminectomy
discectomy; "ACDF" = anterior cervical discectomy and fusion; "ACCF" = anterior cervical
corpectomy and fusion; "SDD" = subdural drain; "EVD" = external ventricular drain;
"ETV" = endoscopic third ventriculostomy (62201); "CUSA" = ultrasonic aspirator (no code).

A NAMED OPERATION IMPLIES ITS FULL CONSTRUCT: code the whole plan, not one code.
Level arithmetic: LEVELS (interspaces) = vertebrae spanned − 1; instrumentation and plate
TIERS count VERTEBRAE spanned. "C3-7" spans 5 vertebrae = 4 levels.

ACDF (anterior cervical discectomy & fusion):
  22551 (first level: arthrodesis + discectomy + decompression)
  + 22552 × each additional level
  + anterior plate: 22845 (2-3 vertebrae) / 22846 (4-7)
  + 22853 × each interspace (interbody cage/spacer)
  + graft: 20931 (structural allograft) or 20930 (morselized)
  1-level ACDF = 22551, 22845, 22853, 20931.
  3-level ACDF (C4-7) = 22551, 22552 x2, 22846, 22853 x3, 20931.
  Never add 69990 to an ACDF: the CPT parenthetical under 69990 excludes 22551/22552.

ACCF (corpectomy): 63081 (+63082 per additional vertebra) + 22554 arthrodesis
  + 22845/22846 plate + 22853 cage + 20931.

POSTERIOR INSTRUMENTED FUSION (PIF/PCDF, any region):
  arthrodesis base: cervical 22600 / thoracic 22610 / lumbar 22612
  + 22614 × each additional level
  + posterior segmental instrumentation: 22842 (3-6 vertebrae) / 22843 (7-12) / 22844 (13+)
  + 20930 AND 20936 (allograft + local autograft)
  + decompression when a lami is part of the plan: 63045 (cervical) or 63047 (lumbar)
    + 63048 × additional levels; thoracic 63046 (+63048) or the 63003 family.
    (63047/63048 apply to posterolateral-only fusion 22612; with an INTERBODY fusion
    22630/22633 the decompression add-on is 63052/63053, see TLIF/PLIF.)
  Occipitocervical fusion: 22590. C1-2 (atlantoaxial): 22595.
  "PCDF C3-7 w lami" = 22600, 22614 x3, 22842, 20930, 20936, 63045, 63048 x3.

TLIF/PLIF (posterior interbody): 22633 (combined interbody + posterolateral, first level)
  + 22634 × additional levels + 22842 + 22853 × cages + 20930 + 20936
  + decompression at the FUSED interspace: 63052 (single segment) + 63053 × each additional
    fused segment. CPT parenthetical: use 63052/63053 with 22630, 22632, 22633, 22634.
    NEVER 63047/63048 at a fused level (NCCI bundles 63047 into 22630/22633 at the same
    level); 63047/63048 only for a level NOT in the arthrodesis, and say which level in why.
  Discectomy to prepare the interspace is inside 22630/22633 (their descriptors say so):
    never add 63030 at the fused level.
  PLIF alone (no posterolateral): 22630 + 22632 × additional levels, same add-ons.

KYPHOPLASTY: 22513 (thoracic) / 22514 (lumbar) + 22515 × additional levels.

CRANIAL TUMOR CODE SELECTION (deterministic: compartment + pathology pick the code):
  1. Compartment from the approach or location words in the dictation.
     INFRATENTORIAL (posterior fossa): suboccipital, retrosigmoid, posterior fossa,
       infratentorial, cerebellar, cerebellum, foramen magnum, petroclival, tentorial,
       CPA, cerebellopontine, fourth ventricle, brainstem, clivus, clival, far lateral,
       transcondylar, telovelar.
     SUPRATENTORIAL: frontal, temporal, parietal, occipital, pterional, convexity,
       parasagittal, falcine, falx, sphenoid wing, olfactory groove, tuberculum, planum,
       orbitozygomatic, bifrontal, interhemispheric, transcortical, insular, supratentorial.
  2. Code within the compartment by pathology (AMA CPT descriptors):
     INFRATENTORIAL: meningioma → 61519 ("...infratentorial or posterior fossa; meningioma");
       cerebellopontine angle tumor (vestibular schwannoma, acoustic neuroma, CPA lesion)
       → 61520; midline tumor at base of skull (clivus, fourth ventricle, midline brainstem)
       → 61521; any other tumor (metastasis, glioma, hemangioblastoma, off-midline
       ependymoma) → 61518, whose descriptor reads "except meningioma, cerebellopontine
       angle tumor, or midline tumor at base of skull".
     SUPRATENTORIAL: meningioma → 61512; any other tumor (metastasis, glioma, GBM) → 61510;
       brain abscess → 61514; cyst → 61516.
     A suboccipital or posterior fossa meningioma is 61519: never 61512 (that code is
       supratentorial by descriptor) and never 61518 (its descriptor excludes meningioma).
  3. "Craniotomy" vs "craniectomy" in the dictation never changes the code: CPT titles the
     whole 6151x family "Craniectomy", and compartment plus pathology select the code.
  4. Hematoma evacuation by craniotomy: 61312 supratentorial extradural OR subdural (acute
     SDH, EDH); 61313 supratentorial intracerebral; 61314/61315 the infratentorial pair.
     Burr hole(s) for chronic subdural = 61154 (one unit per side, plural "hole(s)");
     twist drill = 61108. Decompressive craniectomy for intracranial hypertension without
     hematoma evacuation = 61322 (61323 with lobectomy), any site.

CRANIAL ADJUNCTS (only when the words support them; never invent one):
  Operating microscope → +69990 once. Do not write "microdissection" in why unless it was
    dictated; 69990 requires microsurgical technique under the operating microscope
    (loupes do not qualify). The app appends the Medicare payer note itself.
  Navigation / stealth / frameless stereotaxy / neuronavigation → +61781 (intradural) once;
    61782 only for an extradural cranial procedure; never both.
  Intraoperative ultrasound, CUSA (ultrasonic aspirator), Doppler probe: emit NO code. They
    are instruments within the resection. Ultrasound guidance is separately reportable only
    with a permanently recorded image and a written description of the localization (CPT
    Diagnostic Ultrasound guidelines), which a dictated case summary does not establish.
  Cranioplasty in the SAME session at the SAME site (titanium plate, mesh, replacing the
    bone flap, covering the craniectomy defect): emit NO cranioplasty code (62140, 62141,
    62143). NCCI Policy Manual Ch VIII Sec C.4: replacing the skull flap during the same
    procedure is an integral component of the craniotomy and is not reported with
    62140/62141. Instead add a questions entry saying so and naming the two exceptions:
    a documented defect larger than the exposure (62140 up to 5 cm, 62141 over 5 cm, by
    measured diameter, modifier 59/XS) or a cranioplasty at a later encounter (62143 for a
    returned flap or plate; 62140/62141 by size). Never infer defect size from the material.
  Duraplasty, dural graft, dural closure: included. ICP monitor/EVD placed at the same sitting
    → 61107/61210 separately only if through a separate incision.

CARDIAC: CABG AND CONCOMITANT PROCEDURES (only when the words support them):
  CABG graft count: arterial-only grafts pick the base code by arterial graft count (33533
    single, 33534 two). Combining an arterial graft with a venous graft (eg, "LIMA to LAD,
    reverse SV graft to the OM") adds the combined arterial-venous add-on by venous graft
    count: 33517 for a single vein graft. "CABG x2 (LIMA to LAD, reverse SVG to OM)" =
    33533 + 33517, never 33534 (33534 is TWO arterial grafts; here only one graft is
    arterial, the other is venous).
  Concomitant atrial ablation (Cox-Maze or similar clamp/catheter lesion set) performed at
    the time of the CABG or another cardiac procedure is an add-on, selected by lesion set
    extent and bypass use: limited, without bypass → 33257; limited, with bypass → 33258;
    extensive (eg, a Cox-Maze IV or modified Cox-Maze) with bypass → 33259. A modified
    Cox-Maze done on bypass alongside a CABG is 33259, regardless of which clamp made the
    lesion set.
  Concomitant left atrial appendage (LAA) exclusion or ligation (clip, eg AtriCure) by an
    open technique at the time of another cardiac procedure → 33267 (add-on).
  Endoscopic harvest of the leg vein used for a venous graft → 33508 (add-on), one unit
    per graft harvested endoscopically; an open harvest carries no separate code.
  Intraoperative transesophageal echocardiogram (TEE): emit NO code. It is separately
    billable only when the billing physician personally performed and interpreted it, with
    a retained image and a written report; a dictated case summary alone does not establish
    that, and in most cardiac cases anesthesia performs and bills the TEE. Add a questions
    entry instead of a code.
  Intraoperative cardioversion or defibrillation for an arrhythmia or arrest arising during
    this operative session: emit NO code. Managing an intraoperative event is part of the
    global surgical package for the primary procedure it happened during (Medicare Claims
    Processing Manual, Pub 100-04, Ch 12 Sec 40.1). An elective cardioversion is reportable
    only as a separate encounter outside this operative session.
  MODIFIER 22: if the physician says "modifier 22" or "increased procedural services", keep
    every code, append modifier 22 to only the single highest-wRVU primary procedure in the
    entry, and add a questions entry noting Medicare requires the operative note to state in
    words why the work substantially exceeded what that code typically requires; payment is
    not automatic and is adjusted per payer review.

NEVER: E/M codes on operative cases; codes for things merely mentioned; a code family
swap (posterolateral vs interbody, anterior vs posterior, supratentorial vs infratentorial)
the surgeon didn't say.
`;
