// Keep historical ledger category values stable; only their visible label changes.
export function deductionCategoryLabel(category) {
  return category === "Software / SaaS (CredentialDoMD, Doximity, etc.)"
    ? "Software / SaaS (CredentialDOMD, Doximity, etc.)"
    : category;
}
