// SETTINGS-001: on a phone, Setup's "…" row menu button was about 26x21px,
// its choices (Do it now, Skip for now, Does not apply to me, Put it back)
// about 31px tall, and the drawer's "Skip for now" and "Does not apply to
// me" underlined links 16px tall with 14px between them. They are Setup's
// only skip and does-not-apply controls, tapped by every physician finishing
// onboarding. The QA lab holds a phone control to 32px.
//
// The real SetupPage, TaskRow and MenuBtn through the component harness; a
// control passes when its own inline style guarantees the size (height or
// min-height, width or min-width of 32px or more). Synthetic account.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mountComponent } from './component-harness.mjs';
import * as setupTasks from '../src/utils/setupTasks.js';
import * as states from '../src/constants/states.js';

const MIN = 32;
const data = { settings: { name: 'Synthetic Physician', degreeType: 'DO', primaryState: 'CA' }, licenses: [] };
const size = (b, axis) => Math.max(Number(b.props.style?.[axis]) || 0, Number(b.props.style?.[`min${axis[0].toUpperCase()}${axis.slice(1)}`]) || 0);

async function mount(exportName, props, { narration = null } = {}) {
  const setup = setupTasks.buildSetup(data, {});
  return mountComponent('src/components/features/SetupPage.jsx', {
    app: { data, theme: {}, isDesktop: false }, exportName, props: props?.(setup) ?? {},
    modules: { setupTasks, states, useSetupState: { useSetupState: () => ({ setup, skip() {}, markNa() {}, restore() {}, declare() {}, narration, ackNarration() {} }) } },
  });
}

test('the "…" menu button on a Setup row is at least 32x32', async () => {
  const setup = setupTasks.buildSetup(data, {});
  const task = setup.tier1.find(t => t.status === 'pending');
  assert.ok(task, 'a pending Tier 1 task');
  const row = await mount('TaskRow', () => ({ task, open: false, onToggle() {}, onSkip() {}, onNa() {}, onRestore() {}, T: {} }));
  const more = row.nodes().find(n => n.type === 'button' && n.props['aria-label'] === `More for ${task.label}`);
  assert.ok(more, 'the row has its "…" button');
  assert.ok(size(more, 'height') >= MIN && size(more, 'width') >= MIN, `"…" is ${size(more, 'width')}x${size(more, 'height')}`);
  // Opening it shows the choices, each a MenuBtn.
  more.props.onClick();
  const choices = row.nodes().filter(n => n.type?.name === 'MenuBtn').map(n => row.text(n));
  assert.deepEqual(choices, ['Do it now', 'Skip for now', 'Does not apply to me']);
});

test('each choice in the row menu is at least 32px tall', async () => {
  const btn = await mount('MenuBtn', () => ({ T: {}, onClick() {}, children: 'Does not apply to me' }));
  const b = btn.nodes().find(n => n.type === 'button');
  assert.ok(size(b, 'height') >= MIN, `MenuBtn is ${size(b, 'height')}px tall`);
});

test('the open drawer\'s "Skip for now" and "Does not apply to me" are at least 32px tall', async () => {
  const page = await mount('default', () => ({ initialTask: 'licenses' }));
  page.render();
  const buttons = page.nodes().filter(n => n.type === 'button');
  for (const label of ['Skip for now', 'Does not apply to me']) {
    const b = buttons.find(n => page.text(n) === label);
    assert.ok(b, `the drawer offers "${label}"`);
    assert.ok(size(b, 'height') >= MIN, `${label}: ${size(b, 'height')}px tall`);
  }
});

// The final lab run: the Tier 2 "Packet ready  n items · n done ›" header,
// the button that opens the whole packet, had padding 0 and measured 343x19
// at 375 wide and 358x19 at 390. The same screen's other bare text buttons
// (the CV and DEA drawers' "I would rather..." / "I do not hold..." and the
// narration's "Got it") had the same padding-0 style.
test('the "Packet ready" header that opens the packet is at least 32px tall', async () => {
  const page = await mount('default');
  page.render();
  const header = page.nodes().find(n => n.type === 'button' && page.text(n).startsWith('Packet ready'));
  assert.ok(header, 'the Tier 2 header is a button');
  assert.match(page.text(header), /\d+ items · \d+ done/);
  assert.ok(size(header, 'height') >= MIN, `Packet ready header is ${size(header, 'height')}px tall`);
});

test('the CV and DEA drawers\' way out, and the narration\'s "Got it", are at least 32px tall', async () => {
  for (const [drawer, label] of [['CvDrawer', 'I would rather type it in'], ['DeaDrawer', 'I do not hold a DEA registration']]) {
    const page = await mount(drawer, () => ({ onDeclareNone() {} }));
    const b = page.nodes().find(n => n.type === 'button' && page.text(n) === label);
    assert.ok(b, `${drawer} offers "${label}"`);
    assert.ok(size(b, 'height') >= MIN, `${label}: ${size(b, 'height')}px tall`);
  }
  const page = await mount('default', null, { narration: 'Synthetic narration: your licence is on file.' });
  page.render();
  const got = page.nodes().find(n => n.type === 'button' && page.text(n) === 'Got it');
  assert.ok(got, 'the narration row has its "Got it"');
  assert.ok(size(got, 'height') >= MIN, `Got it: ${size(got, 'height')}px tall`);
});
