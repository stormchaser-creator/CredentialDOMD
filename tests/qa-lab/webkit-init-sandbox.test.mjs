import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { webkitLabInitScript } from '../../qa-lab/e2e/support/ios.mjs';

function fixture({ opaque = false, userAgent = 'Synthetic desktop', coarse = false } = {}) {
  class HTMLMetaElement {}
  Object.defineProperty(HTMLMetaElement.prototype, 'content', {
    configurable: true, get() { return this.value || ''; }, set(value) { this.value = value; },
  });
  class ServiceWorkerContainer { register() { return Promise.resolve('unguarded'); } }
  class Navigator {}
  const navigator = Object.assign(new Navigator(), { userAgent, maxTouchPoints: 0 });
  let pointerCoarse = coarse;
  const window = { matchMedia: media => ({ matches: pointerCoarse && media === '(pointer: coarse)', media }) };
  const ready = []; const document = { addEventListener: (name, fn) => { if (name === 'DOMContentLoaded') ready.push(fn); } };
  Object.defineProperty(navigator, 'serviceWorker', { get() {
    if (opaque) throw new DOMException("Service Worker is disabled because the context is sandboxed and lacks the 'allow-same-origin' flag", 'SecurityError');
    return {};
  } });
  const run = () => vm.runInNewContext(`(${webkitLabInitScript.toString()})()`, { navigator, Navigator, window, document, HTMLMetaElement, ServiceWorkerContainer, DOMException });
  return { run, HTMLMetaElement, ServiceWorkerContainer, navigator, window, setPointerCoarse: value => { pointerCoarse = value; }, domReady: () => ready.forEach(fn => fn()) };
}

test('opaque sandbox frames do not gain a harness exception from the forbidden serviceWorker getter', () => {
  assert.doesNotThrow(fixture({ opaque: true }).run);
});
test('eligible WebKit pages still refuse worker registration so request guards cannot be bypassed', async () => {
  const f = fixture(); f.run();
  await assert.rejects(new f.ServiceWorkerContainer().register('/app/sw.js'), { name: 'SecurityError' });
});
test('the loopback CSP adjustment still runs after a sandboxed frame refuses the worker getter', () => {
  const f = fixture({ opaque: true }); f.run();
  const meta = new f.HTMLMetaElement(); meta.httpEquiv = 'Content-Security-Policy';
  meta.content = "default-src 'self'; upgrade-insecure-requests";
  assert.equal(meta.content, "default-src 'self'");
});

test('configured coarse-pointer iPhone gets installed-app modeling even when WebKit reports zero touch points', () => {
  const f = fixture({ userAgent: 'Synthetic iPhone', coarse: true }); f.run();
  assert.equal(f.navigator.maxTouchPoints, 0);
  assert.equal(f.navigator.standalone, true);
  assert.equal(f.window.matchMedia('(display-mode: standalone)').matches, true);
});
test('a non-touch iPhone user agent alone does not model an installed app', () => {
  const f = fixture({ userAgent: 'Synthetic iPhone' }); f.run();
  assert.equal(f.navigator.standalone, undefined);
});
test('a coarse-pointer desktop is not mislabeled an installed iPhone app', () => {
  const f = fixture({ coarse: true }); f.run();
  assert.equal(f.navigator.standalone, undefined);
});

test('a touch context whose media query becomes ready after initialization is modeled at DOMContentLoaded', () => {
  const f = fixture({ userAgent: 'Synthetic iPhone' }); f.run();
  assert.equal(f.navigator.standalone, undefined);
  f.setPointerCoarse(true); f.domReady();
  assert.equal(f.navigator.standalone, true);
  assert.equal(f.window.matchMedia('(display-mode: standalone)').matches, true);
});
