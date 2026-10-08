// Signup review 2026-10-07: the /app/ page's head (what a shared link and a
// search result show for the sign-in page) said the founder is an MD, linked
// an organization logo that answers 404 (/icons/ is only under /app/), and
// carried an em dash in its title. The home page's own structured data is
// the reference: DO, /organization-logo.svg (published at the site root).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const app = await readFile(new URL('../../index.html', import.meta.url), 'utf8');
const home = await readFile(new URL('../../landing/index.html', import.meta.url), 'utf8');
const orgOf = html => JSON.parse(html.match(/<script type="application\/ld\+json">\s*([\s\S]*?"@type": "Organization"[\s\S]*?)\s*<\/script>/)[1]);

test('the app head: founder DO, the published organization logo, no em dash', () => {
  const org = orgOf(app), reference = orgOf(home);
  assert.equal(org.founder.honorificSuffix, 'DO');
  assert.equal(org.founder.honorificSuffix, reference.founder.honorificSuffix);
  assert.equal(org.founder.url, reference.founder.url);
  assert.equal(org.logo, 'https://credentialdomd.com/organization-logo.svg');
  assert.equal(org.logo, reference.logo);
  assert.doesNotMatch(app, /—/, 'no em dash anywhere in the app page');
  assert.match(app, /<title>CredentialDOMD \| Credential tracking for physicians, by a physician<\/title>/);
});
