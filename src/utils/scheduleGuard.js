/**
 * Where am I supposed to be on this date?
 *
 * A locum works several agreements at once, and the expensive mistake is
 * logging a day against the wrong one — billing Good Samaritan for a day
 * actually worked at Eisenhower, or logging into a contract whose coverage
 * dates were never entered. Both are invisible until an agency queries the
 * invoice weeks later.
 *
 * So before a day is saved we ask what the schedule says. The answer is a
 * warning, never a block: the schedule is often behind reality, and the
 * physician is the authority on where he actually was. Confirming records
 * the override on the entry so it never nags about that day again.
 */

/** Coverage blocks for a contract, falling back to a plain start/end pair. */
function blocksOf(contract) {
  if (!contract) return [];
  const ps = contract.coveragePeriods?.length
    ? contract.coveragePeriods
    : (contract.startDate ? [{ start: contract.startDate, end: contract.endDate || contract.startDate }] : []);
  return ps.filter(p => p && p.start);
}

export function coversDate(contract, dateStr) {
  if (!contract || !dateStr) return false;
  // A day-rate agreement is an UMBRELLA, not a schedule: its multi-year term
  // says the relationship exists, not that the physician is standing there
  // on any given date. It never claims a date — so it can never put another
  // contract's day "in conflict". (Days logged AGAINST it are still checked
  // the other way round: its own branch warns when a different contract has
  // that date scheduled.)
  if (contract.payModel === "daily" && !contract.coveragePeriods?.length) return false;
  return blocksOf(contract).some(p => dateStr >= p.start && dateStr <= (p.end || p.start));
}

/** Contracts whose scheduled coverage includes this date. */
export function contractsCoveringDate(contracts, dateStr) {
  return (contracts || []).filter(c => coversDate(c, dateStr));
}

/** Is the date inside a day-rate contract's overall term? */
export function inTerm(contract, dateStr) {
  if (!contract?.termStart || !dateStr) return null;
  return dateStr >= contract.termStart && (!contract.termEnd || dateStr <= contract.termEnd);
}

/**
 * What the schedule says about logging THIS contract on THIS date.
 * @returns null when nothing looks wrong, else
 *   {level: "conflict"|"unscheduled"|"outside-term", title, message, elsewhere: string[]}
 */
export function checkPlacement(contracts, contract, dateStr) {
  if (!contract || !dateStr) return null;

  const others = (contracts || []).filter(c => c.id !== contract.id);
  const elsewhere = contractsCoveringDate(others, dateStr).map(c => c.facility || "another contract");

  // A term-based agreement has no coverage blocks by design — it is judged
  // against its term, and against whether another agency has that date.
  if (contract.payModel === "daily") {
    const within = inTerm(contract, dateStr);
    if (within === false) {
      return {
        level: "outside-term",
        title: "Outside the contract term",
        message: `${dateStr} falls outside ${contract.facility || "this contract"}'s term (${contract.termStart || "?"} to ${contract.termEnd || "open"}). Log it anyway only if the term is wrong or the day genuinely belongs here.`,
        elsewhere,
      };
    }
    if (elsewhere.length) {
      return {
        level: "conflict",
        title: "You're scheduled elsewhere",
        message: `Your schedule has you at ${elsewhere.join(" and ")} on ${dateStr}. Logging this day against ${contract.facility || "this contract"} would bill two agreements for the same date.`,
        elsewhere,
      };
    }
    return null;
  }

  if (coversDate(contract, dateStr)) {
    // Scheduled here, but also scheduled somewhere else — worth a look
    if (elsewhere.length) {
      return {
        level: "conflict",
        title: "Two contracts cover this date",
        message: `${dateStr} sits inside a coverage block for both ${contract.facility || "this contract"} and ${elsewhere.join(" and ")}. Make sure this day belongs to the one you picked.`,
        elsewhere,
      };
    }
    return null;
  }

  if (elsewhere.length) {
    return {
      level: "conflict",
      title: "You're scheduled elsewhere",
      message: `${dateStr} isn't in a coverage block for ${contract.facility || "this contract"}, but it is for ${elsewhere.join(" and ")}. Check you picked the right agreement before this reaches an invoice.`,
      elsewhere,
    };
  }

  return {
    level: "unscheduled",
    title: "No coverage on file for this date",
    message: `${dateStr} isn't inside any scheduled coverage block for ${contract.facility || "this contract"}. That usually means the dates were never added to the agreement — worth fixing on the Contracts tab so future days check themselves.`,
    elsewhere: [],
  };
}
