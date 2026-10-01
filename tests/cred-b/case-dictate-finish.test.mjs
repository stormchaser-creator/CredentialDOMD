// CRED-036: "Done, build the case" built from the finalised phrases only, so
// the phrase still being heard (often the facility, date or complication) was
// dropped. And when the browser ended recognition after a silence, the panel
// with Done vanished and the mic that came back cleared what was said.
// Synthetic only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { mountComponent, settle } from '../component-harness.mjs';

function speech() {
  const made = [];
  class FakeRecognition { constructor() { made.push(this); this.stopped = 0; } start() {} stop() { this.stopped++; } }
  return { made, FakeRecognition };
}
const result = (...parts) => ({ results: parts.map(([t, isFinal]) => Object.assign([{ transcript: t }], { isFinal })) });

async function mount() {
  const { made, FakeRecognition } = speech();
  const parsed = [], drafts = [];
  const ui = await mountComponent('src/components/features/CaseDictate.jsx', {
    app: { data: { settings: {} }, theme: {} },
    props: { categories: [], onDraft: d => drafts.push(d) },
    modules: { caseDictation: { parseCaseDictation: async (w) => { parsed.push(w); return { title: w }; } } },
    globals: { window: { navigator: {}, SpeechRecognition: FakeRecognition } },
  });
  const button = (re) => ui.nodes().find(n => n.type === 'button' && re.test(ui.text(n)));
  return { ui, made, parsed, drafts, button };
}

test('Done builds from the final phrases and the one still being heard', async () => {
  const { ui, made, parsed, button } = await mount();
  button(/Dictate a case/).props.onClick();
  ui.render();
  made[0].onresult(result([' right craniotomy for subdural hematoma', true], [' at Synthetic General today, no complications', false]));
  ui.render();
  await button(/Done, build the case/).props.onClick();
  await settle();
  assert.equal(parsed.length, 1);
  assert.match(parsed[0], /^right craniotomy for subdural hematoma\s+at Synthetic General today, no complications$/, 'nothing dropped');
});

test('when recognition ends on its own, the words and Done stay', async () => {
  const { ui, made, parsed, button } = await mount();
  button(/Dictate a case/).props.onClick();
  ui.render();
  made[0].onresult(result(['left carpal tunnel release', true]));
  made[0].onend();
  ui.render();
  assert.ok(ui.pageText().includes('left carpal tunnel release'), ui.pageText());
  assert.ok(!button(/Dictate a case/), 'no fresh mic that would clear the words');
  await button(/Done, build the case/).props.onClick();
  await settle();
  assert.deepEqual(parsed, ['left carpal tunnel release']);
});

test('Cancel clears, and a result the browser hands over after stop does not bring it back', async () => {
  const { ui, made, button } = await mount();
  button(/Dictate a case/).props.onClick();
  ui.render();
  made[0].onresult(result(['synthetic words', false]));
  ui.render();
  button(/^Cancel$/).props.onClick();
  assert.equal(made[0].stopped, 1);
  // The browser delivers the last final through whatever handler is set now.
  made[0].onresult?.(result(['synthetic words', true]));
  ui.render();
  assert.ok(button(/Dictate a case/), 'the mic is back');
});

test('the work log dictation reads finals plus the phrase being heard, and keeps a stopped transcript', async () => {
  const src = await readFile(new URL('../../src/components/features/locum/WorkLog.jsx', import.meta.url), 'utf8');
  assert.match(src, /dictTextRef\.current = \(finals \+ " " \+ interim\)\.trim\(\);/);
  assert.match(src, /\{dictating \|\| \(dictTranscript && !dictBusy\) \? \(/);
  assert.match(src, /rec\.onresult = null;/);
});
