import { getStateEntry } from "../constants/stateRequirements";

export function computeCompliance(cmeEntries, state, degreeType) {
  const entry = getStateEntry(state, degreeType);

  if (!entry || entry.total === 0) {
    const topicResults = (entry?.topics || [])
      .filter(t => t.hours > 0)
      .map(t => {
        const earned = cmeEntries
          .filter(c => (c.topics || []).includes(t.topic))
          .reduce((s, c) => s + (parseFloat(c.hours) || 0), 0);
        return { topic: t.topic, required: t.hours, earned, met: earned >= t.hours, note: t.note };
      });

    return {
      state,
      totalRequired: 0,
      totalEarned: cmeEntries.reduce((s, c) => s + (parseFloat(c.hours) || 0), 0),
      totalMet: true,
      cycle: entry?.cycle || 0,
      cat1Required: 0,
      cat1Earned: 0,
      cat1Met: true,
      topicResults,
      allTopicsMet: topicResults.every(t => t.met),
      fullyCompliant: topicResults.every(t => t.met),
      notes: entry?.notes || "No general CME requirement",
      noGeneralReq: true,
    };
  }

  const totalHrs = cmeEntries.reduce((s, c) => s + (parseFloat(c.hours) || 0), 0);

  const cat1Keywords = degreeType === "DO"
    ? ["AOA Category 1-A", "AOA Category 1-B", "AMA PRA Category 1"]
    : ["AMA PRA Category 1"];

  const cat1Hrs = cmeEntries
    .filter(c => cat1Keywords.some(k => c.category === k))
    .reduce((s, c) => s + (parseFloat(c.hours) || 0), 0);

  const topicResults = (entry.topics || [])
    .filter(t => t.hours > 0)
    .map(t => {
      const earned = cmeEntries
        .filter(c => (c.topics || []).includes(t.topic))
        .reduce((s, c) => s + (parseFloat(c.hours) || 0), 0);
      return { topic: t.topic, required: t.hours, earned, met: earned >= t.hours, note: t.note };
    });

  const totalMet = totalHrs >= entry.total;
  const cat1Met = entry.cat1min <= 0 || cat1Hrs >= entry.cat1min;
  const allTopicsMet = topicResults.every(t => t.met);

  return {
    state,
    totalRequired: entry.total,
    totalEarned: totalHrs,
    totalMet,
    cycle: entry.cycle,
    cat1Required: entry.cat1min,
    cat1Earned: cat1Hrs,
    cat1Met,
    topicResults,
    allTopicsMet,
    fullyCompliant: totalMet && cat1Met && allTopicsMet,
    notes: entry.notes,
    noGeneralReq: false,
  };
}
