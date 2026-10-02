// The PA and NP rule data, put in place the way the app does for a PA or NP
// (src/utils/appRules.js loadAppRules): since goal4 it is a chunk of its own,
// not part of the modules that read it. A test that runs PA or NP rules
// imports this first. Physician-only tests never need it.
import { loadAppRules } from '../../src/utils/appRules.js';

await loadAppRules();
