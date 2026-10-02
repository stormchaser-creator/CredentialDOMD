// One Multi-state matrix row for a PA or an NP (DESIGN 4.8). Physician rows
// are built in MultiStateMatrix.jsx exactly as before.
//
// A PA row: the PA licence, the PA card's CME, DEA, the state controlled
// substance registration, and the practice agreement. An NP row: the APRN
// licence, the RN licence (or a multistate RN from another state, only when
// verified, in-force Nurse Licensure Compact facts cover both states), the
// APRN card's CE, DEA, CSR and the agreement.
//
// An agreement is never read as required from the state alone where the
// state's rule depends on the clinician (decision 14): the cell shows the
// member's answer on the practice licence, or asks.
//
// Pure: plain node tests import it.
import { complianceFor } from "./compliance.js";
import { agreementFor, npStateFor } from "./ruleResolver.js";
import { licenseKindOf, isMultistateRn, professionOf } from "../constants/professions.js";
import { QUESTION_FIELDS } from "../constants/recordQuestions.js";
import { STATE_NAMES } from "../constants/states.js";
import { isInactive } from "./lifecycle.js";

const pad = (n) => String(n).padStart(2, "0");
const dayOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** The state's verified NLC membership, in force on `today` (effectiveThrough is exclusive). */
export function nlcInForce(state, today = dayOf(new Date())) {
  const nlc = npStateFor(state)?.rn?.nlc;
  if (!nlc || nlc.value !== true) return false;
  return !nlc.effectiveThrough || today < nlc.effectiveThrough;
}

/** The agreement cell: { status: "required" | "yes" | "no" | "ask", agreement, record } or null (no verified fact). */
export function agreementCell(state, degreeType, kind, practiceLicense, agreementRecord) {
  const agreement = agreementFor(state, degreeType, kind);
  if (!agreement) return null;
  if (!agreement.conditional) return { status: "required", agreement, record: agreementRecord || null };
  const answer = practiceLicense?.customFields?.[QUESTION_FIELDS.agreement];
  const status = answer === "Yes" ? "yes" : answer === "No" ? "no" : "ask";
  return { status, agreement, record: agreementRecord || null };
}

export function appMatrixRow(data, state, { now = new Date() } = {}) {
  const deg = data?.settings?.degreeType || "";
  const profession = professionOf(deg);
  const licenses = (data?.licenses || []).filter((l) => l && !isInactive(l));
  const inState = licenses.filter((l) => l.state === state);
  const of = (kind) => inState.find((l) => licenseKindOf(l.type) === kind) || null;
  const practiceKind = profession === "pa" ? "pa" : "aprn";
  const practice = of(practiceKind);
  const comp = complianceFor(data, state, practiceKind);

  let rn = null;
  if (profession === "np") {
    const own = of("rn");
    if (own) rn = { license: own, via: "own" };
    else {
      const today = dayOf(now);
      const multi = licenses.find((l) => isMultistateRn(l.type) && l.state && l.state !== state);
      if (multi && nlcInForce(multi.state, today) && nlcInForce(state, today)) {
        rn = { license: multi, via: "multistate", home: multi.state, homeName: STATE_NAMES[multi.state] || multi.state };
      }
    }
  }

  return {
    state,
    stateName: STATE_NAMES[state] || state,
    profession,
    practice,
    practiceKind,
    rn,
    comp,
    dea: of("dea"),
    csr: of("csr"),
    agreement: agreementCell(state, deg, practiceKind, practice, of("agreement")),
    unmet: (comp?.topicResults || []).filter((t) => t.met === false),
  };
}
