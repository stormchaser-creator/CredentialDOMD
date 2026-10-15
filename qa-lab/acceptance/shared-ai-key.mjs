import { randomUUID } from 'node:crypto';
const same = (a, b) => a === null && b === null || a !== null && b !== null && a.value === b.value && a.updatedAt === b.updatedAt;
/** Only a synthetic key, and exact restoration even if the scenario throws. */
export async function withTemporarySharedAiKey(store, scenario, value = `qa-lab-placeholder-budget-${randomUUID()}`) {
  const before = await store.read();
  if ((before && !String(before.value).startsWith('qa-lab-placeholder-')) || !value.startsWith('qa-lab-placeholder-')) throw new Error('Refusing a non-synthetic shared AI key.');
  try {
    await store.install(before, value);
    if ((await store.read())?.value !== value) throw new Error('Temporary AI key was not installed.');
    return await scenario();
  } finally {
    const current = await store.read();
    if (!same(current, before)) {
      if (current?.value !== value) throw new Error('Shared key changed concurrently; refusing to overwrite it. Restore requires coordinator review.');
      await store.restore(before, value);
    }
    if (!same(await store.read(), before)) throw new Error('Shared AI key was not restored exactly.');
  }
}
/** Compare a bounded mock journal to an exact prior anchor, never a host-clock guess. */
export function callsSince(before, after) {
  if (!before.length) return after;
  const anchor = JSON.stringify(before[0]);
  const index = after.findIndex(call => JSON.stringify(call) === anchor);
  if (index < 0) throw new Error('Mock call journal lost its starting anchor.');
  return after.slice(0, index);
}
