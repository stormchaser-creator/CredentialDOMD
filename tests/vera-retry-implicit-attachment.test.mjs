// Try again on a follow-up never saves the earlier document a second time
// (VERA-001, VERA-002). A follow-up with no new file sends the last one to
// Vera as an implicit attachment, which is never saved to Files. When that
// send failed, failedMapRef kept the implicit file, and Try again treated it
// as newly attached: approving the reply's card saved the same PDF to
// Documents again, and assistant_log called the turn a document.
// Synthetic files only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mountVera } from './assistant-harness.mjs';
import { settle } from './component-harness.mjs';

const licenseCard = { kind: 'create_record', section: 'licenses', fields: { type: 'State Medical License', state: 'ZZ', licenseNumber: 'SYN-1' }, summary: 'Add the license' };
const deaCard = { kind: 'create_record', section: 'licenses', fields: { type: 'DEA Registration', state: 'ZZ', licenseNumber: 'SYN-2' }, summary: 'Add the DEA' };

test('a follow-up retried after a failed send still sends the file to Vera, and Approve does not save it again', async () => {
  let n = 0;
  const logged = [];
  const supabase = { from: () => ({ insert: (row) => { logged.push(row); return { then: (a) => a({}) }; } }) };
  const v = await mountVera({
    modules: { supabase: { supabase } },
    turn: async () => {
      n += 1;
      if (n === 1) return { reply: 'Here is the license.', actions: [licenseCard] };
      if (n === 2) throw new Error('Network request failed');
      return { reply: 'Here is the DEA.', actions: [deaCard] };
    },
  });
  await v.pick(v.fileInputs()[0], [new File(['%PDF synthetic'], 'license.pdf', { type: 'application/pdf' })]);
  await v.ask('add this license');
  await v.button('Approve').props.onClick();
  await settle();
  v.render();
  const docs = () => v.rec.of('addItem').filter(c => c[1] === 'documents');
  assert.equal(docs().length, 1, 'the attached PDF is saved once');

  await v.ask('also add the DEA on that page');
  assert.equal(v.turns[1].attachment?.implicit, true, 'the follow-up re-sends the file implicitly');
  const retry = v.buttons().find(b => v.text(b) === 'Try again');
  assert.ok(retry, 'the failed follow-up offers Try again');
  await retry.props.onClick();
  await settle();
  v.render();
  assert.ok(v.turns[2].attachment?.dataUrl, 'the retry still lets Vera read the page');
  await v.button('Approve').props.onClick();
  await settle();
  v.render();
  assert.equal(v.rec.of('addItem').filter(c => c[1] === 'licenses').length, 2, 'both records are added');
  assert.equal(docs().length, 1, 'the PDF is not saved to Documents a second time');
  assert.deepEqual(logged.map(r => r.kind), ['document', 'chat'], 'the retried follow-up is logged as chat');
});
