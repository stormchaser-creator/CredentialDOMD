// Observe the existing settled UI checkpoint once. Do not retry or wait for
// an unexpected warning to disappear: ordinary successful work needs no recovery.
export async function checkNoUnexpectedRecovery(page, qa, context) {
  const notices = page.getByText('Saved copies need your review', { exact: true });
  const count = await notices.count();
  const visible = await Promise.all(Array.from({ length: count }, (_, index) => notices.nth(index).isVisible()));
  qa.check(`${context}: no unexpected recovery warning`, !visible.some(Boolean),
    `${visible.filter(Boolean).length} visible recovery warning(s)`);
}
