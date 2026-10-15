// Complete local signup replay coverage. Explicit subsets are diagnostic runs.
export const ALL_REPLAY_VARIANTS = Object.freeze([
  'main', 'redirect-early', 'redirect-late', 'weaknet', 'resume', 'discard',
  'idle31-real', 'skew31', 'stall70', 'stall-forever',
]);
export function selectReplayVariants(value) {
  if (value !== undefined && typeof value !== 'string') throw new Error('REPLAY_VARIANTS must be a comma-separated selection.');
  const selected = new Set((value?.trim() ? value : ALL_REPLAY_VARIANTS.join(',')).split(',').map(v => v.trim()).filter(Boolean));
  if (!selected.size || [...selected].some(v => !ALL_REPLAY_VARIANTS.includes(v))) {
    throw new Error('Unsupported REPLAY_VARIANTS selection; choose a documented variant.');
  }
  return selected;
}
