# CME dashboard clarification — September 20, 2026

## Problem and resulting behavior

The California card could show 130.5/50 total hours and a warning because total hours, required topics and unanswered applicability questions are different checks. Two zero-hour California rows also caused misleading personal shortfalls: implicit bias is course/provider guidance, while geriatrics applies only to a defined practice and patient population.

This change:

- Keeps California implicit-bias guidance visible and sourced, outside personal completed/missing topic counts. It never marks that provider duty completed or exempt.
- Asks the physician whether they are a general internist or family physician **and** strictly more than 25% of their patients are aged 65 or older. Unknown remains confirmation needed; it is neither a deficit nor an exemption. An explicit answer is saved in the existing selected license's custom fields.
- Tracks an applicable 10-hour geriatrics target for both California MD and DO, using each board's source. For MD this is 20% of the mandatory 50-hour total; logging extra hours does not increase the target. Existing cycle dates and accepted credit-category representations still apply. Tags do not verify actual course content or board acceptance.
- Separates `CME records to review`, `CME confirmation needed`, and `Credential dates current` in both dashboard layouts. Total hours are labeled `Total logged`; required-topic and one-time-training figures describe recorded evidence.
- Prevents an unknown MD/DO selection from receiving a completed verdict under the MD fallback. Existing fallback calculations remain visible and labeled provisional.
- Gives Vera the provider-guidance classification and retains the DO rule's effective date in its reference evidence.

## Primary sources

Reviewed September 20, 2026. These references support this bounded change; they do not establish every rule or course in the application.

- [Medical Board of California CME guidance](https://www.mbc.ca.gov/Licensing/Physicians-and-Surgeons/Renew/Current-Status/Continuing-Medical-Education.aspx): 50-hour biennial total; conditional geriatrics at 20% of mandatory CME; geriatric medicine, care of older patients and dementia care are the described subject areas.
- [California BPC2190.1(d)](https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?lawCode=BPC&sectionNum=2190.1): implicit-bias curriculum and accreditor duties, including the specified course/provider exceptions. It does not establish a separate physician hour target; no blanket audit-document exemption is claimed here.
- [16CCR1635(e)(3)](https://govt.westlaw.com/calregs/Document/I4500CE10638B11F0ADE8DF244CB90544?contextData=%28sc.Default%29&originationContext=documenttoc&transitionType=CategoryPageItem&viewType=FullText): conditional 10-hour requirement for qualifying osteopathic physicians. [OMBC approved regulations](https://www.ombc.ca.gov/laws_regulations/approved_regulations.shtml) identifies the amendment effective October1,2025. Independent reviewer retrieved the full current regulation through the official regulations source; direct fetches sometimes return403.
- [OMBC CME guidance](https://www.ombc.ca.gov/licensees/cme.pdf): existing DO general/category and recurring addiction training requirements are retained.
- [Ohio4731-10-02](https://codes.ohio.gov/ohio-administrative-code/rule-4731-10-02) and [Ohio4731-29-01](https://codes.ohio.gov/ohio-administrative-code/rule-4731-29-01): existing general/reporting and conditional pain-clinic calculation behavior remains under regression coverage.

## Verification

All scenarios use synthetic records. No customer data or provider mutations.

- 18 California engine tests: MD/DO unknown/yes/no, exact10-hour target with130.5 logged, inclusive date boundaries/custom start, older training, accepted-category representation, unknown degree, real zero-hour duties elsewhere and unchanged records.
- 226 existing compliance checks and59 Ohio checks.
- 10 presentation/component tests: actual summary rendering, mixed known/unknown states, explicit owner-side applicability selection, visible informational guidance and Vera reference classification.
- 126 import checks,37 passport checks,8 public CME content tests and8 assistant-evidence tests.
- `npm run build` passes, including precache validation. Existing large-chunk warning remains.
- Focused modified helper/shared-component lint passes. Independent review of the full combined diff is recorded in the private review receipt.

Commands:

```sh
node --test scripts/california-cme.test.mjs scripts/cme-presentation.test.mjs
node scripts/compliance.test.mjs
node --experimental-vm-modules scripts/ohio-cme.test.mjs
node scripts/cme-import.test.mjs
node --experimental-vm-modules scripts/cme-passport.test.mjs
node --experimental-vm-modules scripts/cme-content.test.mjs
node --experimental-vm-modules --test tests/assistant-evidence/evidence.test.mjs
npm run build
```

## Limits

This is a saved-record calculation and presentation repair. It does not determine a specific physician's degree, specialty, patient mix, exemption or course acceptance. Pain-management and MATE targets and historical credit counting remain unchanged; missing app evidence is not proof that new training is owed. No new historical attestation model or all-state/historical rule-version engine is introduced. In particular, the current DO source's effective date is preserved as evidence, not applied retroactively as a claim about every older renewal cycle. The existing calculator is not a historical legal determination.

No credits, dates, customer records, schema, billing, authentication, deployment flags or email holds are migrated or changed. No production deployment is part of this commit.
