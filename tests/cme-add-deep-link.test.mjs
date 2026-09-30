// SETTINGS-012: Setup > CME > 'Add one by hand' set autoAdd {sec:'cme',
// returnTo: setup} and navigated to Credentials > CME, but App rendered
// <CMESection onShare/> without crudTarget('cme') and CMESection took only
// onShare: the member landed on the CME list with no form open, no way back
// to Setup, and autoAdd stayed set.
//
// The real CMESection through the component harness; synthetic account.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { mountComponent } from './component-harness.mjs';

const src = rel => new URL(`../src/${rel}`, import.meta.url).href;
async function cme(props) {
  const app = { data: { settings: { degreeType: 'MD' }, cme: [], documents: [], licenses: [] }, addItem: () => true, editItem: () => true, deleteItem() {},
    theme: {}, allTrackedStates: [], navigate() {}, isDesktop: false, toggleFavorite() {} };
  return mountComponent('src/components/features/CMESection.jsx', { app, props, modules: {
    useForwardingAddresses: { useForwardingAddresses: () => ({ rows: [] }) },
    forwardingAddresses: await import(src('utils/forwardingAddresses.js')),
    credentialTypes: await import(src('constants/credentialTypes.js')),
    cmeTopics: await import(src('constants/cmeTopics.js')),
    stateRequirements: await import(src('constants/stateRequirements.js')),
    boardRequirements: await import(src('constants/boardRequirements.js')),
    states: await import(src('constants/states.js')),
    useInputStyle: { useInputStyle: () => ({}) },
  } });
}
const formModal = c => c.nodes().find(n => n.props?.title === 'Add CME' || n.props?.title === 'Edit CME');

test('arriving from Setup opens the add form once and reports it', async () => {
  const calls = [];
  const c = await cme({ onShare() {}, autoOpen: true, onAutoOpenDone: () => calls.push('open-done'), onAutoEditClosed: () => calls.push('closed') });
  assert.equal(formModal(c)?.props.open, true, 'the CME add form is open');
  assert.deepEqual(calls, ['open-done'], 'the deep link is consumed, so autoAdd does not stay set');
  formModal(c).props.onClose();
  c.render();
  assert.equal(formModal(c).props.open, false);
  assert.deepEqual(calls, ['open-done', 'closed'], 'closing takes the member back to Setup');
});

test('opened by hand, closing the form goes nowhere', async () => {
  const calls = [];
  const c = await cme({ onShare() {}, onAutoEditClosed: () => calls.push('closed') });
  assert.equal(formModal(c)?.props.open, false);
  assert.deepEqual(calls, []);
});

test('App hands the CME section its deep-link props', async () => {
  const app = await readFile(new URL('../src/App.jsx', import.meta.url), 'utf8');
  assert.match(app, /<CMESection onShare=\{openShare\} \{\.\.\.crudTarget\("cme"\)\} \/>/);
});
