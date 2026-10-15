// A native sheet can hand control to another app without settling its
// promise. Let the UI record a request and remain usable in that case.
// Neither a request nor the device's answer proves recipient delivery.
export async function requestDeviceShare(payload, { nav = globalThis.navigator, onLateError } = {}) {
  let answer;
  const completion = Promise.resolve(nav.share(payload)).then(
    () => (answer = { status: 'completed' }),
    error => (answer = { status: 'failed', error }),
  );
  // An immediate refusal (including a sheet already open) is still an
  // error. No timer is needed, so background suspension cannot hold the UI.
  await Promise.resolve();
  if (answer) {
    if (answer.status === 'failed') throw answer.error;
    return answer;
  }
  // Always consume the native rejection. A caller may report it only while
  // its initiating account/view is current; it must never start another send.
  void completion.then(result => {
    if (result.status === 'failed') {
      try { onLateError?.(result.error); } catch { /* reporting cannot resend */ }
    }
  });
  return { status: 'requested' };
}
