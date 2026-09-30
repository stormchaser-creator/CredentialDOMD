// HOME-005: the desk sidebar's avatar took the first two letters of the name
// ("NA" for Nadia Navigate) while the top bar and Settings took the first
// letter of each word ("NN"), so one member had two avatars on one screen.
// All three now draw from helpers.js avatarInitials. Synthetic names only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { mountComponent } from '../component-harness.mjs';
import { avatarInitials } from '../../src/utils/helpers.js';

const root = fileURLToPath(new URL('../..', import.meta.url));

test('avatarInitials: the first letter of each of the first two words, "MD" with no name', () => {
  assert.equal(avatarInitials('Nadia Navigate'), 'NN');
  assert.equal(avatarInitials('  nadia   navigate  '), 'NN', 'extra spaces are not words');
  assert.equal(avatarInitials('Nadia Q. Navigate'), 'NQ', 'the top bar\'s rule: the first two words');
  assert.equal(avatarInitials('Nadia'), 'N');
  assert.equal(avatarInitials(''), 'MD');
  assert.equal(avatarInitials(null), 'MD');
  assert.equal(avatarInitials(undefined), 'MD');
});

/** The desk sidebar for a member with this name and no photo; the avatar's text. */
async function sidebarAvatar(settings) {
  const m = await mountComponent('src/components/shared/SideNav.jsx', {
    modules: { helpers: { avatarInitials } },
    app: { theme: {}, toggleTheme() {}, isDesktop: true, isDark: false, data: { settings }, user: { email: 'synthetic.member@example.test' } },
    props: { items: [], active: 'home', onChange() {} },
  });
  const avatar = m.nodes().find(n => n.type === 'div' && n.props.style?.borderRadius === 16 && n.props.style?.width === 32);
  assert.ok(avatar, 'the sidebar renders its avatar');
  return m.text(avatar);
}

test('the desk sidebar shows the same initials as the top bar', async () => {
  assert.equal(await sidebarAvatar({ name: 'Nadia Navigate' }), 'NN');
  assert.equal(await sidebarAvatar({ name: '' }), 'MD', 'no name: the top bar\'s "MD", not the email\'s first letters');
});

test('the top bar, Settings and the sidebar all use avatarInitials', () => {
  const app = readFileSync(`${root}src/App.jsx`, 'utf8');
  const settings = readFileSync(`${root}src/components/pages/SettingsSection.jsx`, 'utf8');
  const side = readFileSync(`${root}src/components/shared/SideNav.jsx`, 'utf8');
  assert.match(app, /: avatarInitials\(data\.settings\.name\)\}/);
  assert.match(settings, /: avatarInitials\(s\.name\)\}/);
  assert.match(side, /const initials = avatarInitials\(data\.settings\.name\);/);
  for (const src of [app, settings, side]) {
    assert.doesNotMatch(src, /\.split\(" "\)\.map\(w => w\[0\]\)/, 'no second copy of the rule');
    assert.doesNotMatch(src, /\.slice\(0, 2\)\.toUpperCase\(\)/);
  }
});
