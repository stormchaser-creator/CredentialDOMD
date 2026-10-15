import test from 'node:test';
import assert from 'node:assert/strict';
import { requestDeviceShare } from '../src/utils/deviceShare.js';

test('an unanswered native sheet returns a request without a timer or second send', async () => {
  let calls = 0;
  const result = await requestDeviceShare({ text: 'Synthetic letter' }, { nav: { share: () => { calls++; return new Promise(() => {}); } } });
  assert.deepEqual(result, { status: 'requested' });
  assert.equal(calls, 1);
});
test('an immediately completed sheet retains its answer', async () => {
  assert.deepEqual(await requestDeviceShare({}, { nav: { share: async () => {} } }), { status: 'completed' });
});
for (const name of ['AbortError', 'InvalidStateError', 'NotAllowedError']) {
  test(`an immediate ${name} remains a refusal`, async () => {
    const error = Object.assign(Error('Synthetic refusal'), { name });
    await assert.rejects(requestDeviceShare({}, { nav: { share: async () => { throw error; } } }), e => e === error);
  });
}
test('a synchronous refusal remains a refusal', async () => {
  await assert.rejects(requestDeviceShare({}, { nav: { share: () => { throw Error('Synthetic refusal'); } } }), /Synthetic refusal/);
});
test('a late refusal is consumed and reported once, without repeating the share', async () => {
  let reject, calls = 0; const errors = [];
  const result = await requestDeviceShare({}, { nav: { share: () => { calls++; return new Promise((_, r) => { reject = r; }); } }, onLateError: e => errors.push(e) });
  assert.equal(result.status, 'requested');
  const error = Object.assign(Error('Synthetic cancel'), { name: 'AbortError' });
  reject(error); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(errors, [error]); assert.equal(calls, 1);
});
