// The theme a profile renders, what every indicator says, and what one tap
// does, for a stored value the app does not know ('arctic', the old column
// default most profiles still hold). Synthetic settings only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { THEMES, themeNameOf, nextThemeName } from '../../src/constants/themes.js';
import { mountComponent } from '../component-harness.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));

test('anything but light renders dark, and one tap from it gives light', () => {
  for (const v of ['arctic', 'dark', '', undefined, null, 'bogus']) {
    assert.equal(themeNameOf(v), 'dark', String(v));
    assert.equal(nextThemeName(v), 'light', String(v));
  }
  assert.equal(themeNameOf('light'), 'light');
  assert.equal(nextThemeName('light'), 'dark');
  assert.ok(THEMES[themeNameOf('arctic')]);
});

test('AppContext renders and toggles from the normalized name and exposes it', () => {
  const src = readFileSync(`${root}src/context/AppContext.jsx`, 'utf8');
  assert.match(src, /const themeName = themeNameOf\(data\.settings\.theme\)/);
  assert.match(src, /THEMES\[themeName\]/);
  assert.match(src, /const newTheme = nextThemeName\(d\.settings\.theme\)/);
  assert.match(src, /themeName, isDark/);
});

test('no indicator compares the stored value with "dark" any more', () => {
  for (const f of ['src/App.jsx', 'src/components/shared/SideNav.jsx', 'src/components/pages/SettingsSection.jsx']) {
    assert.doesNotMatch(readFileSync(`${root}${f}`, 'utf8'), /settings\.theme === "dark"/, f);
  }
});

test('the sidebar offers Light Mode to a profile stored as arctic', async () => {
  const m = await mountComponent('src/components/shared/SideNav.jsx', {
    app: { theme: {}, toggleTheme() {}, data: { settings: { theme: 'arctic', name: 'Synthetic' } }, user: {}, isDesktop: true, isDark: true, themeName: 'dark' },
    props: { items: [], active: 'home', onChange() {} },
  });
  assert.match(m.pageText(), /Light Mode/);
});

test('new profiles default to dark, not the unknown arctic', () => {
  const sql = readFileSync(`${root}supabase/migrations/20260929220000_profiles_theme_default_dark.sql`, 'utf8');
  assert.match(sql, /alter table public\.profiles alter column theme set default 'dark'/i);
  assert.doesNotMatch(sql, /^\s*(begin|commit);/im);
  const rollback = readFileSync(`${root}docs/rollback/20260929220000_profiles_theme_default_dark.rollback.sql`, 'utf8');
  assert.match(rollback, /set default 'arctic'/i);
});
