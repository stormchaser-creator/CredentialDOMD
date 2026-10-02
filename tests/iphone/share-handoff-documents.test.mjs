// SHARE-004 on the installed iPhone app (QA lab, WebKit + the iOS model,
// 2 of 2 runs): Documents > Select to send > tick 2 > Send as one packet >
// Mail. The share sheet's promise never settles once Mail takes over, so no
// Send history row was written, no "Sent" message showed, and the screen
// stayed in Select with both ticked; a second tap then said "Sharing failed.
// Try fewer or smaller files." although the files had gone.
// Synthetic records only.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as inboxDocs from '../../src/utils/inboxDocs.js';
import * as docLabel from '../../src/utils/docLabel.js';
import * as paused from '../../src/utils/pausedApplicationRecords.js';
import * as credentialTypes from '../../src/constants/credentialTypes.js';
import * as helpers from '../../src/utils/helpers.js';
import * as guard from '../../src/utils/spreadsheetGuard.js';
import * as phiGuard from '../../src/utils/phiGuard.js';
import * as customCategories from '../../src/utils/customCategories.js';
import * as officeText from '../../src/utils/officeText.js';
import * as receiptFiles from '../../src/utils/receiptFiles.js';
import * as shareText from '../../src/utils/shareText.js';
import * as shareHandoff from '../../src/utils/shareHandoff.js';
import { mountComponent, settle } from '../component-harness.mjs';

const base = { size: 2048, uploadedAt: '2026-09-01T10:00:00Z', type: 'application/pdf' };
const DOCS = [
  { ...base, id: 'd-1', name: 'Synthetic license.pdf', data: 'data:application/pdf;base64,JVBERi0=' },
  { ...base, id: 'd-2', name: 'Synthetic DEA.pdf', data: 'data:application/pdf;base64,JVBERi0=' },
];
const abort = name => Object.assign(new Error(name), { name });

async function documents(share) {
  const added = [], deleted = [], shared = [];
  const app = {
    data: { settings: { degreeType: 'MD', name: 'Dana Synthetic' }, documents: DOCS, licenses: [], privileges: [], insurance: [], cme: [], healthRecords: [], education: [], locumContracts: [], travelExpenses: [], deductibles: [], customCategories: [], customRecords: [], screenings: [], shareLog: [] },
    theme: {}, userIdRef: { current: 'user_synthetic' }, addItem: (key, item) => added.push({ key, item }), editItem() {}, deleteItem: (key, id) => deleted.push({ key, id }), setData() {}, updateSettings() {}, navigate() {},
  };
  const ui = await mountComponent('src/components/features/DocumentsSection.jsx', {
    app,
    globals: { navigator: { userAgent: 'Synthetic iPhone', onLine: true, clipboard: { writeText: async () => {} }, canShare: ({ files }) => files?.length > 0, share: p => { shared.push(p); return share(p); } } },
    modules: {
      inboxDocs, docLabel, pausedApplicationRecords: paused, credentialTypes, helpers, spreadsheetGuard: guard, phiGuard, customCategories, receiptFiles, shareText, shareHandoff,
      storageQuota: { checkStorageQuota: () => ({ ok: true }) },
      officeText: { isOfficeFile: () => false, UPLOAD_ACCEPT: '*', extractOfficeText: async () => '', mimeFromName: officeText.mimeFromName },
      aiClient: { useAiAvailable: () => true, describeAiStatus: () => 'AI is off.' },
      docPrefill: { isReadableDoc: () => true, contractFromScan: e => ({ entry: e }) },
      useInputStyle: { useInputStyle: () => ({ width: '100%', fontSize: 16 }) },
      supabase: { supabase: null, uploadDocumentFile: async () => null, downloadDocumentBlob: async () => null },
    },
  });
  const button = label => ui.nodes().find(n => n.type === 'button' && (typeof label === 'string' ? ui.text(n).trim() === label : label.test(ui.text(n))));
  const tick = async id => { ui.nodes().find(n => n.key === id && typeof n.props.onClick === 'function').props.onClick(); ui.render(); await settle(); ui.render(); };
  button('Select to send').props.onClick(); ui.render();
  await tick('d-1'); await tick('d-2');
  return { ui, added, deleted, shared, button, tick };
}

test('a share sheet that never answers: the packet is recorded, said, and Select ends as the files go', async () => {
  const h = await documents(() => new Promise(() => {}));
  void h.button(/as one packet$/).props.onClick();
  await settle(); h.ui.render();
  assert.equal(h.shared.length, 1, 'the files went to the share sheet');
  assert.deepEqual(h.added.map(a => [a.key, a.item.itemName, a.item.method]), [['shareLog', 'Packet (2 documents)', 'share']]);
  assert.match(h.ui.pageText(), /Sent 2 documents as one packet\./);
  assert.equal(h.button(/as one packet$/), undefined, 'no Send left on offer to tap twice');
  assert.ok(h.button('Select to send'), 'back out of Select');
});

test('a cancelled share takes the record back and leaves both ticked to send again', async () => {
  const h = await documents(async () => { throw abort('AbortError'); });
  await h.button(/as one packet$/).props.onClick();
  await settle(); h.ui.render();
  assert.equal(h.added.length, 1);
  assert.deepEqual(h.deleted, [{ key: 'shareLog', id: h.added[0].item.id }]);
  assert.doesNotMatch(h.ui.pageText(), /Sent 2 documents/);
  assert.ok(h.button(/Send 2 documents as one packet$/), 'still in Select, both ticked');
});

test('a share refused because another is still open is said as that, never as files too large', async () => {
  const h = await documents(async () => { throw abort('InvalidStateError'); });
  await h.button(/as one packet$/).props.onClick();
  await settle(); h.ui.render();
  const text = h.ui.pageText();
  assert.match(text, /A share sheet is still open\. Finish or close it in the other app, then send again\./);
  assert.doesNotMatch(text, /fewer or smaller files/);
  assert.deepEqual(h.deleted.map(d => d.key), ['shareLog'], 'this attempt did not go: its record is taken back');
});
