import test from 'node:test';
import assert from 'node:assert/strict';
import { edgeRuntimeHasFunctionConfig, functionVerificationSettings } from '../../qa-lab/lib/stack.mjs';
import { localContainer } from '../../qa-lab/lib/config.mjs';

const source = '[functions.limited-refund]\nverify_jwt = false\n\n[functions.track-event]\nverify_jwt = true\n';
const names = ['limited-refund', 'track-event', 'source-only'];
const config = { 'limited-refund': { verifyJWT: false }, 'track-event': { verifyJWT: true }, 'source-only': { verifyJWT: true } };
const inspect = value => (cmd, args, options) => {
  assert.equal(cmd, 'docker');
  assert.deepEqual(args, ['inspect', localContainer('edge_runtime'), '--format', '{{json .Config.Env}}']);
  assert.equal(options.encoding, 'utf8');
  return { status: 0, stdout: JSON.stringify(['STRIPE_SECRET_KEY=synthetic-private-value', `SUPABASE_INTERNAL_FUNCTIONS_CONFIG=${JSON.stringify(value)}`]) };
};
const matches = value => edgeRuntimeHasFunctionConfig({ source, names, run: inspect(value) });

test('function settings include configured routes and source-only defaults, excluding disabled functions', () => {
  assert.deepEqual(functionVerificationSettings(source, names), { 'limited-refund': false, 'track-event': true, 'source-only': true });
  assert.deepEqual(functionVerificationSettings('[functions.disabled]\nenabled = false\n\n[functions.normal]\n', ['disabled', 'normal']), { normal: true });
  for (const text of ['[functions.f]\nverify_jwt = "false"', '[functions.f]\nverify_jwt = false\nverify_jwt = true', '[functions.f]\n[functions.f]\n']) assert.throws(() => functionVerificationSettings(text, []), /invalid|duplicate/);
});

test('a new refund function, changed JWT flag or removed source route requires container recreation', () => {
  assert.equal(matches(config), true);
  const { 'limited-refund': omitted, ...old } = config;
  assert.equal(matches(old), false, 'a restarted old container still lacks the new route');
  assert.equal(matches({ ...config, 'limited-refund': { verifyJWT: true } }), false, 'gateway must allow the hook/member handler to authenticate');
  assert.equal(matches({ ...config, 'track-event': { verifyJWT: false } }), false, 'a protected route cannot silently lose verification');
  assert.equal(matches({ ...config, retired: { verifyJWT: false } }), false, 'old routes removed from source cannot remain registered');
  assert.equal(matches({ ...config, 'source-only': { verifyJWT: false } }), false, 'removing an explicit exemption restores the default');
  assert.equal(matches({ ...config, 'limited-refund': { verifyJWT: 'false' } }), false);
});

test('unavailable or malformed runtime config fails closed without printing environment values', () => {
  for (const value of [null, [], 'text', { 'limited-refund': null }]) assert.equal(matches(value), false);
  for (const response of [{ status: 1 }, { status: 0, stdout: 'not JSON' }, { status: 0, stdout: '{}' }, { status: 0, stdout: '[null]' }, { status: 0, stdout: '["SUPABASE_INTERNAL_FUNCTIONS_CONFIG=broken"]' }, { status: 0, stdout: '[]' }]) {
    assert.equal(edgeRuntimeHasFunctionConfig({ source, names, run: () => response }), false);
  }
});
