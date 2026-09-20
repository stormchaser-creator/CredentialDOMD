import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../../', import.meta.url));

async function compile(continuityFlag) {
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
          'data-other-mode': props.signUpUrl || props.signInUrl,
          'data-fallback': props.fallbackRedirectUrl,
        });
        export const SignIn = props => widget('SignIn', props);
        export const SignUp = props => widget('SignUp', props);
      ` }));
    } }],
  });
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', bundled.outputFiles[0].text)(require, mod, mod.exports);
  return mod.exports.default;
}

for (const flag of [undefined, 'false', 'TRUE', 'true']) {
  test(`actual AuthPage continuity guidance is ${flag === 'true' ? 'visible' : 'absent'} for flag ${String(flag)}`, async () => {
    const Page = await compile(flag);
    const previousWindow = globalThis.window;
    try {
      for (const [hash, widget, otherMode] of [['', 'SignIn', '#sign-up'], ['#sign-up', 'SignUp', '#sign-in']]) {
        globalThis.window = { location: { hash } };
        const html = renderToStaticMarkup(React.createElement(Page));
        assert.match(html, new RegExp(`data-clerk-widget="${widget}"`));
        assert.match(html, /data-routing="hash"/);
        assert.ok(html.includes(`data-other-mode="${otherMode}"`));
        assert.match(html, /data-fallback="\/app\/"/);
        assert.equal((html.match(/<button\b/g) || []).length, 2, 'no extra auth action or new account-creation behavior');
        if (flag === 'true') {
          assert.match(html, /aria-labelledby="returning-beta-heading"/);
          assert.match(html, /verified primary email from your original beta sign-in account/);
          assert.match(html, /choose Create Account once and verify that same email/);
          assert.match(html, /saved beta records after verifying the account match/);
          assert.match(html, /beta password wasn’t transferred/);
          assert.ok(html.indexOf('Returning from the beta?') < html.indexOf('data-clerk-widget='));
        } else {
          assert.doesNotMatch(html, /returning-beta-heading|Returning from the beta|saved beta records|password wasn’t transferred/);
        }
      }
    } finally {
      if (previousWindow === undefined) delete globalThis.window;
      else globalThis.window = previousWindow;
    }
  });
}
