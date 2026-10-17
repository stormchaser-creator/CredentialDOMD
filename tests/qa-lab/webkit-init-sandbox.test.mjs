import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { webkitLabInitScript } from '../../qa-lab/e2e/support/ios.mjs';

function fixture({ opaque = false } = {}) {
  class HTMLMetaElement {}
  Object.defineProperty(HTMLMetaElement.prototype, 'content', {
    configurable: true, get() { return this.value || ''; }, set(value) { this.value = value; },
  });
  class ServiceWorkerContainer { register() { return Promise.resolve('unguarded'); } }
  const navigator = { userAgent: 'Synthetic desktop', maxTouchPoints: 0 };
  Object.defineProperty(navigator, 'serviceWorker', { get() {
    if (opaque) throw new DOMException("Service Worker is disabled because the context is sandboxed and lacks the 'allow-same-origin' flag", 'SecurityError');
    return {};
  } });
  const run = () => vm.runInNewContext(`(${webkitLabInitScript.toString()})()`, { navigator, HTMLMetaElement, ServiceWorkerContainer, DOMException });
  return { run, HTMLMetaElement, ServiceWorkerContainer };
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
