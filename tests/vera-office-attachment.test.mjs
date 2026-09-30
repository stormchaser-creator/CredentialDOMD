// A Word or Excel file attached to Vera is kept in Documents and linked to
// the record the physician approves (VERA-002). The Office branch turned the
// file into its text alone, so approving create_record made the record with
// no document and the original file was gone. The bytes must NOT ride as
// attachment.dataUrl: assistant.js routes on that, and an Office binary sent
// as inline data would fail every turn. Synthetic files only.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as officeText from '../src/utils/officeText.js';
import * as phiGuard from '../src/utils/phiGuard.js';
import { mountVera } from './assistant-harness.mjs';
import { settle } from './component-harness.mjs';

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const office = (text) => ({ ...officeText, extractOfficeText: async () => text });

async function attachAndApprove({ file, text }) {
  const v = await mountVera({
    modules: { officeText: office(text), phiGuard },
    turn: async () => ({ reply: 'Here is the record.', actions: [{ kind: 'create_record', section: 'education', fields: { type: 'Certificate', name: 'Synthetic Course Certificate' }, summary: 'Add the certificate' }] }),
  });
  const input = v.nodes().find(n => n.type === 'input' && n.props.type === 'file');
  await input.props.onChange({ target: { files: [file], value: '' } });
  await settle();
  v.render();
  await v.ask('add this certificate');
  const approve = v.button('Approve');
  assert.ok(approve, 'an Approve button');
  await approve.props.onClick();
  await settle();
  return v;
}

test('an approved record from an attached Word file keeps the file, linked to the record', async () => {
  const v = await attachAndApprove({ file: new File(['synthetic docx bytes'], 'certificate.docx', { type: DOCX }), text: 'Certificate of completion. Synthetic Course.' });
  const turn = v.turns[0];
  assert.ok(turn.attachment?.text, 'Vera read the words');
  assert.ok(!turn.attachment?.dataUrl, 'the bytes do not ride as dataUrl (no Gemini inline data)');
  const adds = v.rec.of('addItem');
  const record = adds.find(c => c[1] === 'education');
  const doc = adds.find(c => c[1] === 'documents');
  assert.ok(record, 'the record is added');
  assert.ok(doc, 'the file is saved to Documents');
  assert.equal(doc[2].linkedTo, `education:${record[2].id}`);
  assert.equal(doc[2].name, 'certificate.docx');
  assert.equal(doc[2].type, DOCX);
});

test('a Word file with no type from the picker is stored with the type its name says', async () => {
  const v = await attachAndApprove({ file: new File(['synthetic docx bytes'], 'certificate.docx', { type: '' }), text: 'Certificate of completion. Synthetic Course.' });
  const doc = v.rec.of('addItem').find(c => c[1] === 'documents');
  assert.equal(doc[2].type, DOCX);
  assert.ok(doc[2].data.startsWith(`data:${DOCX};base64,`));
});

test('a Word file that reads as a patient chart is never stored', async () => {
  const v = await attachAndApprove({ file: new File(['synthetic'], 'note.docx', { type: DOCX }), text: 'Operative note. Medical record number 000000. Discharge summary.' });
  assert.ok(!v.rec.of('addItem').some(c => c[1] === 'documents'));
});
