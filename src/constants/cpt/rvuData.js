/**
 * RVU (Relative Value Unit) data for CPT codes
 * Source: CMS Physician Fee Schedule, CY 2025 Final Rule
 * wRVU = Work RVU (physician work component)
 * totalRVU = Total RVU (non-facility / office setting)
 *
 * Note: Values are based on CMS national rates. Actual reimbursement
 * varies by locality (GPCI adjustment) and payer contracts.
 * CMS Conversion Factor CY2025: $32.35
 */

export const RVU_DATA = {
  // ═══════════════════════════════════════════════════
  // CRANIOTOMY — TRAUMA (61108–61323)
  // ═══════════════════════════════════════════════════
  "61108": { wRVU: 13.18, totalRVU: 17.68 },  // Twist drill for subdural
  "61304": { wRVU: 19.52, totalRVU: 26.15 },  // Craniectomy exploratory, supratentorial
  "61305": { wRVU: 21.64, totalRVU: 28.96 },  // Craniectomy exploratory, infratentorial
  "61312": { wRVU: 22.53, totalRVU: 30.18 },  // Craniotomy evacuation hematoma, supra, extradural
  "61313": { wRVU: 24.36, totalRVU: 32.63 },  // Craniotomy evacuation hematoma, supra, subdural
  "61314": { wRVU: 24.89, totalRVU: 33.34 },  // Craniotomy evacuation hematoma, infra, extradural/subdural
  "61315": { wRVU: 28.98, totalRVU: 38.82 },  // Craniotomy evacuation hematoma, infra, intracerebral
  "61322": { wRVU: 23.41, totalRVU: 31.37 },  // Decompressive craniectomy, supratentorial
  "61323": { wRVU: 25.73, totalRVU: 34.47 },  // Decompressive craniectomy, suboccipital

  // ═══════════════════════════════════════════════════
  // CRANIOTOMY — TUMOR (61500–61530)
  // ═══════════════════════════════════════════════════
  "61500": { wRVU: 14.22, totalRVU: 19.05 },  // Trephination for subdural implant
  "61510": { wRVU: 28.63, totalRVU: 38.35 },  // Craniotomy tumor, supratentorial except meningioma
  "61518": { wRVU: 30.92, totalRVU: 41.42 },  // Craniotomy tumor, infratentorial except meningioma
  "61519": { wRVU: 33.84, totalRVU: 45.33 },  // Craniotomy tumor, infratentorial meningioma
  "61520": { wRVU: 34.14, totalRVU: 45.73 },  // Craniotomy CPA tumor
  "61521": { wRVU: 35.26, totalRVU: 47.23 },  // Craniotomy CPA tumor >4cm
  "61526": { wRVU: 35.49, totalRVU: 47.54 },  // Craniotomy excision meningioma, supratentorial
  "61530": { wRVU: 40.36, totalRVU: 54.06 },  // Craniotomy excision meningioma, skull base

  // ═══════════════════════════════════════════════════
  // CRANIOTOMY — VASCULAR (61624–61711)
  // ═══════════════════════════════════════════════════
  "61624": { wRVU: 15.00, totalRVU: 20.10 },  // Transcatheter occlusion, CNS
  "61630": { wRVU: 15.00, totalRVU: 20.10 },  // Balloon angioplasty, intracranial
  "61680": { wRVU: 30.50, totalRVU: 40.86 },  // Intracranial AVM, supratentorial simple
  "61682": { wRVU: 35.00, totalRVU: 46.88 },  // Intracranial AVM, supratentorial complex
  "61684": { wRVU: 32.50, totalRVU: 43.53 },  // Intracranial AVM, infratentorial simple
  "61686": { wRVU: 37.50, totalRVU: 50.23 },  // Intracranial AVM, infratentorial complex
  "61690": { wRVU: 33.20, totalRVU: 44.47 },  // Intracranial AVM, dural simple
  "61692": { wRVU: 37.00, totalRVU: 49.56 },  // Intracranial AVM, dural complex
  "61700": { wRVU: 33.56, totalRVU: 44.95 },  // Carotid aneurysm surgery
  "61703": { wRVU: 22.68, totalRVU: 30.38 },  // Trapping/ligation carotid
  "61705": { wRVU: 35.72, totalRVU: 47.85 },  // Aneurysm, intracranial, anterior circulation
  "61708": { wRVU: 28.17, totalRVU: 37.73 },  // EC-IC bypass
  "61710": { wRVU: 13.62, totalRVU: 18.24 },  // Trephination for epidural hemorrhage
  "61711": { wRVU: 35.49, totalRVU: 47.54 },  // Aneurysm repair, posterior circulation

  // ═══════════════════════════════════════════════════
  // SUBOCCIPITAL / POSTERIOR FOSSA (61343–61480)
  // ═══════════════════════════════════════════════════
  "61343": { wRVU: 27.86, totalRVU: 37.32 },  // Suboccipital craniectomy, Chiari decompression
  "61345": { wRVU: 16.00, totalRVU: 21.43 },  // Other cranial decompression
  "61440": { wRVU: 24.00, totalRVU: 32.15 },  // Craniotomy for section of tentorium
  "61450": { wRVU: 20.00, totalRVU: 26.79 },  // Craniectomy, subtemporal decompression
  "61458": { wRVU: 24.50, totalRVU: 32.82 },  // Suboccipital craniectomy exploration/decompression CN
  "61460": { wRVU: 26.50, totalRVU: 35.49 },  // Suboccipital craniectomy section of cranial nerves
  "61470": { wRVU: 27.00, totalRVU: 36.17 },  // Suboccipital craniectomy medullary tractotomy
  "61480": { wRVU: 28.00, totalRVU: 37.51 },  // Suboccipital craniectomy mesencephalic tractotomy

  // ═══════════════════════════════════════════════════
  // VP SHUNT / CSF (62160–62258)
  // ═══════════════════════════════════════════════════
  "62160": { wRVU: 12.38, totalRVU: 16.58 },  // Neuroendoscopy, intraventricular
  "62161": { wRVU: 14.50, totalRVU: 19.42 },  // Neuroendoscopy with dissection adhesions
  "62162": { wRVU: 17.75, totalRVU: 23.78 },  // Neuroendoscopy with fenestration
  "62180": { wRVU: 10.44, totalRVU: 13.99 },  // Ventriculocisternostomy (Torkildsen)
  "62190": { wRVU: 6.00, totalRVU: 8.04 },    // Subdural reservoir placement
  "62192": { wRVU: 7.00, totalRVU: 9.38 },    // Subdural catheter placement
  "62194": { wRVU: 3.80, totalRVU: 5.09 },    // Replacement/irrigation subdural catheter
  "62200": { wRVU: 10.63, totalRVU: 14.24 },  // Ventriculocisternostomy, third ventric
  "62201": { wRVU: 14.50, totalRVU: 19.42 },  // Ventriculocisternostomy with choroid plexectomy
  "62220": { wRVU: 10.96, totalRVU: 14.68 },  // VP shunt creation
  "62223": { wRVU: 10.50, totalRVU: 14.07 },  // VA shunt creation
  "62225": { wRVU: 9.00, totalRVU: 12.06 },   // Replacement ventricular catheter
  "62230": { wRVU: 6.61, totalRVU: 8.85 },    // Replacement/revision shunt valve/distal
  "62252": { wRVU: 3.86, totalRVU: 5.17 },    // CSF shunt reprogramming
  "62256": { wRVU: 7.75, totalRVU: 10.38 },   // Removal complete shunt system
  "62258": { wRVU: 12.50, totalRVU: 16.74 },  // Replacement CSF shunt

  // ═══════════════════════════════════════════════════
  // STEREOTACTIC / FUNCTIONAL (61720–61886)
  // ═══════════════════════════════════════════════════
  "61720": { wRVU: 14.74, totalRVU: 19.74 },  // Stereotactic procedure, aspiration
  "61735": { wRVU: 18.90, totalRVU: 25.32 },  // Subcortical stereotactic procedure
  "61750": { wRVU: 15.92, totalRVU: 21.33 },  // Stereotactic biopsy, aspiration, excision
  "61751": { wRVU: 17.00, totalRVU: 22.77 },  // Stereotactic biopsy, aspiration, excision with CT/MRI
  "61760": { wRVU: 17.50, totalRVU: 23.44 },  // Stereotactic implantation of depth electrodes
  "61770": { wRVU: 18.00, totalRVU: 24.11 },  // Stereotactic localization
  "61781": { wRVU: 3.83, totalRVU: 5.13 },    // Stereotactic navigation, cranial (add-on)
  "61782": { wRVU: 3.00, totalRVU: 4.02 },    // Stereotactic navigation, spinal (add-on)
  "61783": { wRVU: 3.00, totalRVU: 4.02 },    // Stereotactic navigation, additional (add-on)
  "61790": { wRVU: 4.50, totalRVU: 6.03 },    // Stereotactic radiosurgery planning
  "61791": { wRVU: 0.00, totalRVU: 0.00 },    // (Deleted code)
  "61796": { wRVU: 12.00, totalRVU: 16.08 },  // SRS, cranial lesion, simple
  "61797": { wRVU: 3.50, totalRVU: 4.69 },    // SRS, cranial, each additional (add-on)
  "61798": { wRVU: 5.00, totalRVU: 6.70 },    // SRS, cranial, complex
  "61799": { wRVU: 3.00, totalRVU: 4.02 },    // SRS, each additional complex (add-on)
  "61800": { wRVU: 1.80, totalRVU: 2.41 },    // Application of stereotactic headframe
  "61850": { wRVU: 4.50, totalRVU: 6.03 },    // Twist drill for cortical stimulator
  "61860": { wRVU: 12.00, totalRVU: 16.08 },  // Craniectomy for cortical electrode placement
  "61863": { wRVU: 17.50, totalRVU: 23.44 },  // Twist drill stereotactic neurostimulator
  "61864": { wRVU: 4.50, totalRVU: 6.03 },    // Additional neurostimulator array (add-on)
  "61867": { wRVU: 18.00, totalRVU: 24.11 },  // Craniotomy for neurostimulator
  "61868": { wRVU: 4.50, totalRVU: 6.03 },    // Additional neurostimulator array (add-on)
  "61880": { wRVU: 8.07, totalRVU: 10.81 },   // Revision/removal neurostimulator
  "61886": { wRVU: 5.39, totalRVU: 14.80 },   // Implant neurostimulator pulse generator

  // ═══════════════════════════════════════════════════
  // SPINAL FUSION — CERVICAL (22551–22600)
  // ═══════════════════════════════════════════════════
  "22551": { wRVU: 18.49, totalRVU: 24.77 },  // ACDF, single level
  "22552": { wRVU: 5.40, totalRVU: 7.23 },    // ACDF, each additional level (add-on)
  "22554": { wRVU: 16.17, totalRVU: 21.66 },  // Anterior cervical arthrodesis
  "22556": { wRVU: 20.28, totalRVU: 27.16 },  // Anterior thoracic arthrodesis
  "22585": { wRVU: 5.40, totalRVU: 7.23 },    // Additional anterior interspace (add-on)
  "22590": { wRVU: 20.78, totalRVU: 27.83 },  // Posterior craniocervical fusion
  "22595": { wRVU: 18.78, totalRVU: 25.15 },  // Posterior atlantoaxial fusion
  "22600": { wRVU: 18.01, totalRVU: 24.13 },  // Posterior cervical arthrodesis

  // ═══════════════════════════════════════════════════
  // SPINAL FUSION — THORACIC / LUMBAR (22533–22634)
  // ═══════════════════════════════════════════════════
  "22533": { wRVU: 18.75, totalRVU: 25.12 },  // Lateral extracavitary, lumbar
  "22534": { wRVU: 5.00, totalRVU: 6.70 },    // Lateral extracavitary, additional (add-on)
  "22558": { wRVU: 18.52, totalRVU: 24.81 },  // Anterior lumbar interbody fusion (ALIF)
  "22610": { wRVU: 19.63, totalRVU: 26.29 },  // Posterior thoracic arthrodesis
  "22612": { wRVU: 22.37, totalRVU: 29.96 },  // Posterior lumbar arthrodesis (PLF)
  "22614": { wRVU: 6.24, totalRVU: 8.36 },    // Additional posterior lumbar level (add-on)
  "22630": { wRVU: 19.42, totalRVU: 26.01 },  // Posterior lumbar interbody fusion (PLIF)
  "22632": { wRVU: 5.80, totalRVU: 7.77 },    // Additional PLIF level (add-on)
  "22633": { wRVU: 25.52, totalRVU: 34.18 },  // Combined posterior + interbody fusion (TLIF)
  "22634": { wRVU: 7.22, totalRVU: 9.67 },    // Additional TLIF level (add-on)

  // ═══════════════════════════════════════════════════
  // SPINAL INSTRUMENTATION (22840–22853)
  // ═══════════════════════════════════════════════════
  "22840": { wRVU: 10.44, totalRVU: 13.99 },  // Posterior non-segmental instrumentation
  "22841": { wRVU: 3.60, totalRVU: 4.82 },    // Internal spinal fixation by wiring
  "22842": { wRVU: 12.80, totalRVU: 17.14 },  // Posterior segmental instrumentation 3-6
  "22843": { wRVU: 15.30, totalRVU: 20.50 },  // Posterior segmental instrumentation 7-12
  "22844": { wRVU: 17.50, totalRVU: 23.44 },  // Posterior segmental instrumentation 13+
  "22845": { wRVU: 10.80, totalRVU: 14.47 },  // Anterior instrumentation 2-3
  "22846": { wRVU: 13.32, totalRVU: 17.84 },  // Anterior instrumentation 4-7
  "22847": { wRVU: 15.80, totalRVU: 21.17 },  // Anterior instrumentation 8+
  "22848": { wRVU: 6.00, totalRVU: 8.04 },    // Pelvic fixation (add-on)
  "22849": { wRVU: 6.28, totalRVU: 8.41 },    // Reinsertion of spinal fixation device
  "22850": { wRVU: 8.13, totalRVU: 10.89 },   // Removal posterior non-segmental instrumentation
  "22852": { wRVU: 10.80, totalRVU: 14.47 },  // Removal posterior segmental instrumentation
  "22853": { wRVU: 4.60, totalRVU: 6.16 },    // Intervertebral biomechanical device (add-on)

  // ═══════════════════════════════════════════════════
  // SPINAL DECOMPRESSION (63001–63051)
  // ═══════════════════════════════════════════════════
  "63001": { wRVU: 16.05, totalRVU: 21.49 },  // Laminectomy, cervical, 1 segment
  "63003": { wRVU: 16.56, totalRVU: 22.18 },  // Laminectomy, thoracic, 1 segment
  "63005": { wRVU: 14.21, totalRVU: 19.04 },  // Laminectomy, lumbar, 1 segment
  "63011": { wRVU: 15.50, totalRVU: 20.76 },  // Laminectomy, sacral, 1 segment
  "63012": { wRVU: 4.00, totalRVU: 5.36 },    // Additional laminectomy segment (add-on)
  "63015": { wRVU: 19.50, totalRVU: 26.12 },  // Laminectomy with facetectomy, cervical
  "63016": { wRVU: 17.50, totalRVU: 23.44 },  // Laminectomy with facetectomy, thoracic
  "63017": { wRVU: 16.50, totalRVU: 22.10 },  // Laminectomy with facetectomy, lumbar
  "63020": { wRVU: 15.50, totalRVU: 20.76 },  // Cervical laminotomy (foraminotomy)
  "63030": { wRVU: 11.74, totalRVU: 15.73 },  // Lumbar laminotomy, discectomy, single
  "63035": { wRVU: 3.52, totalRVU: 4.72 },    // Additional laminotomy level (add-on)
  "63040": { wRVU: 15.73, totalRVU: 21.08 },  // Laminotomy with disc, re-explore cervical
  "63042": { wRVU: 14.50, totalRVU: 19.42 },  // Laminotomy with disc, re-explore lumbar
  "63045": { wRVU: 15.12, totalRVU: 20.25 },  // Laminectomy facetectomy foraminotomy, cervical
  "63046": { wRVU: 14.73, totalRVU: 19.73 },  // Laminectomy facetectomy foraminotomy, thoracic
  "63047": { wRVU: 13.18, totalRVU: 17.65 },  // Laminectomy facetectomy foraminotomy, lumbar
  "63048": { wRVU: 3.30, totalRVU: 4.42 },    // Additional level (add-on)
  "63050": { wRVU: 16.00, totalRVU: 21.43 },  // Cervical laminoplasty, 2+ segments
  "63051": { wRVU: 4.00, totalRVU: 5.36 },    // Additional laminoplasty segment (add-on)

  // ═══════════════════════════════════════════════════
  // DISC ARTHROPLASTY (22856–22857)
  // ═══════════════════════════════════════════════════
  "22856": { wRVU: 20.00, totalRVU: 26.79 },  // Cervical disc arthroplasty, single
  "22857": { wRVU: 5.50, totalRVU: 7.37 },    // Additional cervical arthroplasty (add-on)

  // ═══════════════════════════════════════════════════
  // PERIPHERAL NERVE — BLOCKS (64400–64495)
  // ═══════════════════════════════════════════════════
  "64400": { wRVU: 1.27, totalRVU: 2.35 },    // Trigeminal nerve block
  "64405": { wRVU: 1.16, totalRVU: 2.54 },    // Greater occipital nerve block
  "64408": { wRVU: 1.10, totalRVU: 2.42 },    // Vagus nerve block
  "64415": { wRVU: 1.48, totalRVU: 3.20 },    // Brachial plexus block, single
  "64416": { wRVU: 1.75, totalRVU: 3.81 },    // Brachial plexus block, continuous
  "64417": { wRVU: 1.48, totalRVU: 3.22 },    // Axillary nerve block
  "64418": { wRVU: 1.16, totalRVU: 2.53 },    // Suprascapular nerve block
  "64420": { wRVU: 1.27, totalRVU: 2.87 },    // Intercostal nerve block, single
  "64421": { wRVU: 1.75, totalRVU: 3.86 },    // Intercostal nerve block, multiple
  "64425": { wRVU: 1.27, totalRVU: 2.83 },    // Ilio-inguinal/iliohypogastric block
  "64430": { wRVU: 1.16, totalRVU: 2.53 },    // Pudendal nerve block
  "64435": { wRVU: 1.25, totalRVU: 2.75 },    // Paracervical block
  "64445": { wRVU: 1.48, totalRVU: 3.22 },    // Sciatic nerve block, single
  "64446": { wRVU: 1.75, totalRVU: 3.81 },    // Sciatic nerve block, continuous
  "64447": { wRVU: 1.48, totalRVU: 3.22 },    // Femoral nerve block, single
  "64448": { wRVU: 1.75, totalRVU: 3.81 },    // Femoral nerve block, continuous
  "64449": { wRVU: 1.75, totalRVU: 3.81 },    // Lumbar plexus block, continuous
  "64450": { wRVU: 0.94, totalRVU: 1.93 },    // Other peripheral nerve block
  "64461": { wRVU: 1.75, totalRVU: 3.80 },    // Paravertebral block, thoracic, single
  "64463": { wRVU: 2.00, totalRVU: 4.30 },    // Paravertebral block, thoracic, continuous
  "64479": { wRVU: 1.90, totalRVU: 5.47 },    // Cervical transforaminal epidural, single
  "64480": { wRVU: 1.20, totalRVU: 2.81 },    // Cervical transforaminal, additional (add-on)
  "64483": { wRVU: 1.90, totalRVU: 5.28 },    // Lumbar transforaminal epidural, single
  "64484": { wRVU: 1.20, totalRVU: 2.68 },    // Lumbar transforaminal, additional (add-on)
  "64490": { wRVU: 1.65, totalRVU: 4.58 },    // Cervical facet joint injection, single
  "64491": { wRVU: 0.95, totalRVU: 2.20 },    // Cervical facet joint, 2nd level (add-on)
  "64492": { wRVU: 0.95, totalRVU: 2.08 },    // Cervical facet joint, 3rd+ level (add-on)
  "64493": { wRVU: 1.52, totalRVU: 4.12 },    // Lumbar facet joint injection, single
  "64494": { wRVU: 0.86, totalRVU: 1.91 },    // Lumbar facet joint, 2nd level (add-on)
  "64495": { wRVU: 0.86, totalRVU: 1.80 },    // Lumbar facet joint, 3rd+ level (add-on)

  // ═══════════════════════════════════════════════════
  // PERIPHERAL NERVE — NEUROSTIMULATORS (64553–64595)
  // ═══════════════════════════════════════════════════
  "64553": { wRVU: 3.50, totalRVU: 8.50 },    // Percutaneous neurostimulator electrode, cranial
  "64555": { wRVU: 3.50, totalRVU: 8.26 },    // Percutaneous neurostimulator electrode, peripheral
  "64561": { wRVU: 3.50, totalRVU: 8.42 },    // Percutaneous neurostimulator electrode, sacral
  "64568": { wRVU: 5.00, totalRVU: 11.50 },   // Vagus nerve stimulator implant
  "64569": { wRVU: 3.00, totalRVU: 7.86 },    // VNS revision/replacement
  "64570": { wRVU: 3.50, totalRVU: 6.89 },    // VNS removal
  "64575": { wRVU: 5.50, totalRVU: 9.21 },    // Incision neurostimulator electrode, peripheral
  "64580": { wRVU: 6.00, totalRVU: 9.86 },    // Incision neurostimulator electrode, neuromuscular
  "64581": { wRVU: 6.00, totalRVU: 9.86 },    // Incision neurostimulator electrode, sacral
  "64585": { wRVU: 4.00, totalRVU: 6.50 },    // Revision neurostimulator electrode
  "64590": { wRVU: 3.48, totalRVU: 9.54 },    // Insertion neurostimulator pulse generator
  "64595": { wRVU: 3.48, totalRVU: 5.85 },    // Revision/removal neurostimulator pulse generator

  // ═══════════════════════════════════════════════════
  // PERIPHERAL NERVE — DESTRUCTION (64600–64681)
  // ═══════════════════════════════════════════════════
  "64600": { wRVU: 2.79, totalRVU: 5.79 },    // Destruction trigeminal, supraorbital
  "64605": { wRVU: 3.30, totalRVU: 6.40 },    // Destruction trigeminal, infraorbital
  "64610": { wRVU: 4.50, totalRVU: 8.30 },    // Destruction trigeminal, foramen ovale
  "64612": { wRVU: 1.63, totalRVU: 3.58 },    // Chemodenervation, muscle(s), neck
  "64615": { wRVU: 2.40, totalRVU: 4.81 },    // Chemodenervation, migraine
  "64616": { wRVU: 1.63, totalRVU: 3.60 },    // Chemodenervation, neck muscles, cervical dystonia
  "64617": { wRVU: 2.30, totalRVU: 4.55 },    // Chemodenervation, larynx
  "64620": { wRVU: 2.00, totalRVU: 4.39 },    // Destruction intercostal nerve
  "64624": { wRVU: 2.50, totalRVU: 6.82 },    // Destruction genicular nerve branches, RF
  "64625": { wRVU: 1.50, totalRVU: 3.40 },    // Additional genicular destruction (add-on)
  "64630": { wRVU: 2.23, totalRVU: 4.63 },    // Destruction pudendal nerve
  "64633": { wRVU: 3.60, totalRVU: 8.87 },    // Destruction cervical facet, single
  "64634": { wRVU: 1.50, totalRVU: 3.44 },    // Destruction cervical facet, additional (add-on)
  "64635": { wRVU: 3.60, totalRVU: 8.56 },    // Destruction lumbar facet, single
  "64636": { wRVU: 1.50, totalRVU: 3.30 },    // Destruction lumbar facet, additional (add-on)
  "64640": { wRVU: 2.38, totalRVU: 4.72 },    // Destruction other peripheral nerve
  "64642": { wRVU: 2.00, totalRVU: 3.80 },    // Chemodenervation, one extremity, 1-4 muscles
  "64643": { wRVU: 2.50, totalRVU: 4.70 },    // Chemodenervation, one extremity, each additional
  "64644": { wRVU: 2.50, totalRVU: 4.61 },    // Chemodenervation, trunk, 1-5 muscles
  "64645": { wRVU: 3.00, totalRVU: 5.30 },    // Chemodenervation, trunk, 6+ muscles
  "64646": { wRVU: 2.00, totalRVU: 3.80 },    // Chemodenervation, trunk, each additional
  "64647": { wRVU: 2.50, totalRVU: 4.70 },    // Chemodenervation, each additional extremity
  "64650": { wRVU: 1.73, totalRVU: 3.64 },    // Chemodenervation, eccrine glands, both axillae
  "64653": { wRVU: 1.73, totalRVU: 3.64 },    // Chemodenervation, eccrine glands, other areas
  "64680": { wRVU: 2.40, totalRVU: 5.20 },    // Destruction celiac plexus
  "64681": { wRVU: 2.80, totalRVU: 5.90 },    // Destruction superior hypogastric plexus

  // ═══════════════════════════════════════════════════
  // PERIPHERAL NERVE — SURGERY (64702–64891)
  // ═══════════════════════════════════════════════════
  "64702": { wRVU: 7.32, totalRVU: 12.30 },   // Neurolysis, digital nerve
  "64704": { wRVU: 7.41, totalRVU: 12.50 },   // Neurolysis, nerve of hand/foot
  "64708": { wRVU: 9.19, totalRVU: 14.67 },   // Neurolysis, major peripheral nerve, arm
  "64712": { wRVU: 10.80, totalRVU: 16.74 },  // Neurolysis, sciatic nerve
  "64713": { wRVU: 10.80, totalRVU: 16.74 },  // Neurolysis, brachial plexus
  "64714": { wRVU: 10.14, totalRVU: 15.91 },  // Neurolysis, lumbar plexus
  "64716": { wRVU: 8.43, totalRVU: 13.52 },   // Neurolysis, cranial nerve
  "64718": { wRVU: 8.42, totalRVU: 13.81 },   // Neurolysis, ulnar nerve at elbow
  "64719": { wRVU: 7.33, totalRVU: 12.42 },   // Neurolysis, ulnar nerve at wrist
  "64721": { wRVU: 7.08, totalRVU: 11.67 },   // Carpal tunnel release
  "64722": { wRVU: 6.38, totalRVU: 10.37 },   // Decompression unspecified nerve
  "64726": { wRVU: 4.75, totalRVU: 8.02 },    // Decompression plantar digital nerve
  "64727": { wRVU: 2.53, totalRVU: 3.39 },    // Internal neurolysis, add-on
  "64732": { wRVU: 5.22, totalRVU: 8.72 },    // Transection/avulsion supraorbital nerve
  "64734": { wRVU: 5.58, totalRVU: 9.32 },    // Transection/avulsion infraorbital nerve
  "64736": { wRVU: 6.34, totalRVU: 10.58 },   // Transection/avulsion mental nerve
  "64738": { wRVU: 7.66, totalRVU: 12.43 },   // Transection/avulsion inferior alveolar nerve
  "64740": { wRVU: 7.66, totalRVU: 12.43 },   // Transection/avulsion lingual nerve
  "64742": { wRVU: 8.37, totalRVU: 13.48 },   // Transection/avulsion facial nerve
  "64744": { wRVU: 9.58, totalRVU: 15.15 },   // Transection/avulsion greater occipital nerve
  "64746": { wRVU: 8.04, totalRVU: 13.02 },   // Transection/avulsion phrenic nerve
  "64755": { wRVU: 7.18, totalRVU: 11.88 },   // Transection vagus nerve, cervical
  "64760": { wRVU: 8.72, totalRVU: 14.02 },   // Transection vagus nerve, thoracic
  "64763": { wRVU: 5.47, totalRVU: 9.05 },    // Transection obturator nerve
  "64766": { wRVU: 7.60, totalRVU: 12.32 },   // Transection sciatic nerve
  "64771": { wRVU: 6.50, totalRVU: 10.73 },   // Transection other cranial nerve
  "64772": { wRVU: 7.60, totalRVU: 12.32 },   // Transection other spinal nerve
  "64774": { wRVU: 4.97, totalRVU: 8.40 },    // Excision neuroma, cutaneous
  "64776": { wRVU: 7.04, totalRVU: 11.76 },   // Excision neuroma, digital
  "64778": { wRVU: 3.08, totalRVU: 4.13 },    // Excision neuroma, additional digital (add-on)
  "64782": { wRVU: 7.80, totalRVU: 12.95 },   // Excision neuroma, hand/foot
  "64783": { wRVU: 3.08, totalRVU: 4.13 },    // Excision neuroma, additional (add-on)
  "64784": { wRVU: 9.89, totalRVU: 16.00 },   // Excision neuroma, major peripheral nerve
  "64786": { wRVU: 11.51, totalRVU: 18.16 },  // Excision neuroma, sciatic
  "64788": { wRVU: 5.04, totalRVU: 8.40 },    // Excision neurofibroma, cutaneous
  "64790": { wRVU: 9.72, totalRVU: 15.77 },   // Excision neurofibroma, major peripheral nerve
  "64792": { wRVU: 12.72, totalRVU: 20.02 },  // Excision neurilemmoma, major peripheral nerve
  "64795": { wRVU: 2.33, totalRVU: 3.98 },    // Nerve biopsy
  "64802": { wRVU: 4.55, totalRVU: 7.62 },    // Sympathectomy, digital arteries
  "64804": { wRVU: 9.54, totalRVU: 15.47 },   // Sympathectomy, radial artery
  "64809": { wRVU: 10.00, totalRVU: 16.21 },  // Sympathectomy, thoracolumbar
  "64818": { wRVU: 10.94, totalRVU: 17.45 },  // Sympathectomy, lumbar
  "64820": { wRVU: 8.40, totalRVU: 13.68 },   // Digital nerve repair
  "64821": { wRVU: 10.50, totalRVU: 16.76 },  // Median nerve repair, hand
  "64822": { wRVU: 10.50, totalRVU: 16.76 },  // Ulnar nerve repair, hand
  "64823": { wRVU: 10.50, totalRVU: 16.76 },  // Sensory nerve repair, hand
  "64831": { wRVU: 10.57, totalRVU: 16.85 },  // Digital nerve repair, hand (using graft)
  "64832": { wRVU: 4.55, totalRVU: 6.10 },    // Additional digital nerve repair (add-on)
  "64834": { wRVU: 12.50, totalRVU: 19.59 },  // Nerve repair, hand common sensory
  "64835": { wRVU: 12.50, totalRVU: 19.59 },  // Median motor nerve repair, hand
  "64836": { wRVU: 12.50, totalRVU: 19.59 },  // Ulnar motor nerve repair, hand
  "64837": { wRVU: 4.55, totalRVU: 6.10 },    // Additional nerve repair (add-on)
  "64840": { wRVU: 12.50, totalRVU: 19.59 },  // Nerve repair, posterior tibial
  "64856": { wRVU: 12.56, totalRVU: 19.69 },  // Nerve repair, major peripheral nerve, arm
  "64857": { wRVU: 12.56, totalRVU: 19.69 },  // Nerve repair, major peripheral nerve, leg
  "64858": { wRVU: 13.43, totalRVU: 20.84 },  // Nerve repair, sciatic
  "64859": { wRVU: 3.35, totalRVU: 4.49 },    // Additional nerve repair (add-on)
  "64861": { wRVU: 17.25, totalRVU: 26.09 },  // Nerve repair, brachial plexus, open
  "64862": { wRVU: 15.25, totalRVU: 23.28 },  // Nerve repair, lumbar plexus, open
  "64864": { wRVU: 12.50, totalRVU: 19.59 },  // Nerve repair, facial nerve, suture
  "64865": { wRVU: 17.50, totalRVU: 26.42 },  // Nerve repair, facial nerve graft
  "64866": { wRVU: 14.88, totalRVU: 22.72 },  // Facial nerve repair, anastomosis
  "64868": { wRVU: 15.74, totalRVU: 23.87 },  // Facial nerve repair, anastomosis complex
  "64872": { wRVU: 11.97, totalRVU: 18.70 },  // Nerve repair, posterior approach
  "64874": { wRVU: 12.50, totalRVU: 19.59 },  // Nerve repair, conduit, <5cm
  "64876": { wRVU: 13.50, totalRVU: 21.10 },  // Nerve repair, conduit, >=5cm
  "64885": { wRVU: 14.50, totalRVU: 22.46 },  // Nerve graft, head or neck, <=4cm
  "64886": { wRVU: 16.50, totalRVU: 25.32 },  // Nerve graft, head or neck, >4cm
  "64890": { wRVU: 14.50, totalRVU: 22.46 },  // Nerve graft, single strand, <=4cm
  "64891": { wRVU: 16.50, totalRVU: 25.32 },  // Nerve graft, single strand, >4cm

  // ═══════════════════════════════════════════════════
  // E/M CODES
  // ═══════════════════════════════════════════════════
  "99202": { wRVU: 0.93, totalRVU: 1.80 },
  "99203": { wRVU: 1.60, totalRVU: 3.13 },
  "99204": { wRVU: 2.60, totalRVU: 5.07 },
  "99205": { wRVU: 3.50, totalRVU: 6.87 },
  "99211": { wRVU: 0.18, totalRVU: 0.56 },
  "99212": { wRVU: 0.70, totalRVU: 1.48 },
  "99213": { wRVU: 1.30, totalRVU: 2.68 },
  "99214": { wRVU: 1.92, totalRVU: 3.97 },
  "99215": { wRVU: 2.80, totalRVU: 5.67 },
  "99221": { wRVU: 2.06, totalRVU: 3.24 },
  "99222": { wRVU: 2.78, totalRVU: 4.26 },
  "99223": { wRVU: 3.86, totalRVU: 5.83 },
  "99231": { wRVU: 0.76, totalRVU: 1.24 },
  "99232": { wRVU: 1.39, totalRVU: 2.16 },
  "99233": { wRVU: 2.00, totalRVU: 3.03 },
  "99238": { wRVU: 1.28, totalRVU: 2.04 },
  "99239": { wRVU: 1.90, totalRVU: 2.96 },
  "99281": { wRVU: 0.25, totalRVU: 0.73 },
  "99282": { wRVU: 0.65, totalRVU: 1.46 },
  "99283": { wRVU: 1.30, totalRVU: 2.52 },
  "99284": { wRVU: 2.56, totalRVU: 4.42 },
  "99285": { wRVU: 4.15, totalRVU: 9.72 },
  "99291": { wRVU: 4.50, totalRVU: 6.87 },
  "99292": { wRVU: 2.25, totalRVU: 3.16 },
  "99304": { wRVU: 1.50, totalRVU: 2.84 },
  "99305": { wRVU: 2.36, totalRVU: 4.01 },
  "99306": { wRVU: 3.06, totalRVU: 5.02 },
  "99307": { wRVU: 0.66, totalRVU: 1.26 },
  "99308": { wRVU: 1.15, totalRVU: 1.95 },
  "99309": { wRVU: 1.60, totalRVU: 2.57 },
  "99310": { wRVU: 2.35, totalRVU: 3.65 },
  "99341": { wRVU: 1.28, totalRVU: 2.44 },
  "99342": { wRVU: 2.36, totalRVU: 4.01 },
  "99344": { wRVU: 3.35, totalRVU: 5.22 },
  "99345": { wRVU: 4.22, totalRVU: 6.40 },
  "99347": { wRVU: 1.28, totalRVU: 2.23 },
  "99348": { wRVU: 2.06, totalRVU: 3.30 },
  "99349": { wRVU: 2.78, totalRVU: 4.24 },
  "99350": { wRVU: 3.59, totalRVU: 5.30 },
  "99381": { wRVU: 1.50, totalRVU: 2.93 },
  "99382": { wRVU: 1.50, totalRVU: 3.00 },
  "99383": { wRVU: 1.50, totalRVU: 2.98 },
  "99384": { wRVU: 1.80, totalRVU: 3.48 },
  "99385": { wRVU: 1.80, totalRVU: 3.48 },
  "99386": { wRVU: 2.00, totalRVU: 3.80 },
  "99387": { wRVU: 2.20, totalRVU: 4.08 },
  "99391": { wRVU: 1.20, totalRVU: 2.39 },
  "99392": { wRVU: 1.20, totalRVU: 2.45 },
  "99393": { wRVU: 1.20, totalRVU: 2.43 },
  "99394": { wRVU: 1.50, totalRVU: 2.91 },
  "99395": { wRVU: 1.50, totalRVU: 2.91 },
  "99396": { wRVU: 1.70, totalRVU: 3.23 },
  "99397": { wRVU: 1.90, totalRVU: 3.53 },
  "99406": { wRVU: 0.24, totalRVU: 0.50 },
  "99407": { wRVU: 0.50, totalRVU: 0.84 },
  "99408": { wRVU: 0.85, totalRVU: 1.38 },
  "99409": { wRVU: 1.50, totalRVU: 2.30 },
  "99455": { wRVU: 2.00, totalRVU: 3.38 },
  "99456": { wRVU: 2.65, totalRVU: 4.30 },
  "99483": { wRVU: 3.44, totalRVU: 5.56 },
  "99484": { wRVU: 0.61, totalRVU: 1.07 },
  "99490": { wRVU: 0.61, totalRVU: 1.32 },
  "99491": { wRVU: 1.36, totalRVU: 2.43 },
  "99492": { wRVU: 1.79, totalRVU: 2.86 },
  "99493": { wRVU: 1.28, totalRVU: 2.12 },
  "99494": { wRVU: 0.81, totalRVU: 1.31 },
  "99495": { wRVU: 2.78, totalRVU: 4.80 },
  "99496": { wRVU: 3.79, totalRVU: 6.23 },

  // ═══════════════════════════════════════════════════
  // OTHER CMS BASE CODES
  // ═══════════════════════════════════════════════════
  // Anesthesia
  "00100": { wRVU: 5.00, totalRVU: 6.36 },
  "00400": { wRVU: 3.00, totalRVU: 4.68 },
  "00520": { wRVU: 6.00, totalRVU: 7.86 },
  "00530": { wRVU: 5.00, totalRVU: 6.56 },
  "00600": { wRVU: 7.00, totalRVU: 9.18 },
  "00670": { wRVU: 10.00, totalRVU: 12.36 },
  "01996": { wRVU: 1.58, totalRVU: 2.12 },
  // Integumentary
  "10060": { wRVU: 1.22, totalRVU: 2.98 },
  "10061": { wRVU: 2.45, totalRVU: 5.40 },
  "10120": { wRVU: 1.41, totalRVU: 3.20 },
  "10121": { wRVU: 2.48, totalRVU: 5.45 },
  "10140": { wRVU: 1.88, totalRVU: 3.95 },
  "10160": { wRVU: 0.86, totalRVU: 1.99 },
  "11042": { wRVU: 1.61, totalRVU: 3.58 },
  "11043": { wRVU: 2.60, totalRVU: 5.40 },
  "11044": { wRVU: 3.72, totalRVU: 7.32 },
  "11102": { wRVU: 0.72, totalRVU: 2.12 },
  "11104": { wRVU: 0.40, totalRVU: 1.21 },
  "11402": { wRVU: 2.49, totalRVU: 6.06 },
  "11406": { wRVU: 3.67, totalRVU: 8.56 },
  "11602": { wRVU: 2.79, totalRVU: 6.55 },
  "11606": { wRVU: 4.33, totalRVU: 9.83 },
  "12001": { wRVU: 1.42, totalRVU: 3.17 },
  "12002": { wRVU: 1.72, totalRVU: 3.72 },
  "12004": { wRVU: 2.31, totalRVU: 4.78 },
  "12011": { wRVU: 1.87, totalRVU: 3.96 },
  "12013": { wRVU: 2.31, totalRVU: 4.75 },
  "12031": { wRVU: 2.38, totalRVU: 4.96 },
  "12032": { wRVU: 2.86, totalRVU: 5.82 },
  "12034": { wRVU: 3.29, totalRVU: 6.60 },
  "13100": { wRVU: 3.05, totalRVU: 6.30 },
  "13131": { wRVU: 3.36, totalRVU: 6.84 },
  // Musculoskeletal
  "20200": { wRVU: 1.26, totalRVU: 2.92 },
  "20205": { wRVU: 2.31, totalRVU: 4.85 },
  "20220": { wRVU: 1.84, totalRVU: 3.98 },
  "20225": { wRVU: 2.73, totalRVU: 5.60 },
  "20240": { wRVU: 2.68, totalRVU: 5.50 },
  "20245": { wRVU: 3.62, totalRVU: 7.10 },
  "20526": { wRVU: 0.94, totalRVU: 2.88 },
  "20550": { wRVU: 0.75, totalRVU: 1.74 },
  "20551": { wRVU: 0.80, totalRVU: 1.82 },
  "20552": { wRVU: 0.75, totalRVU: 1.42 },
  "20553": { wRVU: 0.85, totalRVU: 1.55 },
  "20600": { wRVU: 0.60, totalRVU: 1.40 },
  "20604": { wRVU: 0.74, totalRVU: 2.16 },
  "20605": { wRVU: 0.66, totalRVU: 1.52 },
  "20610": { wRVU: 0.79, totalRVU: 1.72 },
  "20611": { wRVU: 0.93, totalRVU: 2.68 },
  "27130": { wRVU: 20.72, totalRVU: 54.07 },
  "27447": { wRVU: 21.09, totalRVU: 52.41 },
  "29881": { wRVU: 8.16, totalRVU: 22.39 },
  "29888": { wRVU: 13.50, totalRVU: 35.68 },
  // Respiratory / Cardiovascular
  "31231": { wRVU: 1.10, totalRVU: 3.62 },
  "31237": { wRVU: 2.47, totalRVU: 6.21 },
  "31267": { wRVU: 4.90, totalRVU: 10.47 },
  "31276": { wRVU: 4.65, totalRVU: 10.01 },
  "32551": { wRVU: 3.09, totalRVU: 6.60 },
  "32553": { wRVU: 2.68, totalRVU: 5.55 },
  "33208": { wRVU: 8.25, totalRVU: 20.42 },
  "33249": { wRVU: 13.01, totalRVU: 31.56 },
  "36556": { wRVU: 2.50, totalRVU: 5.40 },
  "36620": { wRVU: 1.07, totalRVU: 2.38 },
  // Digestive
  "43235": { wRVU: 2.12, totalRVU: 6.62 },
  "43239": { wRVU: 2.43, totalRVU: 7.77 },
  "44970": { wRVU: 10.45, totalRVU: 27.80 },
  "45378": { wRVU: 4.43, totalRVU: 12.78 },
  "45380": { wRVU: 4.95, totalRVU: 13.74 },
  "47562": { wRVU: 10.42, totalRVU: 27.18 },
  "47563": { wRVU: 12.15, totalRVU: 31.16 },
  "49505": { wRVU: 9.37, totalRVU: 24.25 },
  "49507": { wRVU: 10.00, totalRVU: 25.60 },
  "49650": { wRVU: 9.50, totalRVU: 24.50 },
  // Urinary / Genital
  "50060": { wRVU: 14.50, totalRVU: 35.25 },
  "51102": { wRVU: 2.10, totalRVU: 4.70 },
  "52000": { wRVU: 2.24, totalRVU: 6.27 },
  "52310": { wRVU: 3.80, totalRVU: 9.40 },
  "52601": { wRVU: 15.26, totalRVU: 36.52 },
  "55700": { wRVU: 1.89, totalRVU: 5.44 },
  "55866": { wRVU: 22.76, totalRVU: 49.55 },
  "58150": { wRVU: 17.89, totalRVU: 42.35 },
  "58262": { wRVU: 15.44, totalRVU: 38.40 },
  "58571": { wRVU: 18.72, totalRVU: 41.65 },
  "58661": { wRVU: 8.86, totalRVU: 23.10 },
  "59400": { wRVU: 19.60, totalRVU: 37.28 },
  "59510": { wRVU: 20.15, totalRVU: 39.60 },
  "59610": { wRVU: 21.00, totalRVU: 39.10 },
  // Radiology
  "70336": { wRVU: 1.13, totalRVU: 9.56 },
  "70450": { wRVU: 0.87, totalRVU: 6.22 },
  "70551": { wRVU: 1.18, totalRVU: 10.10 },
  "70553": { wRVU: 1.48, totalRVU: 13.88 },
  "71045": { wRVU: 0.22, totalRVU: 1.11 },
  "71046": { wRVU: 0.28, totalRVU: 1.24 },
  "71250": { wRVU: 1.24, totalRVU: 8.12 },
  "71260": { wRVU: 1.38, totalRVU: 9.72 },
  "72141": { wRVU: 1.13, totalRVU: 9.36 },
  "72148": { wRVU: 1.13, totalRVU: 9.36 },
  "72156": { wRVU: 1.41, totalRVU: 13.04 },
  "72158": { wRVU: 1.41, totalRVU: 13.04 },
  "73221": { wRVU: 1.13, totalRVU: 9.42 },
  "73721": { wRVU: 1.04, totalRVU: 9.27 },
  "74177": { wRVU: 1.74, totalRVU: 12.20 },
  "76512": { wRVU: 0.55, totalRVU: 1.98 },
  "76536": { wRVU: 0.56, totalRVU: 3.44 },
  "76700": { wRVU: 0.81, totalRVU: 4.88 },
  "76942": { wRVU: 0.54, totalRVU: 2.70 },
  "77002": { wRVU: 0.52, totalRVU: 2.40 },
  "77386": { wRVU: 0.00, totalRVU: 7.25 },
  // Pathology / Lab
  "80048": { wRVU: 0.00, totalRVU: 0.95 },
  "80050": { wRVU: 0.00, totalRVU: 1.20 },
  "80053": { wRVU: 0.00, totalRVU: 1.24 },
  "80061": { wRVU: 0.00, totalRVU: 0.78 },
  "81001": { wRVU: 0.00, totalRVU: 0.20 },
  "85025": { wRVU: 0.00, totalRVU: 0.90 },
  "85610": { wRVU: 0.00, totalRVU: 0.33 },
  "85730": { wRVU: 0.00, totalRVU: 0.33 },
  "87070": { wRVU: 0.00, totalRVU: 0.55 },
  "87086": { wRVU: 0.00, totalRVU: 0.42 },
  "88305": { wRVU: 0.75, totalRVU: 2.02 },
  "88342": { wRVU: 0.58, totalRVU: 1.55 },
  // Medicine
  "90471": { wRVU: 0.17, totalRVU: 0.67 },
  "90472": { wRVU: 0.15, totalRVU: 0.40 },
  "90791": { wRVU: 2.43, totalRVU: 3.68 },
  "90832": { wRVU: 0.98, totalRVU: 1.64 },
  "90834": { wRVU: 1.52, totalRVU: 2.47 },
  "90837": { wRVU: 2.13, totalRVU: 3.36 },
  "92004": { wRVU: 1.50, totalRVU: 3.49 },
  "92012": { wRVU: 0.92, totalRVU: 2.24 },
  "92014": { wRVU: 1.18, totalRVU: 2.76 },
  "93000": { wRVU: 0.17, totalRVU: 0.70 },
  "93005": { wRVU: 0.00, totalRVU: 0.38 },
  "93010": { wRVU: 0.17, totalRVU: 0.32 },
  "93015": { wRVU: 0.75, totalRVU: 2.95 },
  "93306": { wRVU: 1.45, totalRVU: 6.41 },
  "93454": { wRVU: 5.20, totalRVU: 20.80 },
  "95004": { wRVU: 0.02, totalRVU: 0.07 },
  "95819": { wRVU: 1.39, totalRVU: 5.62 },
  "95886": { wRVU: 1.11, totalRVU: 2.28 },
  "96372": { wRVU: 0.17, totalRVU: 0.60 },
  "96375": { wRVU: 0.00, totalRVU: 0.29 },
  "97110": { wRVU: 0.45, totalRVU: 1.36 },
  "97112": { wRVU: 0.48, totalRVU: 1.42 },
  "97140": { wRVU: 0.43, totalRVU: 1.30 },
  "97530": { wRVU: 0.44, totalRVU: 1.28 },
  "97542": { wRVU: 0.44, totalRVU: 1.16 },
};
