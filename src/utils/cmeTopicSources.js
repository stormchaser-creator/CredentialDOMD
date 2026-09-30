// Where a member is sent for a mandatory CME topic that no listed provider
// carries (SETTINGS-016): the requirement's own link when the rule set has
// one, otherwise the state's source page. Pure: node tests import it.
import { STATE_REQS, getStateEntry } from "../constants/stateRequirements.js";

/**
 * [{ state, url }] for `topic`, one per distinct page, from the given states
 * (the member's tracked states). When none of them mandates the topic, every
 * state that does is searched, so a link from anywhere still finds its board.
 */
export function topicSources(topic, states, degreeType) {
  const degrees = degreeType === "MD" || degreeType === "DO" ? [degreeType] : ["MD", "DO"];
  const find = (list) => {
    const out = [], seen = new Set();
    for (const state of list || []) {
      for (const deg of degrees) {
        const entry = getStateEntry(state, deg);
        const rule = (entry?.topics || []).find((t) => t.topic === topic);
        const url = rule ? (rule.url || entry.sourceUrl) : null;
        if (!url || seen.has(url)) continue;
        seen.add(url);
        out.push({ state, url });
      }
    }
    return out;
  };
  const tracked = find(states);
  return tracked.length ? tracked : find(Object.keys(STATE_REQS));
}
