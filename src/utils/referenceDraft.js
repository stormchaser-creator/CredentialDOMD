// Contact details are resolved on-device, never added to AI snapshots,
// model replies, or conversation metadata by this feature.
const line = value => typeof value === "string" ? value.replace(/[\r\n]+/g, " ").trim() : "";
const ids = values => [...new Set((Array.isArray(values) ? values : [])
  .filter(value => typeof value === "string" && value.length > 0 && value.length <= 200))].slice(0, 200);

export function referenceSelection(action) {
  const excludedReferenceIds = ids(action?.excludedReferenceIds);
  const excluded = new Set(excludedReferenceIds);
  return {
    referenceIds: ids(action?.referenceIds).filter(id => !excluded.has(id)),
    excludedReferenceIds,
  };
}

export function latestReferenceSelection(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== "model" || messages[i].failed) continue;
    const actions = messages[i].actions || [];
    for (let j = actions.length - 1; j >= 0; j--) {
      if (actions[j].kind === "draft_references") return referenceSelection(actions[j]);
    }
  }
  return null;
}

export function resolveReferenceSelection(action, previous) {
  const restored = new Set(ids(action?.restoreReferenceIds));
  return referenceSelection({
    referenceIds: action?.referenceIds,
    excludedReferenceIds: [...ids(previous?.excludedReferenceIds).filter(id => !restored.has(id)), ...ids(action?.excludedReferenceIds)],
  });
}

export function buildReferenceText(item = {}) {
  const name = line(item.name) || "Unnamed reference";
  const degree = line(item.degree);
  const lines = [degree && !name.endsWith(degree) ? `${name}, ${degree}` : name];
  for (const [label, key] of [
    ["Specialty", "specialty"], ["Institution", "institution"],
    ["Relationship", "relationship"], ["Known since", "knownSince"],
    ["Email", "email"], ["Phone", "phone"],
  ]) {
    const value = line(item[key]);
    if (value) lines.push(`${label}: ${value}`);
  }
  return lines.join("\n");
}

export function buildReferenceDraft(references, action) {
  const selection = referenceSelection(action);
  const byId = new Map((references || []).map(ref => [ref.id, ref]));
  const selected = selection.referenceIds.map(id => byId.get(id)).filter(Boolean);
  return {
    ...selection,
    text: selected.map(buildReferenceText).join("\n\n"),
    selected,
    unavailableIds: selection.referenceIds.filter(id => !byId.has(id)),
    missingContacts: selected.filter(ref => !line(ref.email) || !line(ref.phone)),
  };
}

// Only selection IDs enter provider-bound history, preserving exclusions.
export function buildAssistantHistory(messages) {
  const current = latestReferenceSelection(messages);
  const kept = messages.filter(m => !m.failed);
  return kept.map((m, i) => {
    const selections = m.role === "model" ? (m.actions || [])
      .filter(a => a.kind === "draft_references" && !a.dismissed)
      .map(referenceSelection) : [];
    return {
      role: m.role,
      text: (m.text || "") + (selections.length
        ? `\n[Reference draft selections: ${JSON.stringify(selections)}]` : "")
        + (current && i === kept.length - 1 && m.role === "user"
          ? `\n[Current reference draft selection: ${JSON.stringify(current)}]` : ""),
    };
  });
}

export function archivedReferenceActions(actions) {
  return (actions || []).filter(a => a.kind === "draft_references")
    .map(a => ({ kind: "draft_references", ...referenceSelection(a), ...(a.dismissed ? { dismissed: true } : {}) }));
}
