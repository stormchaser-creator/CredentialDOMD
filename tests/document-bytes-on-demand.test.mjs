// 2026-10-02, the owner's iPhone: every stored file was held in memory from
// load (hundreds of MB) and iOS discarded the page in Gmail mid-share. A
// screen now asks for the bytes of the stored files it shows, and only those
// (useDocumentBytes, AppContext requestDocumentBytes). Synthetic files only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadScreens, mount } from './harness/component-harness.mjs';

const S = await loadScreens('import useDocumentBytes from "./src/components/shared/useDocumentBytes.js"; export function Probe({ docs }) { useDocumentBytes(docs); return null; }');

test('a screen asks for the stored files it shows, once, and not for one only this device holds', () => {
  const asked = [];
  const docs = [
    { id: 'doc-b', storagePath: 'user_synthetic/doc-b' },
    { id: 'doc-a', storagePath: 'user_synthetic/doc-a' },
    { id: 'doc-local', data: 'data:text/plain;base64,YQ==' },
  ];
  const m = mount(S.Probe, { props: { docs } });
  Object.assign(globalThis.__screen.app, { requestDocumentBytes: (ids) => asked.push(ids), releaseDocumentBytes: () => {} });
  m.render(); m.render();
  assert.deepEqual(asked, [['doc-a', 'doc-b']]);
});
