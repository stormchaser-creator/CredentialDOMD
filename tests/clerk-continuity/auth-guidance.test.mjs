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
          'data-other-mode': props.signUpUrl || props.signInUrl,
          'data-fallback': props.fallbackRedirectUrl,
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
        const showSetupAction = flag === 'true' && widget === 'SignIn';
        assert.equal((html.match(/<button\b/g) || []).length, showSetupAction ? 3 : 2);
        if (flag === 'true') {
          assert.match(html, /aria-labelledby="returning-beta-heading"/);
          assert.match(html, /verified primary email from your original beta account/);
          assert.match(html, /After we verify the match, we reconnect your saved records and existing access/);
          assert.match(html, /No card or new membership purchase is needed for sign-in setup/);
          assert.equal(html.includes('Set up my existing beta sign-in'), showSetupAction);
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

test('returning-beta action opens the same signup widget as Create Account and Sign In remains available', async () => {
  let mode;
  const Page = await compile('true', {
    ...React,
    useState(initial) {
      if (mode === undefined) mode = initial();
      return [mode, next => { mode = next; }];
    },
    useRef: () => ({ current: null }),
    useEffect() {},
  });
  const previousWindow = globalThis.window;
  globalThis.window = { location: { hash: '' } };
  try {
    const render = () => Page.type();
    const click = label => {
      let button;
      const visit = node => {
        if (!node || typeof node !== 'object') return;
        if (node.type === 'button' && node.props.children === label) button = node;
        React.Children.forEach(node.props?.children, visit);
      };
      visit(render());
      assert.ok(button, `Missing action: ${label}`);
      button.props.onClick();
    };
    assert.match(renderToStaticMarkup(render()), /data-clerk-widget="SignIn"/);
    click('Set up my existing beta sign-in');
    const existingSetup = renderToStaticMarkup(render());
    assert.match(existingSetup, /data-clerk-widget="SignUp"/);
    assert.doesNotMatch(existingSetup, /Set up my existing beta sign-in/);
    click('Sign In');
    assert.match(renderToStaticMarkup(render()), /data-clerk-widget="SignIn"/);
    click('Create Account');
    assert.equal(renderToStaticMarkup(render()), existingSetup, 'ordinary signup uses the same unchanged Clerk widget');
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});
