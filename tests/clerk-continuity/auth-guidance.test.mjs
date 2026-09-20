import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../../', import.meta.url));

async function compile(continuityFlag, reactRuntime = React) {
  const bundled = await build({
    entryPoints: [`${root}src/components/pages/AuthPage.jsx`],
    bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic',
    external: ['react', 'react/jsx-runtime'],
    define: { 'import.meta.env': JSON.stringify({
      VITE_CLERK_PUBLISHABLE_KEY: 'pk_live_synthetic',
      ...(continuityFlag === undefined ? {} : { VITE_CLERK_CONTINUITY_ENABLED: continuityFlag }),
    }) },
    plugins: [{ name: 'no-provider-auth-render', setup(builder) {
      builder.onResolve({ filter: /^@clerk\/clerk-react$/ }, () => ({ path: 'clerk', namespace: 'fixture' }));
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `
        import React from 'react';
        const widget = (name, props) => React.createElement('div', {
          'data-clerk-widget': name, 'data-routing': props.routing,
          'data-with-sign-up': String(props.withSignUp),
          'data-fallback': props.fallbackRedirectUrl,
          'data-sign-up-fallback': props.signUpFallbackRedirectUrl,
          'data-prefills': JSON.stringify(props.initialValues || null),
          'data-metadata': JSON.stringify(props.unsafeMetadata || null),
        });
        export const SignIn = props => widget('SignIn', props);
        export const SignUp = props => widget('SignUp', props);
      ` }));
    } }],
  });
  const mod = { exports: {} };
  const load = name => name === 'react' ? reactRuntime : require(name);
  new Function('require', 'module', 'exports', bundled.outputFiles[0].text)(load, mod, mod.exports);
  return mod.exports.default;
}

for (const flag of [undefined, 'false', 'TRUE', 'true']) {
  test(`one Clerk flow handles both account paths independently of continuity display flag ${String(flag)}`, async () => {
    const Page = await compile(flag);
    const previousWindow = globalThis.window;
    try {
      for (const hash of ['', '#/verify-email', '#/factor-one', '#/sign-up', '#/sign-up/verify-email']) {
        globalThis.window = { location: { hash } };
        const html = renderToStaticMarkup(React.createElement(Page));
        assert.equal((html.match(/data-clerk-widget="SignIn"/g) || []).length, 1);
        assert.match(html, /data-with-sign-up="true"/);
        assert.match(html, /data-routing="hash"/);
        assert.match(html, /data-fallback="\/app\/"/);
        assert.match(html, /data-sign-up-fallback="\/app\/"/);
        assert.match(html, /data-prefills="null"/);
        assert.match(html, /data-metadata="null"/);
        assert.equal((html.match(/<button\b/g) || []).length, 0);
        assert.match(html, /Already have an account\? Use the same email address/);
        assert.doesNotMatch(html, /Returning from the beta|Set up my existing|Create Account|data-clerk-widget="SignUp"|password wasn’t transferred/);
      }
    } finally {
      if (previousWindow === undefined) delete globalThis.window;
      else globalThis.window = previousWindow;
    }
  });
}

test('legacy entry aliases normalize before the widget mounts while Clerk verification and opaque fragments remain untouched', async () => {
  const cases = ['#sign-up', '#sign-in', '', '#/sign-up', '#/verify-email', '#/factor-one',
    '#/sign-up/verify-email', '#/verify-email?redirect_url=%2Fapp%2F', '#sign-up?ticket=opaque', '#launch_invite=opaque'];
  for (const hash of cases) {
    let ready, effects = [], handler;
    const Page = await compile('true', {
      ...React,
      useState(initial) {
        if (ready === undefined) ready = initial();
        return [ready, next => { ready = typeof next === 'function' ? next(ready) : next; }];
      },
      useRef: () => ({ current: null }),
      useEffect(effect) { effects.push(effect); },
    });
    const previousWindow = globalThis.window, previousHistory = globalThis.history;
    const state = { retained: 'history state' }, changes = [], removed = [];
    const location = { hash, pathname: '/app/', search: '?return_to=%2Fapp%2F' };
    globalThis.window = { location,
      addEventListener(name, listener) { assert.equal(name, 'hashchange'); handler = listener; },
      removeEventListener(name, listener) { removed.push([name, listener]); },
    };
    globalThis.history = { state, replaceState(savedState, title, url) {
      changes.push({ savedState, title, url }); location.hash = '';
    } };
    try {
      const widgetKey = () => {
        let key;
        const visit = node => {
          if (!node || typeof node !== 'object') return;
          if (node.props?.withSignUp === true && node.props?.routing === 'hash') key = node.key;
          React.Children.forEach(node.props?.children, visit);
        };
        visit(Page.type());
        return key;
      };
      const legacy = hash === '#sign-up' || hash === '#sign-in';
      const before = renderToStaticMarkup(Page.type());
      assert.equal(before.includes('data-clerk-widget="SignIn"'), !legacy, 'no unsupported alias reaches the mounted Clerk router');
      const cleanup = effects.map(effect => effect()).filter(Boolean);
      effects = [];
      const after = renderToStaticMarkup(Page.type());
      assert.match(after, /data-clerk-widget="SignIn"/);
      assert.equal(changes.length, legacy ? 1 : 0);
      if (legacy) assert.deepEqual(changes[0], { savedState: state, title: '', url: '/app/?return_to=%2Fapp%2F' });
      else assert.equal(location.hash, hash, 'provider challenge/opaque fragment survives verbatim');
      const prior = changes.length;
      const beforeProviderRoute = widgetKey();
      location.hash = '#/verify-email?ticket=keep'; handler();
      assert.equal(changes.length, prior);
      assert.equal(location.hash, '#/verify-email?ticket=keep');
      assert.equal(widgetKey(), beforeProviderRoute, 'verification navigation never remounts Clerk');
      location.hash = '#sign-in'; handler();
      assert.equal(changes.length, prior + 1);
      assert.notEqual(widgetKey(), beforeProviderRoute, 'later legacy navigation resets the mounted router');
      const afterSignInAlias = widgetKey();
      location.hash = '#sign-up'; handler();
      assert.equal(changes.length, prior + 2);
      assert.notEqual(widgetKey(), afterSignInAlias);
      const afterSignUpAlias = widgetKey();
      location.hash = '#/factor-one'; handler();
      assert.equal(widgetKey(), afterSignUpAlias, 'back into a provider-owned factor step keeps the widget');
      cleanup.forEach(fn => fn());
      assert.deepEqual(removed, [['hashchange', handler]]);
    } finally {
      if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow;
      if (previousHistory === undefined) delete globalThis.history; else globalThis.history = previousHistory;
    }
  }
});
