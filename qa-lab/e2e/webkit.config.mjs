// The journeys in Playwright's WebKit (Safari's engine), for the owner's
// installed iPhone app. The Chromium configuration (playwright.config.mjs) is
// unchanged; this one reuses it and swaps the engine:
//
//   QA_E2E_RESULTS=qa-lab/.generated/runs/<name>.json QA_E2E_NO_RESTART=1 \
//     node node_modules/@playwright/test/cli.js test --config qa-lab/e2e/webkit.config.mjs <file>.spec.mjs
//
// (`npx playwright install webkit` once, from this checkout: Playwright 1.63
// uses WebKit 26.6, revision 2359.) A journey that sets its own device
// (phoneUse, test.use) keeps it and runs in WebKit. Every other journey runs as
// the installed app on an iPhone 15 (393 x 852 full screen, as it opens from
// the home screen; isMobile, touch, an iOS 18.7 Safari user agent), unless
// QA_WEBKIT_DESK=1 keeps the desk viewport (desktop Safari).
import { devices } from '@playwright/test';
import base from './playwright.config.mjs';

const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.7 Mobile/15E148 Safari/604.1';

/** The installed app on an iPhone 15: full screen (no Safari bars), touch, mobile viewport. */
export const IPHONE_15_APP = {
  ...devices['iPhone 15'], userAgent: IPHONE_UA, viewport: { width: 393, height: 852 }, screen: { width: 393, height: 852 },
};
delete IPHONE_15_APP.defaultBrowserType;

const desk = /^(1|true|yes|on)$/i.test(String(process.env.QA_WEBKIT_DESK || '').trim());
const { channel: _channel, ...use } = base.use;

export default {
  ...base,
  projects: [{ name: 'webkit' }],
  use: {
    ...use,
    ...(desk ? { ...devices['Desktop Safari'], viewport: { width: 1280, height: 900 } } : IPHONE_15_APP),
    browserName: 'webkit',
    // A second guard beside support/ios.mjs webkitLabInitScript: in WebKit a
    // page the app's service worker controls bypasses context.route, so every
    // stand-in and the outside-host guard would be off (78025564).
    serviceWorkers: 'block',
  },
};
