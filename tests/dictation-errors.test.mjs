// A dictation that fails says why (VERA-009). Every mic button set only
// "listening = false" on an error, so a denied microphone or the iOS
// home-screen app's service-not-allowed turned the button back with no
// message and no transcript. Synthetic only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dictationErrorText } from '../src/utils/dictationErrors.js';
import { mountVera } from './assistant-harness.mjs';

test('each speech error the browsers report has a next step; a stop the user made has none', () => {
  for (const code of ['not-allowed', 'service-not-allowed', 'audio-capture', 'network', 'no-speech']) {
    const m = dictationErrorText(code);
    assert.ok(m.length > 10, code);
    assert.ok(!m.includes('\u2014'), `${code}: no em dash`);
  }
  assert.equal(dictationErrorText('aborted'), '');
  assert.equal(dictationErrorText(undefined), '');
});

function speech() {
  const made = [];
  class FakeRecognition { constructor() { made.push(this); } start() { if (FakeRecognition.throwOnStart) throw Object.assign(new Error('recognition has already started'), { name: 'InvalidStateError' }); } stop() {} }
  return { made, FakeRecognition };
}

async function vera(SR) {
  return mountVera({ globals: { window: { navigator: {}, matchMedia: () => ({ matches: false }), confirm: () => true, addEventListener() {}, removeEventListener() {}, innerHeight: 800, SpeechRecognition: SR } } });
}
const mic = v => v.buttons().find(b => v.text(b) === '🎤');

test('Vera says a denied microphone was denied, and says nothing when the user stops', async () => {
  const { made, FakeRecognition } = speech();
  const v = await vera(FakeRecognition);
  mic(v).props.onClick();
  v.render();
  made[0].onerror({ error: 'not-allowed' });
  v.render();
  assert.ok(v.pageText().includes(dictationErrorText('not-allowed')), v.pageText());
  const w = await vera(FakeRecognition);
  mic(w).props.onClick();
  made.at(-1).onerror({ error: 'aborted' });
  w.render();
  assert.ok(!w.pageText().includes('Microphone'), 'no error for a stop');
});

test('a start the browser refuses is shown, not thrown', async () => {
  const { FakeRecognition } = speech();
  FakeRecognition.throwOnStart = true;
  const v = await vera(FakeRecognition);
  mic(v).props.onClick();
  v.render();
  assert.ok(v.pageText().includes('Dictation could not start'), v.pageText());
});

test('every other mic in the app reads the error the same way', async () => {
  for (const f of ['src/components/features/CaseDictate.jsx', 'src/components/features/locum/WorkLog.jsx', 'src/components/shared/DictateButton.jsx', 'src/components/features/locum/RVULog.jsx']) {
    const src = await readFile(new URL(`../${f}`, import.meta.url), 'utf8');
    assert.match(src, /dictationErrorText\(ev\??\.error\)/, f);
  }
});
