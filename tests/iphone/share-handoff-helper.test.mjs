// The rule every share in the app now follows (src/utils/shareHandoff.js):
// record at hand-off, take back only when the sheet says it did not go. The
// iPhone app's share sheet often never answers once Mail takes over (QA lab,
// WebKit + the iOS model; the owner's invoice twice on 2026-09-30).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { shareAtHandoff, shareNotStartedMessage, watchShareUnanswered } from '../../src/utils/shareHandoff.js';
import { READ_ONLY_AFTER_CHECK_MESSAGE, alertWriteRefused, holdForAccess, membershipWriteError } from '../../src/utils/limitedLaunchAccess.js';

const named = name => Object.assign(new Error(name), { name });
const settle = async () => { for (let i = 0; i < 10; i++) await new Promise(r => setImmediate(r)); };

test('hand-off runs as the sheet is asked for, in the same task; a sheet that never answers leaves the record standing', async () => {
  const order = [];
  let resolved = false;
  shareAtHandoff({ text: 'x' }, {
    share: () => { order.push('share'); return new Promise(() => {}); },
    onHanded: () => order.push('handed'),
    onUndo: () => order.push('undo'),
  }).then(() => { resolved = true; });
  // Both before shareAtHandoff yields: the record is written inside the tap.
  assert.deepEqual(order, ['share', 'handed']);
  await settle();
  assert.deepEqual(order, ['share', 'handed']);
  assert.equal(resolved, false);
});

// Link audit, 2026-10-01: onHanded writes the share log, and a write the
// membership refuses (read-only, the identity wait) alerts at once. With
// onHanded first, that alert came inside the tap before navigator.share was
// called: "can't save" for a send not yet made, and a slow dismissal spent
// the tap's permission, so the sheet did not open.
test('a refused share-log write never alerts before the sheet is asked for', async () => {
  const order = [];
  const outcome = await shareAtHandoff({ text: 'x' }, {
    share: async () => { order.push('share'); },
    onHanded: () => { order.push('alert: cannot save'); },
  });
  assert.equal(outcome, 'shared');
  assert.deepEqual(order, ['share', 'alert: cannot save']);
});

// Review of 68f6333a: onHanded after navigator.share still alerted in the
// same task. During the identity wait (writes suspended) the share-log
// addItem is refused and alertWriteRefused called window.alert while the
// sheet was being presented, and said "can't save" for a send he might then
// cancel. The alert now waits for the sheet's answer, or for him to be back
// in front with the sheet silent, and is forgotten when the send did not go.
const readOnly = { enabled: true, state: () => ({ needsRefresh: false }) };
let clock = 1e12;
const refuseInside = () => alertWriteRefused({ authority: readOnly, scope: 'credential', section: 'shareLog', now: () => (clock += 10000) });
const withWindowAlert = async (fn) => {
  const had = Object.prototype.hasOwnProperty.call(globalThis, 'window'), was = globalThis.window;
  const shown = [];
  globalThis.window = { alert: m => shown.push(m) };
  try { return await fn(shown); } finally { if (had) globalThis.window = was; else delete globalThis.window; }
};

test('a refused share-log write never alerts inside the hand-off; it is said once the sheet answers that it went', async () => {
  await withWindowAlert(async (shown) => {
    let answer;
    const order = [];
    const done = shareAtHandoff({ text: 'x' }, {
      share: () => { order.push('share'); return new Promise(r => { answer = r; }); },
      onHanded: () => { order.push('handed'); refuseInside(); },
      watch: () => () => {},
    });
    // shareAtHandoff has not yielded yet: still the tap's own task.
    assert.deepEqual(order, ['share', 'handed']);
    assert.deepEqual(shown, [], 'no window.alert in the same task as navigator.share');
    await settle();
    assert.deepEqual(shown, [], 'nor while the sheet is open');
    answer();
    assert.equal(await done, 'shared');
    assert.deepEqual(shown, [membershipWriteError().message], 'said once, after the sheet');
  });
});

test('a refused share-log write for a send he cancelled is never said', async () => {
  await withWindowAlert(async (shown) => {
    for (const err of ['AbortError', 'InvalidStateError', 'NotAllowedError']) {
      const outcome = await shareAtHandoff({ text: 'x' }, {
        share: async () => { throw named(err); },
        onHanded: refuseInside,
        // Taking back the refused row is refused as well (deleteItem alerts).
        onUndo: refuseInside,
        watch: () => () => {},
      });
      assert.notEqual(outcome, 'shared');
    }
    assert.deepEqual(shown, []);
    // Nothing held is left catching later refusals: an ordinary one alerts at once.
    refuseInside();
    assert.equal(shown.length, 1);
  });
});

test('a sheet that never answers: the refusal is said once he is back in front', async () => {
  await withWindowAlert(async (shown) => {
    const watchers = [];
    shareAtHandoff({ text: 'x' }, {
      share: () => new Promise(() => {}),
      onHanded: refuseInside,
      watch: (fn) => { watchers.push(fn); return () => {}; },
    });
    assert.deepEqual(shown, []);
    assert.equal(watchers.length, 1, 'watched for his return to the front');
    watchers[0]();
    assert.deepEqual(shown, [membershipWriteError().message]);
  });
  // No refusal: the return to the front says nothing.
  await withWindowAlert(async (shown) => {
    const watchers = [];
    shareAtHandoff({ text: 'x' }, { share: () => new Promise(() => {}), onHanded: () => {}, watch: (fn) => { watchers.push(fn); return () => {}; } });
    assert.equal(watchers.length, 1);
    watchers[0]();
    assert.deepEqual(shown, []);
  });
});

// Review of 27a0d491 (1): the held alert was told on the watcher's plain
// 45 s timeout. Mail's compose sheet over the installed app leaves the page
// visible (no visibilitychange), so after 45 s of writing window.alert came
// over the sheet, and a cancel then had nothing left to drop. The real
// watcher, with its timings shortened; the page never leaves the front.
const visiblePage = () => {
  const listeners = {};
  return { listeners, doc: { visibilityState: 'visible', addEventListener: (t, f) => { listeners[t] = f; }, removeEventListener: (t) => { delete listeners[t]; } } };
};

test('a held refusal is not said on a timeout while the sheet stays open on a visible page, nor after he cancels', async () => {
  await withWindowAlert(async (shown) => {
    const { doc } = visiblePage();
    let cancel;
    let unanswered = 0;
    const done = shareAtHandoff({ text: 'x' }, {
      share: () => new Promise((_, reject) => { cancel = () => reject(named('AbortError')); }),
      onHanded: refuseInside,
      onUnanswered: () => { unanswered++; },
      watch: (fn, opts) => watchShareUnanswered(fn, { graceMs: 5, waitMs: 20, ...opts, doc, win: null }),
    });
    await new Promise(r => setTimeout(r, 80));
    assert.equal(unanswered, 1, 'the screen\'s own long wait still runs');
    assert.deepEqual(shown, [], 'no alert over the compose sheet past the wait');
    cancel();
    assert.equal(await done, 'cancelled');
    await new Promise(r => setTimeout(r, 30));
    assert.deepEqual(shown, [], 'nothing said for a send that did not happen');
  });
});

test('a held refusal is said when he is back in front, through the real watcher', async () => {
  await withWindowAlert(async (shown) => {
    const { doc, listeners } = visiblePage();
    shareAtHandoff({ text: 'x' }, {
      share: () => new Promise(() => {}),
      onHanded: refuseInside,
      watch: (fn, opts) => watchShareUnanswered(fn, { graceMs: 5, waitMs: 20, ...opts, doc, win: null }),
    });
    await new Promise(r => setTimeout(r, 40));
    assert.deepEqual(shown, []);
    doc.visibilityState = 'hidden'; listeners.visibilitychange();
    doc.visibilityState = 'visible'; listeners.visibilitychange();
    await new Promise(r => setTimeout(r, 20));
    assert.deepEqual(shown, [membershipWriteError().message]);
  });
});

test('waitMs Infinity: only a return to the front fires it', async () => {
  const { doc, listeners } = visiblePage();
  let fired = 0;
  const stop = watchShareUnanswered(() => { fired++; }, { graceMs: 5, waitMs: Infinity, doc, win: null });
  await new Promise(r => setTimeout(r, 30));
  assert.equal(fired, 0);
  doc.visibilityState = 'visible'; listeners.visibilitychange();
  await new Promise(r => setTimeout(r, 20));
  assert.equal(fired, 1);
  stop();
});

// Review of 27a0d491 (2): only refusals made inside onHanded were held. A
// share log met by an answer that is only old (back from minutes in Mail) is
// kept while the check runs (holdForAccess); when the server then answers
// read-only, the round took the log back and called window.alert itself,
// over the sheet and before he chose Send or Cancel. Now the round's alert
// goes to the hold that was open when the log was written.
const checkedLater = () => {
  let answer;
  let status = { status: 'verify', reason: 'stale' };
  const authority = {
    enabled: true,
    verify: () => new Promise(r => { answer = r; }),
    statusFor: () => status,
    serves: () => true,
  };
  return { authority, refuse: () => { status = { status: 'refuse', reason: 'read_only' }; answer(Date.now()); } };
};
const logLater = (authority, undone) => () => holdForAccess({ scopes: ['credential'], accountId: 'user_synthetic', section: 'shareLog', undo: () => undone.push('shareLog') }, authority);

test('a share log the check refuses while the sheet is open is taken back but not said until the sheet answers that it went', async () => {
  await withWindowAlert(async (shown) => {
    const { authority, refuse } = checkedLater();
    const undone = [];
    let answer;
    const done = shareAtHandoff({ text: 'x' }, { share: () => new Promise(r => { answer = r; }), onHanded: logLater(authority, undone), watch: () => () => {} });
    refuse();
    await settle();
    assert.deepEqual(undone, ['shareLog'], 'the read-only answer still takes the log back');
    assert.deepEqual(shown, [], 'no alert over the sheet');
    answer();
    assert.equal(await done, 'shared');
    assert.deepEqual(shown, [READ_ONLY_AFTER_CHECK_MESSAGE]);
  });
});

test('a share log the check refuses while the sheet is open is said once he is back in front', async () => {
  await withWindowAlert(async (shown) => {
    const { authority, refuse } = checkedLater();
    const watchers = [];
    shareAtHandoff({ text: 'x' }, { share: () => new Promise(() => {}), onHanded: logLater(authority, []), watch: (fn) => { watchers.push(fn); return () => {}; } });
    refuse();
    await settle();
    assert.deepEqual(shown, []);
    watchers[0]();
    assert.deepEqual(shown, [READ_ONLY_AFTER_CHECK_MESSAGE]);
  });
});

test('a share log the check refuses is never said for a send he cancelled, before or after the answer', async () => {
  await withWindowAlert(async (shown) => {
    for (const cancelFirst of [false, true]) {
      const { authority, refuse } = checkedLater();
      let cancel;
      const done = shareAtHandoff({ text: 'x' }, { share: () => new Promise((_, reject) => { cancel = () => reject(named('AbortError')); }), onHanded: logLater(authority, []), watch: () => () => {} });
      if (cancelFirst) { cancel(); assert.equal(await done, 'cancelled'); refuse(); await settle(); }
      else { refuse(); await settle(); cancel(); assert.equal(await done, 'cancelled'); }
    }
    assert.deepEqual(shown, []);
  });
});

test('a share log the check refuses after the sheet answered is said at once; an ordinary save is never held', async () => {
  await withWindowAlert(async (shown) => {
    const { authority, refuse } = checkedLater();
    assert.equal(await shareAtHandoff({ text: 'x' }, { share: async () => {}, onHanded: logLater(authority, []), watch: () => () => {} }), 'shared');
    refuse();
    await settle();
    assert.deepEqual(shown, [READ_ONLY_AFTER_CHECK_MESSAGE]);
  });
  await withWindowAlert(async (shown) => {
    const { authority, refuse } = checkedLater();
    shareAtHandoff({ text: 'x' }, { share: () => new Promise(() => {}), onHanded: () => {}, watch: () => () => {} });
    logLater(authority, [])();
    refuse();
    await settle();
    assert.deepEqual(shown, [READ_ONLY_AFTER_CHECK_MESSAGE], 'saved outside any hand-off: said as before');
  });
});

test('a share that throws at once is still handed and then taken back', async () => {
  const order = [];
  const outcome = await shareAtHandoff({}, {
    share: () => { throw named('NotAllowedError'); },
    onHanded: () => order.push('handed'),
    onUndo: o => order.push(`undo ${o}`),
  });
  assert.equal(outcome, 'blocked');
  assert.deepEqual(order, ['handed', 'undo blocked']);
});

test('each answer: shared keeps it, the others take it back and say why', async () => {
  for (const [err, outcome] of [[null, 'shared'], [named('AbortError'), 'cancelled'], [named('InvalidStateError'), 'busy'], [named('NotAllowedError'), 'blocked'], [named('DataError'), 'failed']]) {
    const undone = [];
    const got = await shareAtHandoff({}, { share: async () => { if (err) throw err; }, onUndo: o => undone.push(o) });
    assert.equal(got, outcome);
    assert.deepEqual(undone, err ? [outcome] : []);
  }
  assert.match(shareNotStartedMessage('busy'), /still open/);
  assert.doesNotMatch(shareNotStartedMessage('busy'), /smaller/);
  assert.equal(shareNotStartedMessage('cancelled'), null);
  assert.equal(shareNotStartedMessage('shared'), null);
  assert.equal(shareNotStartedMessage('failed', 'Screen words.'), 'Screen words.');
});

test('unanswered: once the page is back in front and the sheet is still silent', async () => {
  const listeners = {};
  const doc = { visibilityState: 'hidden', addEventListener: (t, f) => { listeners[t] = f; }, removeEventListener: (t) => { delete listeners[t]; } };
  let fired = 0;
  const stop = watchShareUnanswered(() => { fired++; }, { graceMs: 5, waitMs: 10000, doc, win: null });
  doc.visibilityState = 'visible'; listeners.visibilitychange();
  await new Promise(r => setTimeout(r, 20));
  assert.equal(fired, 1);
  assert.equal(listeners.visibilitychange, undefined, 'stops listening once fired');
  stop();
});

test('every share in the app goes through it: Documents, Send sheet, Vera, CME and Home transcripts, peer references', () => {
  const files = {
    'src/components/features/DocumentsSection.jsx': 1, 'src/components/features/ShareModal.jsx': 1,
    'src/components/features/AssistantSection.jsx': 1, 'src/utils/cmeTranscriptPdf.js': 1, 'src/App.jsx': 1,
  };
  for (const [file, n] of Object.entries(files)) {
    const src = readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');
    assert.ok((src.match(/await shareAtHandoff\(/g) || []).length >= n, `${file} hands off`);
  }
  const app = readFileSync(new URL('../../src/App.jsx', import.meta.url), 'utf8');
  const refs = app.slice(app.indexOf('const shareManyReferences = useCallback'), app.indexOf('const linkedDocs = useMemo'));
  assert.match(refs, /onHanded: \(\) => \{ logId = logRefs\("share"\); \}/, 'CRED-043: logged as the list goes');
  assert.doesNotMatch(refs, /await navigator\.share/);
});
