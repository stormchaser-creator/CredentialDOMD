import test from 'node:test';
import assert from 'node:assert/strict';
import { recoverStartupModule } from '../src/utils/startupModule.js';
function fixture() {
  const data = new Map(); let reloads = 0;
  return { options: { storage: { getItem: k => data.get(k), setItem: (k,v) => data.set(k,v) }, reload: () => reloads++, online: true, build: 'https://local/app/assets/entry-build1.js' }, reloads: () => reloads };
}
for (const message of ['Importing a module script failed.', 'Failed to fetch dynamically imported module: https://local/app/assets/App.js', 'error loading dynamically imported module: https://local/app/assets/App.js']) {
  test(`root loading failure recovers once per build: ${message}`, () => {
    const f = fixture(), e = new TypeError(message);
    assert.equal(recoverStartupModule(e, f.options), true);
    assert.equal(recoverStartupModule(e, f.options), false);
    assert.equal(f.reloads(), 1);
    assert.equal(recoverStartupModule(e, { ...f.options, build: 'entry-build2.js' }), true);
  });
}
test('offline, evaluation and ordinary failures leave manual recovery intact', () => {
  const f = fixture();
  for (const e of [new Error('Importing a module script failed.'), new TypeError('Cannot read properties of undefined'), new SyntaxError('Unexpected token')]) assert.equal(recoverStartupModule(e, f.options), false);
  assert.equal(recoverStartupModule(new TypeError('Importing a module script failed.'), { ...f.options, online: false }), false);
  assert.equal(f.reloads(), 0);
});
test('unavailable or silently refused session storage cannot cause a reload loop', () => {
  const f=fixture(), error=new TypeError('Importing a module script failed.');
  for (const storage of [{ getItem(){throw Error('blocked');} }, {getItem(){return null;},setItem(){throw Error('full');}}, {getItem(){return null;},setItem(){}}]) assert.equal(recoverStartupModule(error,{...f.options,storage}),false);
  assert.equal(f.reloads(),0);
});
