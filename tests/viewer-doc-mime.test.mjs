// A requester's attachment linked to a record keeps its sentinel type
// "request-attachment-inbox" (the request's own view finds it by that), so
// every record viewer must read the MIME type through docMime, never
// doc.type (INTAKE-003). Read as a MIME type, the sentinel lost the
// thumbnail and opened View as a Blob of type "request-attachment-inbox".
// Synthetic records only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as inboxDocs from '../src/utils/inboxDocs.js';
import * as helpers from '../src/utils/helpers.js';
import * as credentialTypes from '../src/constants/credentialTypes.js';
import { mountComponent } from './component-harness.mjs';

const PNG = 'data:image/png;base64,iVBORw0KGgo=';
const attachment = { id: 'doc-r', name: 'badge.png', type: 'request-attachment-inbox', mimeType: 'image/png', data: PNG };

test('linking keeps the sentinel, and docMime still reads the image', () => {
  assert.deepEqual(inboxDocs.leaveInbox(attachment), {}, 'the request view still finds it');
  assert.equal(inboxDocs.docMime({ ...attachment, linkedTo: 'screenings:scr-1' }), 'image/png');
});

test('a screening shows a linked requester image as an image', async () => {
  const ui = await mountComponent('src/components/features/ScreeningsSection.jsx', {
    app: { data: { screenings: [{ id: 'scr-1', type: 'Background Check', components: [] }], documents: [{ ...attachment, linkedTo: 'screenings:scr-1' }], settings: {} }, theme: {}, addItem() {}, editItem() {}, deleteItem() {}, toggleFavorite() {} },
    props: { onShare() {}, autoViewId: 'scr-1', onAutoViewDone() {} },
    modules: { helpers, credentialTypes, inboxDocs },
  });
  assert.ok(ui.nodes().some(n => n.type === 'img' && n.props.src === PNG), 'the image is shown');
});

test('no record viewer reads doc.type as a MIME type', async () => {
  const files = ['src/components/features/CrudSection.jsx', 'src/components/features/HealthRecordsSection.jsx', 'src/components/features/locum/Contracts.jsx',
    'src/components/features/locum/ContractSummary.jsx', 'src/components/features/ScreeningsSection.jsx', 'src/components/features/CMESection.jsx'];
  for (const f of files) {
    const src = await readFile(new URL(`../${f}`, import.meta.url), 'utf8');
    assert.doesNotMatch(src, /doc\.type\?\.(startsWith|includes)\(/, `${f}: an image or PDF test on doc.type`);
    assert.doesNotMatch(src, /new Blob\(\[arr\], \{ type: doc\.type/, `${f}: a Blob typed with doc.type`);
    assert.match(src, /docMime\(doc\)/, f);
  }
});
