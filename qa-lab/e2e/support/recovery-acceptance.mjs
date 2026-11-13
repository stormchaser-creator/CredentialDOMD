// Observe the existing settled UI checkpoint once. Do not retry or wait for
// an unexpected recovery copy to disappear: ordinary successful work needs
// no recovery. The copies are kept silently on the device now (no notice on
// the everyday screens), so the check reads the device store itself.
export const RECOVERY_PREFIX = 'credentialdomd-sync-recovery-v1:';
export const recoveryCopyCount = page => page.evaluate(prefix => {
  let n = 0;
  for (let i = 0; i < localStorage.length; i++) if (localStorage.key(i)?.startsWith(prefix)) n++;
  return n;
}, RECOVERY_PREFIX);
export async function checkNoUnexpectedRecovery(page, qa, context) {
  const kept = await recoveryCopyCount(page);
  qa.check(`${context}: no unexpected recovery copy`, kept === 0, `${kept} recovery copie(s) kept on this device`);
}
