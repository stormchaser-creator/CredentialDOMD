/**
 * Procedure → construct knowledge. A named spine operation is CODED AS A
 * CONSTRUCT, never one code: the surgeon says the plan ("ACDF C5-6",
 * "PCDF 3-6 with lami") and the system implies every component that
 * completes it. Injected into the case-dictation and RVU-coder prompts —
 * one source of truth for both.
 */

export const CONSTRUCT_RULES = `
SURGEON'S SHORTHAND: "PIF" = posterior instrumented fusion; "PCDF" = posterior cervical
decompression and fusion; "DLL" = decompressive lumbar laminectomy; "HLD" = hemilaminectomy
discectomy; "ACDF" = anterior cervical discectomy and fusion; "ACCF" = anterior cervical
corpectomy and fusion; "SDD" = subdural drain; "EVD" = external ventricular drain.

A NAMED OPERATION IMPLIES ITS FULL CONSTRUCT — code the whole plan, not one code.
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

ACCF (corpectomy): 63081 (+63082 per additional vertebra) + 22554 arthrodesis
  + 22845/22846 plate + 22853 cage + 20931.

POSTERIOR INSTRUMENTED FUSION (PIF/PCDF, any region):
  arthrodesis base — cervical 22600 / thoracic 22610 / lumbar 22612
  + 22614 × each additional level
  + posterior segmental instrumentation: 22842 (3-6 vertebrae) / 22843 (7-12) / 22844 (13+)
  + 20930 AND 20936 (allograft + local autograft)
  + decompression when a lami is part of the plan: 63045 (cervical) or 63047 (lumbar)
    + 63048 × additional levels; thoracic 63046/63003 family.
  Occipitocervical fusion: 22590. C1-2 (atlantoaxial): 22595.
  "PCDF C3-7 w lami" = 22600, 22614 x3, 22842, 20930, 20936, 63045, 63048 x3.

TLIF/PLIF (posterior interbody): 22633 (combined interbody + posterolateral, first level)
  + 22634 × additional levels + 22842 + 22853 × cages + 20930 + 20936
  + 63047/63048 when decompression is described.

KYPHOPLASTY: 22513 (thoracic) / 22514 (lumbar) + 22515 × additional levels.

CRANIOTOMY add-ons (only when the words support them):
  navigation/stealth → +61781; operating microscope with microdissection → +69990;
  duraplasty is included; ICP monitor/EVD placed at same sitting → 61107/61210 separately
  only if a separate incision.

NEVER: E/M codes on operative cases; codes for things merely mentioned; a code family
swap (posterolateral vs interbody, anterior vs posterior) the surgeon didn't say.
`;
