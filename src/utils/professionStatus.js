// One switch for what a blank or unrecognised profession means (DESIGN 1.3,
// owner decision D-1, default chosen): unknown in every state. A blank member
// may now be a physician, a PA or an NP, so physician numbers still show for
// them, marked provisional, and never read "met" until a profession is chosen.
// Reverting D-1 is this predicate alone.
import { professionOf } from "../constants/professions.js";

export function professionStatus(degreeType) {
  const profession = professionOf(degreeType);
  return { profession, unknown: profession === null };
}
