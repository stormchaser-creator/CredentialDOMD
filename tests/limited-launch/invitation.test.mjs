import test from 'node:test';
import assert from 'node:assert/strict';
import { captureLaunchInvitation, readLaunchInvitation, clearLaunchInvitation } from '../../src/utils/launchInvitation.js';

const syntheticToken = 'synthetic_only_launch_token_A1b2c3d4e5f6g7h8j9k0';
function browser(hash = `#launch_invite=${syntheticToken}`) {
  const values = new Map(), events = [];
  const location = { pathname: '/app/', search: '?view=membership', hash };
  const state = { syntheticHistory: true };
  return {
    location, events, values,
    history: {
      state,
      replaceState(next, title, url) {
        events.push(['replace', url]);
        assert.equal(next, state);
        assert.equal(title, '');
        location.hash = new URL(url, 'https://app.invalid').hash;
      },
    },
    storage: {
      getItem: key => values.get(key) ?? null,
      setItem(key, value) { events.push(['store']); values.set(key, value); },
      removeItem: key => { values.delete(key); },
    },
  };
}

test('capture immediately removes the fragment token before storing it in the current tab', () => {
  const context = browser();
  assert.equal(captureLaunchInvitation(context), syntheticToken);
  assert.equal(context.location.hash, '');
  assert.deepEqual(context.events, [['replace', '/app/?view=membership'], ['store']]);
  assert.equal(readLaunchInvitation(context), syntheticToken);
  // A second mount after Clerk sign-in recovers only the tab's pending token.
  assert.equal(captureLaunchInvitation(context), syntheticToken);
  const anotherTab = browser('');
  assert.equal(readLaunchInvitation(anotherTab), null);
});

test('capture preserves unrelated URL parameters and history state', () => {
  const context = browser(`#tab=membership&launch_invite=${syntheticToken}&from=welcome`);
  assert.equal(captureLaunchInvitation(context), syntheticToken);
  assert.equal(context.location.hash, '#tab=membership&from=welcome');
  assert.equal(context.events[0][1], '/app/?view=membership#tab=membership&from=welcome');
});

test('malformed, empty, duplicate, oversized and off-route tokens are scrubbed without retaining an older token', () => {
  for (const fragment of [
    '#launch_invite=', '#launch_invite=short',
    `#launch_invite=${'a'.repeat(42)}`, `#launch_invite=${'a'.repeat(129)}`,
    `#launch_invite=${syntheticToken}%0A`,
    `#launch_invite=${syntheticToken}%2F`,
    `#launch_invite=${syntheticToken}&launch_invite=${syntheticToken}`,
  ]) {
    const context = browser();
    captureLaunchInvitation(context);
    context.location.hash = fragment;
    assert.equal(captureLaunchInvitation(context), null);
    assert.equal(context.location.hash, '');
    assert.equal(readLaunchInvitation(context), null);
  }
  const offRoute = browser(); offRoute.location.pathname = '/other/';
  assert.equal(captureLaunchInvitation(offRoute), null);
  assert.equal(offRoute.location.hash, '');
  assert.equal(readLaunchInvitation(offRoute), null);
});

test('clear removes only the pending invitation and corrupted stored values are rejected', () => {
  const context = browser();
  context.values.set('unrelated', 'keep');
  captureLaunchInvitation(context);
  const key = [...context.values.keys()].find(k => k !== 'unrelated');
  context.values.set(key, '<invalid stored token>');
  assert.equal(readLaunchInvitation(context), null);
  assert.equal(context.values.has(key), false);
  context.location.hash = `#launch_invite=${syntheticToken}`;
  captureLaunchInvitation(context);
  clearLaunchInvitation(context);
  assert.equal(readLaunchInvitation(context), null);
  assert.equal(context.values.get('unrelated'), 'keep');
});

test('unavailable storage still permits URL scrubbing and fails without exposing a token', () => {
  for (const storage of [null, {
    getItem() { throw Error('blocked'); },
    setItem() { throw Error('blocked'); },
    removeItem() { throw Error('blocked'); },
  }]) {
    const context = { ...browser(), storage };
    assert.equal(captureLaunchInvitation(context), null);
    assert.equal(context.location.hash, '');
    assert.equal(readLaunchInvitation(context), null);
    assert.doesNotThrow(() => clearLaunchInvitation(context));
  }
});

test('history failure rejects capture and clears any previously saved invitation', () => {
  const context = browser();
  captureLaunchInvitation(context);
  context.location.hash = `#launch_invite=${syntheticToken}`;
  context.history.replaceState = () => { throw Error('blocked'); };
  assert.equal(captureLaunchInvitation(context), null);
  assert.equal(readLaunchInvitation(context), null);
});

test('only the fragment key is captured; query parameters are never used as invitation tokens', () => {
  const context = browser('');
  context.location.search = `?launch_invite=${syntheticToken}`;
  assert.equal(captureLaunchInvitation(context), null);
  assert.deepEqual(context.events, []);
});
