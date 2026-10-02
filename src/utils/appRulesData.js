// The PA and NP rule data as one chunk of its own (utils/appRules.js loads it
// with a dynamic import, never the entry bundle). Nothing else imports the
// two generated modules.
export { PA_STATE_RULES } from "../constants/paStateRules.js";
export { NP_STATE_RULES } from "../constants/npStateRules.js";
